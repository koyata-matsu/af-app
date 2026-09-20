// Vercel サーバーレス関数（/api/chat）
// ブラウザから直接 Anthropic API を呼ばないのは、APIキーが画面のコードに
// 見えてしまうと誰でも使えてしまい、料金が勝手にかかる恐れがあるため。
// ここ（サーバー側）だけにキーを置き、ブラウザはこの関数を経由して質問する。

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

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        // 精度が大事な用途なので既定はSonnet。費用を抑えたい場合は
        // 'claude-haiku-4-5-20251001' に変更できる（README参照）。
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        system,
        messages
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

    const text = (data.content && data.content[0] && data.content[0].text) || '';
    res.status(200).json({ text });
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: String(err && err.message ? err.message : err) });
  }
}
