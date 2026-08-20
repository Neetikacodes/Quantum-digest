// scripts/daily-digest.js
// Fetches the latest quantum computing paper via OpenAlex (no signup/key needed),
// summarizes it with Gemini, and prepends it to articles.json.

const fs = require('fs');
const path = require('path');

const ARTICLES_PATH = path.join(__dirname, '..', 'articles.json');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// OpenAlex returns abstracts as an "inverted index" (word -> positions).
// This rebuilds the plain-text abstract from that structure.
function reconstructAbstract(invertedIndex) {
  if (!invertedIndex) return '';
  const positions = [];
  for (const word in invertedIndex) {
    for (const pos of invertedIndex[word]) {
      positions[pos] = word;
    }
  }
  return positions.join(' ').replace(/\s+/g, ' ').trim();
}

async function tryFetchOpenAlex() {
  const url = 'https://api.openalex.org/works?filter=title.search:quantum%20computing&sort=publication_date:desc&per-page=10&mailto=quantumdigest.bot@gmail.com';

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'quantum-digest-bot/1.0' } });
    console.log('OpenAlex attempt', attempt + 1, 'status:', res.status);
    if (res.status === 200) {
      const data = await res.json();
      const results = data.results || [];
      const withAbstract = results.filter(w => w.abstract_inverted_index && w.title);
      if (withAbstract.length > 0) {
        const paper = withAbstract[0];
        const link = paper.doi || (paper.primary_location && paper.primary_location.landing_page_url) || '';
        return {
          title: paper.title.trim(),
          abstract: reconstructAbstract(paper.abstract_inverted_index),
          link
        };
      }
      console.log('No results with abstracts found.');
    }
    if (attempt === 0) await sleep(10000);
  }
  return null;
}

async function fetchLatestPaper() {
  const paper = await tryFetchOpenAlex();
  if (paper) {
    console.log('Got paper from OpenAlex.');
    return paper;
  }
  return null;
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
  if (!paper) {
    console.log('Source unavailable right now, skipping this run. Will try again next scheduled run.');
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
