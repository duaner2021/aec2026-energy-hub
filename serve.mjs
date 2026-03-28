import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;

// Load .env.local
const envPath = path.join(__dirname, '.env.local');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [k, v] = line.split('=');
    if (k && v) process.env[k.trim()] = v.trim();
  });
}

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.webp': 'image/webp',
};

// Simple in-memory cache (15 min TTL) for local dev
let marketCache = null;
let cacheTs = 0;
const CACHE_TTL = 15 * 60 * 1000;

// Commodity history cache (24h TTL — daily data)
let commodityHistoryCache = null;
let commodityHistoryCacheTs = 0;
const HIST_CACHE_TTL = 24 * 60 * 60 * 1000;

// BLS cache (24h TTL)
let blsCache = null;
let blsCacheTs = 0;
const BLS_CACHE_TTL = 24 * 60 * 60 * 1000;

async function buildBlsData() {
  const SERIES = [
    { id: 'APU000074714', label: 'Gasoline (Unleaded Regular)', unit: '$/gal' },
    { id: 'APU000072511', label: 'Fuel Oil No. 2',              unit: '$/gal' },
    { id: 'CUUR0000SAH',  label: 'Energy CPI',                  unit: 'index' },
    { id: 'CUUR0000SEHF01', label: 'Electricity',               unit: 'index' },
  ];
  const result = {};
  const year = new Date().getFullYear();
  for (const s of SERIES) {
    try {
      const url = `https://api.bls.gov/publicAPI/v1/timeseries/data/${s.id}?startyear=${year - 4}&endyear=${year}`;
      const json = await fetchJson(url);
      const data = (json.Results && json.Results.series && json.Results.series[0])
        ? json.Results.series[0].data : [];
      // Sort newest first, take 60 months for 5yr history
      const sorted = data
        .filter(d => d.period !== 'M13')
        .sort((a, b) => (b.year + b.period).localeCompare(a.year + a.period))
        .slice(0, 60);
      result[s.id] = { label: s.label, unit: s.unit, data: sorted };
    } catch(e) {
      console.error('[BLS]', s.id, e.message);
      result[s.id] = { label: s.label, unit: s.unit, data: [] };
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return result;
}

// Macro history cache (24h TTL)
let macroHistoryCache = null;
let macroHistoryCacheTs = 0;
const MACRO_CACHE_TTL = 24 * 60 * 60 * 1000;

// News cache (1h TTL)
let newsCache = null;
let newsCacheTs = 0;
const NEWS_CACHE_TTL = 60 * 60 * 1000;

async function buildCommodityHistory(apiKey) {
  const symbols = ['WTI', 'BRENT', 'NATURAL_GAS'];
  const result = {};
  for (const sym of symbols) {
    const url = `https://www.alphavantage.co/query?function=${sym}&interval=daily&apikey=${apiKey}`;
    try {
      const json = await fetchJson(url);
      if (json.data && Array.isArray(json.data)) {
        // Reverse so oldest → newest for charting
        result[sym] = json.data
          .filter(d => d.value && d.value !== '.')
          .map(d => ({ date: d.date, value: parseFloat(d.value) }))
          .reverse();
      }
    } catch (e) { console.error('[HIST]', sym, e.message); }
    await new Promise(r => setTimeout(r, 300));
  }
  return result;
}

async function buildMacroHistory(apiKey) {
  const result = {};

  // TIME_SERIES_DAILY for SPY, UUP, GLD
  for (const sym of ['SPY', 'UUP', 'GLD']) {
    try {
      const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${sym}&outputsize=compact&apikey=${apiKey}`;
      const json = await fetchJson(url);
      const series = json['Time Series (Daily)'];
      if (series) {
        result[sym] = Object.entries(series)
          .slice(0, 40)
          .map(([date, v]) => ({ date, value: parseFloat(v['4. close']) }))
          .reverse();
      }
    } catch(e) { console.error('[MACRO]', sym, e.message); }
    await new Promise(r => setTimeout(r, 300));
  }

  // 10Y Treasury Yield (daily)
  try {
    const url = `https://www.alphavantage.co/query?function=TREASURY_YIELD&interval=daily&maturity=10year&apikey=${apiKey}`;
    const json = await fetchJson(url);
    if (json.data) {
      result['TREASURY_10Y'] = json.data
        .filter(d => d.value && d.value !== '.')
        .slice(0, 40)
        .map(d => ({ date: d.date, value: parseFloat(d.value) }))
        .reverse();
    }
  } catch(e) { console.error('[MACRO] TREASURY_10Y', e.message); }
  await new Promise(r => setTimeout(r, 300));

  // Federal Funds Rate (monthly — for display only)
  try {
    const url = `https://www.alphavantage.co/query?function=FEDERAL_FUNDS_RATE&interval=monthly&apikey=${apiKey}`;
    const json = await fetchJson(url);
    if (json.data && json.data.length) {
      result['FED_RATE'] = parseFloat(json.data[0].value);
    }
  } catch(e) { console.error('[MACRO] FED_RATE', e.message); }

  return result;
}

function fetchPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse: ' + data.slice(0, 80))); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function buildNews(linkupKey) {
  const topics = [
    { key: 'WTI',         query: 'Latest trending news for WTI Crude Oil' },
    { key: 'BRENT',       query: 'Latest trending news for Brent Crude Oil' },
    { key: 'NATURAL_GAS', query: 'Latest trending news for Henry Hub Natural Gas' },
  ];
  const result = {};
  for (const t of topics) {
    try {
      const json = await fetchPost(
        'https://api.linkup.so/v1/search',
        { q: t.query, depth: 'standard', outputType: 'sourcedAnswer' },
        { Authorization: `Bearer ${linkupKey}` }
      );
      result[t.key] = { answer: json.answer || '', sources: json.sources || [] };
    } catch (e) {
      console.error('[NEWS]', t.key, e.message);
      result[t.key] = { answer: '', sources: [] };
    }
  }
  return result;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse: ' + data.slice(0,80))); }
      });
    }).on('error', reject);
  });
}

async function getCommodity(symbol, apiKey) {
  const url = `https://www.alphavantage.co/query?function=${symbol}&interval=daily&apikey=${apiKey}`;
  const json = await fetchJson(url);
  const arr = json.data;
  if (!arr || arr.length < 2) return null;
  const price = parseFloat(arr[0].value);
  const prev  = parseFloat(arr[1].value);
  const chg   = ((price - prev) / prev) * 100;
  return { symbol, price: price.toFixed(2), change: chg.toFixed(2), date: arr[0].date };
}

async function getEquity(symbol, apiKey) {
  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${apiKey}`;
  const json = await fetchJson(url);
  const q = json['Global Quote'];
  if (!q || !q['05. price']) return null;
  return {
    symbol,
    price:    parseFloat(q['05. price']).toFixed(2),
    change:   parseFloat(q['10. change percent'].replace('%','')).toFixed(2),
    prevClose:parseFloat(q['08. previous close']).toFixed(2),
  };
}

async function buildMarketData(apiKey) {
  const COMMODITIES = ['WTI', 'BRENT', 'NATURAL_GAS'];
  const EQUITIES = [
    'EOG','DVN','COP','OXY','APA',
    'XOM','CVX','HES','MRO',
    'SLB','HAL','BKR',
    'KMI','ENB','TRP',
    'BP','SHEL','TTE','EQNR','RIG',
    'EQT','CHK','CRK','AR','LNG','EXE',
    'SPY','UUP','GLD',
  ];

  const results = { commodities: {}, equities: {}, ts: Date.now() };

  for (const sym of COMMODITIES) {
    try {
      const d = await getCommodity(sym, apiKey);
      if (d) results.commodities[sym] = d;
    } catch (e) { console.error(sym, e.message); }
    await new Promise(r => setTimeout(r, 300));
  }

  for (const sym of EQUITIES) {
    try {
      const d = await getEquity(sym, apiKey);
      if (d) results.equities[sym] = d;
    } catch (e) { console.error(sym, e.message); }
    await new Promise(r => setTimeout(r, 300));
  }

  return results;
}

const server = http.createServer(async (req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);

  // API route
  if (urlPath === '/api/market-data') {
    const apiKey = process.env.ALPHAVANTAGE_KEY;
    if (!apiKey) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ALPHAVANTAGE_KEY not set in .env.local' }));
      return;
    }
    const now = Date.now();
    if (!marketCache || (now - cacheTs) > CACHE_TTL) {
      console.log('[API] Fetching fresh market data from Alpha Vantage...');
      try {
        marketCache = await buildMarketData(apiKey);
        cacheTs = now;
        console.log('[API] Market data cached.');
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
        return;
      }
    } else {
      console.log('[API] Returning cached market data.');
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(marketCache));
    return;
  }

  // BLS inflation data route
  if (urlPath === '/api/bls-data') {
    const now = Date.now();
    if (!blsCache || (now - blsCacheTs) > BLS_CACHE_TTL) {
      console.log('[BLS] Fetching from BLS API...');
      try {
        blsCache = await buildBlsData();
        blsCacheTs = now;
        console.log('[BLS] Cached.');
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
        return;
      }
    } else {
      console.log('[BLS] Returning cached BLS data.');
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(blsCache));
    return;
  }

  // Macro history route
  if (urlPath === '/api/macro-history') {
    const apiKey = process.env.ALPHAVANTAGE_KEY;
    if (!apiKey) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ALPHAVANTAGE_KEY not set' }));
      return;
    }
    const now = Date.now();
    if (!macroHistoryCache || (now - macroHistoryCacheTs) > MACRO_CACHE_TTL) {
      console.log('[MACRO] Fetching macro history from Alpha Vantage...');
      try {
        macroHistoryCache = await buildMacroHistory(apiKey);
        macroHistoryCacheTs = now;
        console.log('[MACRO] Macro history cached.');
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
        return;
      }
    } else {
      console.log('[MACRO] Returning cached macro history.');
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(macroHistoryCache));
    return;
  }

  // News route
  if (urlPath === '/api/news') {
    const linkupKey = process.env.LINKUP_KEY;
    if (!linkupKey) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'LINKUP_KEY not set' }));
      return;
    }
    const now = Date.now();
    if (!newsCache || (now - newsCacheTs) > NEWS_CACHE_TTL) {
      console.log('[NEWS] Fetching fresh news from Linkup...');
      try {
        newsCache = await buildNews(linkupKey);
        newsCacheTs = now;
        console.log('[NEWS] News cached.');
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
        return;
      }
    } else {
      console.log('[NEWS] Returning cached news.');
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(newsCache));
    return;
  }

  // Equity overview route
  if (urlPath === '/api/equity-overview') {
    const apiKey = process.env.ALPHAVANTAGE_KEY;
    const symbol = req.url.split('symbol=')[1];
    if (!apiKey) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ALPHAVANTAGE_KEY not set' }));
      return;
    }
    if (!symbol) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'symbol required' }));
      return;
    }
    try {
      const url = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`;
      const json = await fetchJson(url);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(json));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Commodity history route
  if (urlPath === '/api/commodity-history') {
    const apiKey = process.env.ALPHAVANTAGE_KEY;
    if (!apiKey) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ALPHAVANTAGE_KEY not set' }));
      return;
    }
    const now = Date.now();
    if (!commodityHistoryCache || (now - commodityHistoryCacheTs) > HIST_CACHE_TTL) {
      console.log('[HIST] Fetching commodity history from Alpha Vantage...');
      try {
        commodityHistoryCache = await buildCommodityHistory(apiKey);
        commodityHistoryCacheTs = now;
        console.log('[HIST] Commodity history cached.');
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
        return;
      }
    } else {
      console.log('[HIST] Returning cached commodity history.');
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(commodityHistoryCache));
    return;
  }

  // Static files
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(__dirname, urlPath);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`API key loaded: ${process.env.ALPHAVANTAGE_KEY ? 'YES' : 'NO'}`);
});
