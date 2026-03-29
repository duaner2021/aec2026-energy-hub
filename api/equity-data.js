// Vercel Serverless Function — /api/equity-data
// Fetches GLOBAL_QUOTE for all equity proxy symbols.
// Batches of 5 with 300ms delay — conservative to avoid burst rate limits.

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
    req.setTimeout(7000, () => req.destroy(new Error('Request timeout')));
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

  // 2s warm-up: Lambda network stack (DNS + TLS) needs time to fully initialise
  // on cold start. Without this, the first batch always fails.
  await new Promise(r => setTimeout(r, 2000));

  // Batches of 5 with 500ms between batches.
  // Slow is fine — reliable matters more than fast.
  for (let i = 0; i < EQUITY_SYMBOLS.length; i += 5) {
    const batch = EQUITY_SYMBOLS.slice(i, i + 5);
    await Promise.all(batch.map(async sym => {
      try {
        const d = await getEquityQuote(sym, apiKey);
        if (d) equities[sym] = d;
      } catch (e) { /* silent — missing equity shows as blank */ }
    }));
    if (i + 5 < EQUITY_SYMBOLS.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  const equityCount = Object.keys(equities).length;
  const cacheSeconds = equityCount >= 20 ? 900 : 60;

  res.setHeader('Cache-Control', `s-maxage=${cacheSeconds}, stale-while-revalidate`);
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json({ equities });
};
