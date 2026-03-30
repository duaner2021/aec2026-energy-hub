// Vercel Serverless Function — /api/equity-data
// Fetches GLOBAL_QUOTE for all equity proxy symbols.
// Staggered launch: one call starts every 150ms — keeps at most 3-4 in-flight
// at any time, safely below Alpha Vantage's burst threshold.

const https = require('https');

const EQUITY_SYMBOLS = [
  // WTI proxies
  'EOG', 'DVN', 'COP', 'OXY', 'APA',
  'XOM', 'CVX', 'HES', 'MRO',
  'SLB', 'HAL', 'BKR',
  'KMI', 'ENB', 'TRP',
  // Brent proxies
  'BP', 'SHEL', 'TTE', 'EQNR',
  'RIG',
  // Henry Hub proxies
  'EQT', 'RRC', 'CRK', 'AR',
  'LNG', 'EXE',
  // Macro indicators
  'SPY', 'UUP', 'GLD',
];

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 100))); }
      });
    }).on('error', reject);
    // 3s per-call timeout — last call starts at ~6.2s, must finish by 10s
    req.setTimeout(3000, () => req.destroy(new Error('Request timeout')));
  });
}

async function getEquityQuote(symbol, apiKey) {
  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${apiKey}`;
  const json = await fetchJson(url);
  const q = json['Global Quote'];
  if (!q || !q['05. price']) return null;
  return {
    symbol,
    price:     parseFloat(q['05. price']).toFixed(2),
    change:    parseFloat(q['10. change percent'].replace('%', '')).toFixed(2),
    prevClose: parseFloat(q['08. previous close']).toFixed(2),
  };
}

module.exports = async (_req, res) => {
  const apiKey = process.env.ALPHAVANTAGE_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ALPHAVANTAGE_KEY not configured' });

  const equities = {};

  // 2s warm-up: lets Lambda DNS/TLS fully initialise on cold start
  await new Promise(r => setTimeout(r, 2000));

  // Staggered launch: each symbol starts 150ms after the previous one.
  // Max ~4 calls in-flight at any time — eliminates synchronized burst spikes.
  // Total launch window: 28 × 150ms = 4.2s → last call starts at ~6.2s,
  // completes by ~7s — well within Vercel's 10s limit.
  const promises = EQUITY_SYMBOLS.map((sym, i) =>
    new Promise(r => setTimeout(r, i * 150))
      .then(() => getEquityQuote(sym, apiKey))
      .then(d => { if (d) equities[sym] = d; })
      .catch(() => {})
  );
  await Promise.all(promises);

  const equityCount = Object.keys(equities).length;
  const cacheSeconds = equityCount >= 20 ? 900 : 60;

  res.setHeader('Cache-Control', `s-maxage=${cacheSeconds}, stale-while-revalidate`);
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json({ equities });
};
