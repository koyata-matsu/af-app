// PubMed（米国立医学図書館が提供する、世界最大級の医学論文データベース）を
// 検索するための小さなヘルパー。NCBIが無料で公開している「eutils」という
// 公式の窓口を使う。追加の契約やAPIキーは不要。

const EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const TOOL_NAME = 'af-mondouchou';
const CONTACT_EMAIL = 'noreply@example.com'; // 運用者の連絡先。差し替えても可。

// query: 英語の検索キーワード（例: "apixaban renal impairment atrial fibrillation"）
// 戻り値: [{pmid, title, journal, year, authors, url}, ...]
export async function searchPubmed(query, maxResults = 5) {
  if (!query || !query.trim()) return [];

  // 1) キーワードに合う論文のID（PMID）を探す
  const search = new URL(EUTILS_BASE + '/esearch.fcgi');
  search.searchParams.set('db', 'pubmed');
  search.searchParams.set('retmode', 'json');
  search.searchParams.set('term', query);
  search.searchParams.set('retmax', String(maxResults));
  search.searchParams.set('sort', 'relevance');
  search.searchParams.set('tool', TOOL_NAME);
  search.searchParams.set('email', CONTACT_EMAIL);

  const searchRes = await fetch(search.toString());
  if (!searchRes.ok) throw new Error('PubMed検索に失敗しました（esearch, status ' + searchRes.status + '）');
  const searchData = await searchRes.json();
  const ids = (searchData.esearchresult && searchData.esearchresult.idlist) || [];
  if (ids.length === 0) return [];

  // 2) 見つかったIDから、タイトル・雑誌名・年などの詳細を取ってくる
  const summary = new URL(EUTILS_BASE + '/esummary.fcgi');
  summary.searchParams.set('db', 'pubmed');
  summary.searchParams.set('retmode', 'json');
  summary.searchParams.set('id', ids.join(','));
  summary.searchParams.set('tool', TOOL_NAME);
  summary.searchParams.set('email', CONTACT_EMAIL);

  const summaryRes = await fetch(summary.toString());
  if (!summaryRes.ok) throw new Error('PubMed検索に失敗しました（esummary, status ' + summaryRes.status + '）');
  const summaryData = await summaryRes.json();
  const result = summaryData.result || {};

  return ids
    .filter(function (id) { return result[id]; })
    .map(function (id) {
      const item = result[id];
      const authors = (item.authors || [])
        .slice(0, 3)
        .map(function (a) { return a.name; })
        .join(', ');
      return {
        pmid: id,
        title: item.title || '(タイトル不明)',
        journal: item.fulljournalname || item.source || '',
        year: (item.pubdate || '').slice(0, 4),
        authors: authors,
        url: 'https://pubmed.ncbi.nlm.nih.gov/' + id + '/'
      };
    });
}
