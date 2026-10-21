// scripts/daily-digest.js
// Roz ek NAYA quantum computing paper OpenAlex se uthata hai, Gemini se summary banata hai,
// aur articles.json me sabse upar jodta hai.
//
// Purani script ki dikkat: sirf top-1 paper uthati thi, wo pehle se logged ho to us din kuch nahi judta tha.
// Ab: 50-50 ke kai pages dekhti hai aur pehla aisa paper chunti hai jo pehle kabhi log nahi hua.

const fs = require('fs');
const path = require('path');

const ARTICLES_PATH = path.join(__dirname, '..', 'articles.json');
const MAX_PAGES = 4; // 4 x 50 = 200 papers tak dhoondhega

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// OpenAlex abstract "inverted index" me deta hai (word -> positions). Wapas plain text banata hai.
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

function linkOf(w) {
  return w.doi || (w.primary_location && w.primary_location.landing_page_url) || '';
}

async function fetchPage(page) {
  const today = new Date().toISOString().slice(0, 10); // future-dated papers ko bahar rakhta hai
  const url =
    'https://api.openalex.org/works?filter=title.search:quantum%20computing,to_publication_date:' + today +
    '&sort=publication_date:desc&per-page=50&page=' + page +
    '&mailto=quantumdigest.bot@gmail.com';

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'quantum-digest-bot/1.0' } });
      console.log('OpenAlex page', page, 'attempt', attempt + 1, 'status:', res.status);
      if (res.status === 200) {
        const data = await res.json();
        return data.results || [];
      }
    } catch (e) {
      console.log('OpenAlex fetch error:', e.message);
    }
    if (attempt === 0) await sleep(10000);
  }
  return null; // source unavailable
}

// Pehla aisa paper jo abhi tak log nahi hua
async function fetchNewPaper(seen) {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const results = await fetchPage(page);
    if (results === null) return null;
    if (results.length === 0) break;

    const fresh = results.filter(w => {
      if (!w.abstract_inverted_index || !w.title) return false;
      const l = linkOf(w);
      if (!l || seen.links.has(l)) return false;
      if (seen.titles.has(w.title.trim().toLowerCase())) return false;
      return true;
    });

    if (fresh.length > 0) {
      const paper = fresh[0];
      console.log('Naya paper page', page, 'par mila.');
      return {
        title: paper.title.trim(),
        abstract: reconstructAbstract(paper.abstract_inverted_index),
        link: linkOf(paper)
      };
    }
    console.log('Page', page, 'ke sab papers pehle se logged, agla page...');
  }
  return null;
}

// Gemini: pehle PURANA model (jo pehle se chal raha tha). Wo fail ho tabhi agle models try honge.
function geminiModels() {
  const list = [process.env.GEMINI_MODEL || 'gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-3.5-flash-lite'];
  return [...new Set(list)];
}

async function callGemini(model, prompt) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + process.env.GEMINI_API_KEY;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.candidates || !data.candidates[0]) {
    console.log('Gemini model', model, 'fail. HTTP', res.status, JSON.stringify(data).slice(0, 200));
    return null;
  }
  const raw = data.candidates[0].content.parts[0].text.replace(/```json|```/g, '').trim();
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.summary) return parsed;
  } catch (e) { /* neeche fallback */ }
  return { summary: raw, tag: 'quantum' };
}

async function summarizeWithGemini(paper) {
  const prompt = `Summarize this quantum computing paper in 2 plain-language sentences for a general tech audience, no jargon. Also give ONE short lowercase tag (2-3 words, e.g. "error correction", "algorithms", "hardware").\n\nTitle: ${paper.title}\n\nAbstract: ${paper.abstract}\n\nRespond ONLY as JSON, no markdown formatting: {"summary": "...", "tag": "..."}`;

  if (process.env.GEMINI_API_KEY) {
    for (const model of geminiModels()) {
      try {
        const out = await callGemini(model, prompt);
        if (out) {
          console.log('Gemini summary mili, model:', model);
          return out;
        }
      } catch (e) {
        console.log('Gemini model', model, 'error:', e.message);
      }
    }
  } else {
    console.log('GEMINI_API_KEY set nahi hai.');
  }
  console.log('Gemini se summary nahi mili, abstract ka shuruaati hissa use hoga.');
  return { summary: paper.abstract.slice(0, 200), tag: 'quantum' };
}

async function main() {
  let articles = [];
  if (fs.existsSync(ARTICLES_PATH)) {
    const raw = fs.readFileSync(ARTICLES_PATH, 'utf-8').trim();
    articles = raw ? JSON.parse(raw) : [];
  }
  const seen = {
    links: new Set(articles.map(a => a.link)),
    titles: new Set(articles.map(a => (a.title || '').trim().toLowerCase()))
  };

  const paper = await fetchNewPaper(seen);
  if (!paper) {
    console.log('Aaj koi naya paper nahi mila / source unavailable. Agli scheduled run me dobara try hoga.');
    return;
  }
  console.log('Fetched NEW paper:', paper.title);

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
