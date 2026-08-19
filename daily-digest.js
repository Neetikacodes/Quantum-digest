// scripts/daily-digest.js
// Fetches the latest quantum computing paper via Semantic Scholar,
// summarizes it with Gemini, and prepends it to articles.json.

const fs = require('fs');
const path = require('path');

const ARTICLES_PATH = path.join(__dirname, '..', 'articles.json');

async function fetchLatestPaper() {
  const url = 'https://api.semanticscholar.org/graph/v1/paper/search?query=quantum+computing&fields=title,abstract,url,publicationDate,externalIds&sort=publicationDate:desc&limit=5';

  const res = await fetch(url, {
    headers: { 'User-Agent': 'quantum-digest-bot/1.0' }
  });

  console.log('Semantic Scholar response status:', res.status);

  if (res.status !== 200) {
    const text = await res.text();
    console.log('Response body:', text.slice(0, 300));
    return { title: '', abstract: '', link: '' };
  }

  const data = await res.json();
  const papers = (data.data || []).filter(p => p.abstract && p.title);

  if (papers.length === 0) {
    console.log('No usable papers in response.');
    return { title: '', abstract: '', link: '' };
  }

  const paper = papers[0];
  const arxivId = paper.externalIds && paper.externalIds.ArXiv;
  const link = arxivId ? `https://arxiv.org/abs/${arxivId}` : paper.url;

  return {
    title: paper.title.trim(),
    abstract: paper.abstract.replace(/\s+/g, ' ').trim(),
    link: link || ''
  };
}

async function summarizeWithGemini(paper) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + process.env.GEMINI_API_KEY;

  const prompt = `Summarize this quantum computing paper in 2 plain-language sentences for a general tech audience, no jargon. Also give ONE short lowercase tag (2-3 words, e.g. "error correction", "algorithms", "hardware").\n\nTitle: ${paper.title}\n\nAbstract: ${paper.abstract}\n\nRespond ONLY as JSON, no markdown formatting: {"summary": "...", "tag": "..."}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }]
    })
  });
  const data = await res.json();

  if (!data.candidates || !data.candidates[0]) {
    console.log('Gemini response did not contain candidates:', JSON.stringify(data));
    return { summary: paper.abstract.slice(0, 200), tag: 'quantum' };
  }

  const raw = data.candidates[0].content.parts[0].text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(raw);
  } catch (e) {
    return { summary: raw, tag: 'quantum' };
  }
}

async function main() {
  const paper = await fetchLatestPaper();
  if (!paper.title) {
    console.log('No paper found, skipping.');
    return;
  }
  console.log('Fetched paper:', paper.title);

  let articles = [];
  if (fs.existsSync(ARTICLES_PATH)) {
    const raw = fs.readFileSync(ARTICLES_PATH, 'utf-8').trim();
    articles = raw ? JSON.parse(raw) : [];
  }

  const alreadyExists = articles.some(a => a.link === paper.link);
  if (alreadyExists) {
    console.log('Paper already logged, skipping.');
    return;
  }

  const ai = await summarizeWithGemini(paper);

  const entry = {
    id: 'e' + Date.now(),
    title: paper.title,
    summary: ai.summary,
    tag: ai.tag,
    link: paper.link,
    date: new Date().toISOString()
  };

  articles.unshift(entry);
  fs.writeFileSync(ARTICLES_PATH, JSON.stringify(articles, null, 2));
  console.log('Added entry:', entry.title);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
