const express = require('express');
const fetch = require('node-fetch');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
const upload = multer({ dest: 'uploads/' });
app.use(express.json());

// Serve uploaded files (development only). Ensure uploads directory exists.
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  try { fs.mkdirSync(uploadsDir); } catch (e) { console.warn('Could not create uploads directory', e); }
}
app.use('/uploads', express.static(uploadsDir));

const PORT = process.env.PORT || 4000;

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Helper: safe fetch
async function safeFetch(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { return text; }
}

// Simple persistent cache on disk
const CACHE_FILE = path.join(__dirname, 'cache.json');
let CACHE = { news: [], jobs: [], weatherSnapshots: {} };
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf8');
      CACHE = JSON.parse(raw);
    }
  } catch (e) { console.warn('Failed to load cache', e); }
}
function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(CACHE, null, 2));
  } catch (e) { console.warn('Failed to save cache', e); }
}

// Fetch current weather from OpenWeatherMap
async function fetchWeather(lat, lon) {
  const OWM_KEY = process.env.OPENWEATHERMAP_KEY || '';
  if (!OWM_KEY) throw new Error('No OpenWeatherMap API key configured');
  const url = `https://api.openweathermap.org/data/2.5/weather?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&units=metric&appid=${encodeURIComponent(OWM_KEY)}`;
  const w = await safeFetch(url);
  return w;
}

function normalizeUrl(u) {
  try {
    const urlObj = new URL(u);
    return `${urlObj.protocol}//${urlObj.hostname}${urlObj.pathname}`.replace(/\/$/, '');
  } catch (e) {
    return u;
  }
}

function makeStableId(item) {
  // prefer normalized url
  if (item.url) return normalizeUrl(String(item.url));
  // fallback to a short base64 of title+source
  const key = `${item.title || ''}|${item.source || ''}`;
  return 't:' + Buffer.from(key).toString('base64').replace(/=+$/, '').slice(0, 12);
}

// Aggregate news: try NewsAPI + Google RSS (rss2json proxy) and combine
async function fetchNewsOnce() {
  const results = [];
  const NEWSAPI_KEY = process.env.NEWSAPI_KEY;
  try {
    if (NEWSAPI_KEY) {
      const url = `https://newsapi.org/v2/top-headlines?language=en&pageSize=50&apiKey=${NEWSAPI_KEY}`;
      const j = await safeFetch(url);
      if (j && j.articles) {
        j.articles.forEach(a => {
          const rawId = a.url || a.link || a.source?.id || a.title;
          const id = rawId ? normalizeUrl(String(rawId)) : String(a.title || '').slice(0, 120);
          results.push({ source: 'newsapi', id, title: a.title, url: a.url, publishedAt: a.publishedAt, description: a.description || a.content || '', raw: a });
        });
      }
    }
  } catch (e) { console.warn('NewsAPI fetch error', e); }

  try {
    const rssUrl = `https://news.google.com/rss`;
    const rss = await safeFetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}`);
    if (rss && rss.items) rss.items.forEach(i => {
      const rawId = i.link || i.title;
      const id = rawId ? normalizeUrl(String(rawId)) : String(i.title || '').slice(0, 120);
      results.push({ source: 'googlerss', id, title: i.title, url: i.link, publishedAt: i.pubDate, description: i.description || i.content || '', raw: i });
    });
  } catch (e) { console.warn('Google RSS failed', e); }

  const out = [];
  const seen = new Set();
  // stronger filterKeywords and heuristics
  const filterKeywords = ['traffic', 'accident', 'road closed', 'road closure', 'roadworks', 'weather', 'storm', 'rain warning', 'flood', 'traffic update', 'breaking traffic', 'travel advisory', 'road blocked', 'major incident', 'minor crash'];
  for (const rawItem of results) {
    const it = Object.assign({}, rawItem);
    // ensure stable id
    it.id = makeStableId(it);
    if (!it.id) continue;
    const titleLower = (it.title || '').toLowerCase();
    const descLower = (it.description || '').toLowerCase();
    const matchesKeyword = filterKeywords.some(k => titleLower.includes(k) || descLower.includes(k));
    // Exclude Google Alert style items
    const fromAlert = (it.raw && it.raw.link && String(it.raw.link).includes('news.google.com/alerts')) || (it.url && String(it.url).includes('news.google.com/alerts'));
    // If it matches traffic/weather keywords or is from alerts, exclude it entirely
    if (matchesKeyword || fromAlert) continue;
    // Also exclude items that start with 'weather' or 'traffic' (e.g., "Weather: Light showers tonight")
    if (/^(weather|traffic)[:\-\s]/i.test(it.title || '')) continue;
    // Additional guard: if source is googlerss and description is very short and title contains punctuation like ':' or ' - ' (likely an alert), exclude
    if ((it.source === 'googlerss' || (it.raw && it.raw.source)) && ((it.description || '').length < 80 || (it.title || '').length < 20)) continue;
    // skip very short titles
    if ((it.title || '').length < 12) continue;
    if (!seen.has(it.id)) { seen.add(it.id); out.push(it); }
  }
  // sort by publishedAt desc where possible
  out.sort((a, b) => {
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return tb - ta;
  });
  return out.slice(0, 200);
}

// Fetch jobs (Google CSE / RapidAPI / Adzuna / Remotive / mock)
async function fetchJobsOnce(locationStr) {
  const results = [];
  const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID;
  const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY;
  const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
  const RAPIDAPI_ENDPOINT = process.env.RAPIDAPI_ENDPOINT || 'https://jsearch.p.rapidapi.com/search'; // default to JSearch
  const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST; // optional
  const GOOGLE_CSE_KEY = process.env.GOOGLE_CSE_KEY;
  const GOOGLE_CSE_CX = process.env.GOOGLE_CSE_CX;

  // Helper to push normalized items
  function pushJob(source, raw) {
    const url = raw.url || raw.link || raw.redirect_url || raw.apply_url || raw.job_url || raw.intern_link || (raw.url_link && raw.url_link.url) || '';
    const idSource = url || raw.id || raw.job_id || raw.title || raw.name || JSON.stringify(raw);
    const id = idSource ? normalizeUrl(String(idSource)) : JSON.stringify(raw);
    results.push({ source, id, title: raw.title || raw.name || raw.position || '', company: raw.company || raw.company_name || (raw.company && raw.company.display_name) || raw.employer_name || '', location: raw.location || raw.city || locationStr || '', url, raw });
  }

  // 1) Remotive (free remote jobs API) - good fallback and returns urls
  try {
    const q = locationStr ? `&search=${encodeURIComponent(locationStr)}` : '';
    const remUrl = `https://remotive.com/api/remote-jobs?limit=50${q}`;
    const rem = await safeFetch(remUrl);
    if (rem && rem.jobs && Array.isArray(rem.jobs)) {
      rem.jobs.forEach(j => pushJob('remotive', { title: j.title, company: j.company_name, location: j.candidate_required_location || '', url: j.url, raw: j }));
    }
  } catch (e) { console.warn('Remotive fetch failed', e); }

  // 2) Google Custom Search for job pages (sites like indeed/linkedin/glassdoor)
  try {
    if (GOOGLE_CSE_KEY && GOOGLE_CSE_CX && locationStr) {
      const q = `site:indeed.com OR site:linkedin.com/jobs OR site:glassdoor.com "${locationStr || ''}" jobs`;
      const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(GOOGLE_CSE_KEY)}&cx=${encodeURIComponent(GOOGLE_CSE_CX)}&q=${encodeURIComponent(q)}`;
      const g = await safeFetch(url);
      if (g && Array.isArray(g.items)) {
        g.items.forEach(item => pushJob('google_cse', { title: item.title, url: item.link, raw: item }));
      }
    }
  } catch (e) { console.warn('Google CSE jobs fetch failed', e); }

  // 3) RapidAPI job endpoint (JSearch by default)
  try {
    if (RAPIDAPI_KEY) {
      try {
        // Build query: prefer locationStr as location or as query
        const queryParam = encodeURIComponent(locationStr || 'jobs');
        // Construct URL for JSearch
        let rapidUrl = RAPIDAPI_ENDPOINT;
        // If endpoint doesn't already contain query, append query and location
        const hasQuery = rapidUrl.includes('?');
        if (!hasQuery) {
          rapidUrl = `${rapidUrl}?query=${queryParam}`;
          if (locationStr) rapidUrl += `&location=${encodeURIComponent(locationStr)}`;
          rapidUrl += `&page=1&num_pages=1`;
        } else {
          // ensure query param present
          if (!/\bquery=/.test(rapidUrl)) rapidUrl += `&query=${queryParam}`;
          if (locationStr && !/\blocation=/.test(rapidUrl)) rapidUrl += `&location=${encodeURIComponent(locationStr)}`;
        }

        const headers = { 'x-rapidapi-key': RAPIDAPI_KEY };
        if (RAPIDAPI_HOST) headers['x-rapidapi-host'] = RAPIDAPI_HOST;
        const rapidRes = await safeFetch(rapidUrl, { headers });
        // RapidAPI JSearch returns { data: [...] } or { results: [...] }
        let rapidItems = [];
        if (Array.isArray(rapidRes)) rapidItems = rapidRes;
        else if (Array.isArray(rapidRes.data)) rapidItems = rapidRes.data;
        else if (Array.isArray(rapidRes.results)) rapidItems = rapidRes.results;
        if (rapidItems.length) {
          rapidItems.forEach(job => {
            // JSearch fields may include job_title, employer_name, job_employment_type, job_city, job_state, job_country, job_google_link, job_apply_link
            const normalized = {
              title: job.job_title || job.title || job.position || job.name,
              company: job.employer_name || job.company || job.source || job.company_name,
              location: job.job_city || job.job_state || job.job_country || job.candidate_required_location || job.location || '',
              url: job.job_apply_link || job.job_google_link || job.job_link || job.job_url || job.url || job.link || '',
              raw: job,
            };
            pushJob('jsearch', normalized);
          });
        }
      } catch (e) {
        console.warn('RapidAPI jobs fetch failed', e);
      }
    }
  } catch (e) { console.warn('RapidAPI fetch error', e); }

  // 4) Adzuna
  try {
    if (ADZUNA_APP_ID && ADZUNA_APP_KEY) {
      const country = process.env.ADZUNA_COUNTRY || 'gb';
      const where = locationStr ? `&where=${encodeURIComponent(locationStr)}` : '';
      const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/1?app_id=${ADZUNA_APP_ID}&app_key=${ADZUNA_APP_KEY}${where}`;
      const j = await safeFetch(url);
      if (j && j.results) j.results.forEach(job => pushJob('adzuna', { title: job.title, company: job.company, location: job.location && job.location.display_name, url: job.redirect_url, raw: job }));
    }
  } catch (e) { console.warn('Adzuna fetch failed', e); }

  // 5) Fallback mock if nothing found
  if (!results.length) {
    pushJob('mock', { title: 'Local Delivery Rider', company: 'Local Co', location: locationStr || 'Nearby', url: '' });
    pushJob('mock', { title: 'Part-time Tutor', company: 'Community Center', location: locationStr || 'Nearby', url: '' });
  }

  // Dedupe and return
  const out = [];
  const seen = new Set();
  for (const it of results) {
    const stableId = it.id || makeStableId(it) || JSON.stringify(it);
    if (!seen.has(stableId)) { seen.add(stableId); it.id = stableId; out.push(it); }
  }
  return out.slice(0, 200);
}

// Refresh and persist cache
async function refreshCaches(locationStr) {
  try {
    console.log('Refreshing caches...');
    const [news, jobs] = await Promise.all([fetchNewsOnce(), fetchJobsOnce(locationStr)]);
    CACHE.news = news;
    CACHE.lastNewsUpdated = new Date().toISOString();
    CACHE.jobs = jobs;
    CACHE.lastJobsUpdated = new Date().toISOString();
    // optionally fetch weather snapshot for a default location if env DEFAULT_LAT/LON provided
    const defLat = process.env.DEFAULT_LAT;
    const defLon = process.env.DEFAULT_LON;
    if (defLat && defLon) {
      try { CACHE.weatherSnapshots[`default`] = await fetchWeather(defLat, defLon); } catch (e) { console.warn('default weather fetch failed', e); }
    }
    saveCache();
    console.log('Caches refreshed');
  } catch (e) { console.warn('refreshCaches error', e); }
}

// Load cache on startup
loadCache();
// Kick off an initial refresh asynchronously
refreshCaches().catch(e => console.warn('Initial refresh failed', e));
// Schedule periodic refresh every 6 hours
setInterval(() => refreshCaches().catch(e => console.warn('Scheduled refresh failed', e)), 6 * 60 * 60 * 1000);

// GET /api/weather - returns current weather for lat/lon (OpenWeatherMap) - unchanged but also cache snapshot
app.get('/api/weather', async (req, res) => {
  try {
    const OWM_KEY = process.env.OPENWEATHERMAP_KEY || '';
    const lat = req.query.lat;
    const lon = req.query.lon;
    if (!OWM_KEY) return res.status(400).json({ ok: false, error: 'No OpenWeatherMap API key configured' });
    if (!lat || !lon) return res.status(400).json({ ok: false, error: 'Missing lat/lon' });
    const w = await fetchWeather(lat, lon);
    // cache snapshot for this lat/lon key
    const key = `${lat.toString()},${lon.toString()}`;
    CACHE.weatherSnapshots[key] = w;
    saveCache();
    res.json({ ok: true, weather: w });
  } catch (e) { console.error('weather error', e); res.status(500).json({ ok: false, error: String(e) }); }
});

// GET /api/news - return cached news by default; support ?refresh=1 to force update and optional lat/lon to include weather snapshot in response
app.get('/api/news', async (req, res) => {
  try {
    const refresh = req.query.refresh === '1';
    const lat = req.query.lat;
    const lon = req.query.lon;
    if (refresh) await refreshCaches();
    const items = CACHE.news || [];
    const response = { ok: true, items };
    if (lat && lon) {
      const key = `${lat.toString()},${lon.toString()}`;
      response.weather = CACHE.weatherSnapshots[key] || null;
    }
    res.json(response);
  } catch (err) { console.error(err); res.status(500).json({ ok: false, error: String(err) }); }
});

// GET /api/jobs - return cached jobs; support ?refresh=1 and optional location param
app.get('/api/jobs', async (req, res) => {
  try {
    const refresh = req.query.refresh === '1';
    const location = req.query.location || null;
    if (refresh) await refreshCaches(location);
    const items = CACHE.jobs || [];
    res.json({ ok: true, items, lastUpdated: CACHE.lastJobsUpdated || null });
  } catch (err) { console.error(err); res.status(500).json({ ok: false, error: String(err) }); }
});

// Manual refresh endpoint
app.post('/api/refresh', async (req, res) => {
  try {
    const location = req.body && req.body.location ? String(req.body.location) : null;
    await refreshCaches(location);
    res.json({ ok: true });
  } catch (err) { console.error('refresh endpoint error', err); res.status(500).json({ ok: false, error: String(err) }); }
});

// POST /api/upload - simple file receiver (stores in uploads/ and returns path) - development only
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file' });
    // In production you'd upload to S3 and return a signed URL
    const url = `/uploads/${req.file.filename}`;
    res.json({ ok: true, url, originalname: req.file.originalname, size: req.file.size });
  } catch (err) { console.error(err); res.status(500).json({ ok: false, error: String(err) }); }
});

// POST /api/stt - proxy to AssemblyAI (expects file upload form 'file') - unchanged
app.post('/api/stt', upload.single('file'), async (req, res) => {
  try {
    const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_API_KEY;
    if (!ASSEMBLYAI_KEY) return res.status(400).json({ ok: false, error: 'No STT key configured' });
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
    const filePath = path.resolve(req.file.path);
    const uploadUrl = 'https://api.assemblyai.com/v2/upload';
    const fileStream = fs.createReadStream(filePath);
    const uploadRes = await fetch(uploadUrl, { method: 'POST', headers: { 'authorization': ASSEMBLYAI_KEY }, body: fileStream });
    const uploadJson = await uploadRes.json();
    if (!uploadJson || !uploadJson.upload_url) return res.status(500).json({ ok: false, error: 'Upload failed', raw: uploadJson });

    // Transcription request
    const transcriptRes = await fetch('https://api.assemblyai.com/v2/transcript', { method: 'POST', headers: { 'authorization': ASSEMBLYAI_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ audio_url: uploadJson.upload_url }) });
    const transcriptJson = await transcriptRes.json();
    // Polling loop (simple)
    const pollUrl = `https://api.assemblyai.com/v2/transcript/${transcriptJson.id}`;
    let status = 'processing';
    let transcript = null;
    while (status !== 'completed' && status !== 'failed') {
      await new Promise(r => setTimeout(r, 1500));
      const pr = await fetch(pollUrl, { headers: { 'authorization': ASSEMBLYAI_KEY } });
      const pj = await pr.json();
      status = pj.status;
      if (status === 'completed') transcript = pj.text;
      if (status === 'failed') { transcript = null; break; }
    }

    // cleanup local file
    fs.unlinkSync(filePath);
    res.json({ ok: true, text: transcript });
  } catch (err) { console.error(err); res.status(500).json({ ok: false, error: String(err) }); }
});

// POST /api/llm - proxy to a0 LLM (simple forwarding) - now returns normalized { text, raw }
app.post('/api/llm', async (req, res) => {
  try {
    const A0_API_KEY = process.env.A0_API_KEY;
    if (!A0_API_KEY) return res.status(400).json({ ok: false, error: 'No A0 API key configured' });
    const prompt = req.body?.prompt || '';
    const r = await fetch('https://api.a0.dev/ai/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: A0_API_KEY.startsWith('Bearer') ? A0_API_KEY : `Bearer ${A0_API_KEY}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }),
    });
    const json = await r.json();
    const text = json?.completion || json?.text || (json?.schema_data && json.schema_data.response) || (typeof json === 'string' ? json : JSON.stringify(json));
    res.json({ text, raw: json });
  } catch (err) {
    console.error('LLM proxy error', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// POST /api/clear-cache - wipe cache and refresh (development helper)
app.post('/api/clear-cache', async (req, res) => {
  try {
    CACHE = { news: [], jobs: [], weatherSnapshots: {} };
    try { if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE); } catch (e) { console.warn('clear cache file failed', e); }
    // force refresh now
    await refreshCaches();
    res.json({ ok: true, message: 'Cache cleared and refreshed' });
  } catch (e) {
    console.error('clear-cache error', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.listen(PORT, () => console.log(`Aurexa dev server running on http://localhost:${PORT}`));
