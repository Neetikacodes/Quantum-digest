// scripts/daily-digest.js
// Fetches the latest quant-ph paper from arXiv, summarizes it with Claude,
// and prepends it to articles.json in the repo root.

const fs = require('fs');
const path = require('path');

const ARTICLES_PATH = path.join(__dirname, '..', 'articles.json');

async function fetchLatestPaper() {
  const url = 'http://export.arxiv.org/api/query?search_query=cat:quant-ph&sortBy=submittedDate&sortOrder=descending&start=0&max_results=1';
  const res = await fetch(url);
  const xml = await res.text();

  const title = (xml.match(/<title>([\s\S]*?)<\/title>/g) || [])[1] || '';
  const summaryMatch = xml.match(/<summary>([\s\S]*?)<\/summary>/);
  const linkMatch = xml.match(/<id>(http:\/\/arxiv\.org\/abs\/[^<]+)<\/id>/);

  return {
    title: title.replace(/<\/?title>/g, '').replace(/\s+/g, ' ').trim(),
    abstract: (summaryMatch ? summaryMatch[1] : '').replace(/\s+/g, ' ').trim(),
    link: linkMatch ? linkMatch[1] : ''
  };
}

async function summarizeWithClaude(paper) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Summarize this quantum computing paper in 2 plain-language sentences for a general tech audience, no jargon. Also give ONE short lowercase tag (2-3 words, e.g. "error correction", "algorithms", "hardware").\n\nTitle: ${paper.title}\n\nAbstract: ${paper.abstract}\n\nRespond ONLY as JSON: {"summary": "...", "tag": "..."}`
      }]
    })
  });
  const data = await res.json();
  const raw = data.content[0].text.replace(/```json|```/g, '').trim();
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

  let articles = [];
  if (fs.existsSync(ARTICLES_PATH)) {
    articles = JSON.parse(fs.readFileSync(ARTICLES_PATH, 'utf-8'));
  }

  const alreadyExists = articles.some(a => a.link === paper.link);
  if (alreadyExists) {
    console.log('Paper already logged, skipping.');
    return;
  }

  const ai = await summarizeWithClaude(paper);

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
