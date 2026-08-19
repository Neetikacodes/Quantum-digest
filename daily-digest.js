// scripts/daily-digest.js
// Fetches the latest quant-ph paper from arXiv, summarizes it with Gemini,
// and prepends it to articles.json in the repo root.

const fs = require('fs');
const path = require('path');

const ARTICLES_PATH = path.join(__dirname, '..', 'articles.json');

async function fetchLatestPaper() {
  const url = 'https://export.arxiv.org/api/query?search_query=cat:quant-ph&sortBy=submittedDate&sortOrder=descending&start=0&max_results=1';
  const res = await fetch(url, {
    headers: { 'User-Agent': 'quantum-digest-bot/1.0 (github actions)' }
  });

  console.log('arXiv response status:', res.status);
  const xml = await res.text();
  console.log('arXiv response length:', xml.length);
  console.log('arXiv response preview:', xml.slice(0, 400));

  const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/);
  if (!entryMatch) {
    console.log('No <entry> tag found in response.');
    return { title: '', abstract: '', link: '' };
  }
  const entryXml = entryMatch[1];

  const titleMatch = entryXml.match(/<title>([\s\S]*?)<\/title>/);
  const summaryMatch = entryXml.match(/<summary>([\s\S]*?)<\/summary>/);
  const linkMatch = entryXml.match(/<id>(http:\/\/arxiv\.org\/abs\/[^<]+)<\/id>/);

  return {
    title: titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '',
    abstract: summaryMatch ? summaryMatch[1].replace(/\s+/g, ' ').trim() : '',
    link: linkMatch ? linkMatch[1].trim() : ''
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
