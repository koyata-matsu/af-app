// Vercel サーバーレス関数（/api/chat）
// ブラウザから直接 Anthropic API を呼ばないのは、APIキーが画面のコードに
// 見えてしまうと誰でも使えてしまい、料金が勝手にかかる恐れがあるため。
// ここ（サーバー側）だけにキーを置き、ブラウザはこの関数を経由して質問する。
//
// ハイブリッド方式：
// まずは渡されたノート（自分で選んだ資料）の範囲で答えさせる。
// ノートに載っていない場合だけ、AI自身の判断で PubMed（実際の医学論文）を
// 検索させ、その結果を根拠に答えさせる。ノート優先・PubMedは補助、という
// 優先順位はシステムプロンプト（HYBRID_INSTRUCTIONS）で明示している。

import { searchPubmed } from './lib/pubmed.js';

// Vercelの実行時間の上限を少し延ばす（PubMed検索を挟むと1往復では終わらないため）
export const config = { maxDuration: 30 };

const MODEL = 'claude-sonnet-5';
const MAX_TOOL_ROUNDS = 3; // AIが検索を繰り返しすぎて時間・費用がかさまないための上限

const PUBMED_TOOL = {
  name: 'search_pubmed',
  description:
    '手元のノートに載っていない医学的な質問について、PubMed（実際の医学論文データベース）を検索する。' +
    '日本語の質問はそのまま渡さず、英語の検索キーワードに変換してから渡すこと。',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '英語の検索キーワード（例: "apixaban renal impairment atrial fibrillation"）'
      }
    },
    required: ['query']
  }
};

const HYBRID_INSTRUCTIONS = [
  '',
  '=== PubMed検索の使い方（ノート優先・ハイブリッド方式） ===',
  '1. まず、渡されたノートの範囲で答えられないか確認する。ノートで答えられるなら search_pubmed は使わず、',
  '   これまで通りノートの出典（例: 出典: AF-01 (p.42)）だけで答える。',
  '2. ノートに載っていない、またはノートだけでは不十分な医学的な質問には、search_pubmed ツールを使って',
  '   実際の論文を探してよい。',
  '3. search_pubmed の結果を使って答える場合は、回答の最後に',
  '   「出典: PubMed PMID <番号> — <タイトル>（<雑誌名>, <年>）」の形式で明記する（ノートの出典行とは別に書く）。',
  '4. PubMedでも該当する情報が見つからない場合は、推測で埋めず、',
  '   正直に「ノートにもPubMedでも該当する情報が見つかりませんでした」と答える。',
  '5. ノート由来の情報とPubMed由来の情報を混同しない。出典表記で必ずどちらか区別できるようにする。',
  '',
  '=== PubMed回答の型（「〜について教えて」のような疾患解説の質問の場合） ===',
  '相手は救急医で、勤務中の短い合間に読む。教科書のような網羅的な箇条書き（概要・原因・症状・診断・治療…と',
  '全部並べる形式）は避け、臨床判断にそのまま使える順番で書く。次の構成に従うこと：',
  '  a) 冒頭1〜2文で「これは何か」「なぜ今この患者で重要か」を要約する。',
  '  b) 「可能性が高い」：典型的な患者像・頻度の高い所見・最有力の診断（pretest probabilityの考え方）。',
  '  c) 「見逃してはいけない」：緊急性が高く見逃すと危険な合併症・鑑別（レッドフラグ、なぜ危険かも一言添える）。',
  '  d) 「他に考えられる」：頻度は低いが鑑別に挙がるもの（免疫不全・渡航歴・特殊背景があれば浮上するもの）。',
  '  e) 「次にすべきこと」：優先すべき検査・初期対応・コンサルトの目安を、具体的な行動として書く',
  '     （例: 血液培養2セット、造影MRI、神経症状があれば緊急コンサルトなど）。',
  '単純な数値・用量・可否の一問一答（例: 「CCr 20でDOACは使える？」）には、この型を強制しない。',
  '素直に結論から簡潔に答えること。',
  '出典は、本文中で論文名や結論を長々と引用しすぎず、要点の裏付けとして簡潔に使う。',
  'PMID・タイトル・雑誌名・年の一覧は、これまで通り回答の最後にまとめて書く。'
].join('\n');

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed', message: 'POSTだけ受け付けます' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: 'server_not_configured',
      message: 'サーバーに ANTHROPIC_API_KEY が設定されていません（Vercelの環境変数を確認してください）'
    });
    return;
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    res.status(400).json({ error: 'bad_request', message: 'リクエストの形式が正しくありません' });
    return;
  }

  const { system, messages } = body || {};
  if (!system || !Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'bad_request', message: 'system と messages が必要です' });
    return;
  }

  const fullSystem = system + '\n' + HYBRID_INSTRUCTIONS;
  // 内部でのツール往復用に、渡された会話履歴のコピーを作る（フロント側の履歴は汚さない）
  const workingMessages = messages.map(function (m) { return { role: m.role, content: m.content }; });
  const pubmedUsed = [];

  try {
    let finalText = '';

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 2048,
          system: fullSystem,
          messages: workingMessages,
          tools: [PUBMED_TOOL]
        })
      });

      const data = await upstream.json();

      if (!upstream.ok) {
        res.status(upstream.status).json({
          error: 'upstream_error',
          message: (data && data.error && data.error.message) || 'AIサーバーでエラーが起きました',
          detail: data
        });
        return;
      }

      const content = Array.isArray(data.content) ? data.content : [];

      // 本文（type: "text"）のブロックを、先頭決め打ちではなく type で探す
      const textBlock = content.find(function (b) {
        return b && b.type === 'text' && typeof b.text === 'string';
      });
      if (textBlock) finalText = textBlock.text;

      const toolUses = content.filter(function (b) { return b && b.type === 'tool_use'; });

      if (data.stop_reason !== 'tool_use' || toolUses.length === 0 || round === MAX_TOOL_ROUNDS) {
        break;
      }

      // AIが「PubMedを検索したい」と言ってきたターンを履歴に追加
      workingMessages.push({ role: 'assistant', content: content });

      // 依頼された検索を実行し、結果をAIに返す
      const toolResults = [];
      for (const tu of toolUses) {
        let resultText;
        try {
          const query = (tu.input && tu.input.query) || '';
          const papers = await searchPubmed(query, 5);
          pubmedUsed.push.apply(pubmedUsed, papers);
          resultText = papers.length ? JSON.stringify(papers) : '該当する論文が見つかりませんでした。';
        } catch (e) {
          resultText = 'PubMed検索でエラーが起きました: ' + String(e && e.message ? e.message : e);
        }
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: resultText });
      }
      workingMessages.push({ role: 'user', content: toolResults });
    }

    res.status(200).json({ text: finalText, pubmed: pubmedUsed });
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: String(err && err.message ? err.message : err) });
  }
}
