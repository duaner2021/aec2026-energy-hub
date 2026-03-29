// Vercel Serverless Function — /api/market-data
// Proxies Alpha Vantage so the API key never reaches the browser.
// Vercel injects ALPHAVANTAGE_KEY from Environment Variables.

const https = require('https');

const COMMODITY_SYMBOLS = ['WTI', 'BRENT', 'NATURAL_GAS'];

const EQUITY_SYMBOLS = [
  // WTI proxies
  'EOG', 'DVN', 'COP', 'OXY', 'APA',   // Very High
  'XOM', 'CVX', 'HES', 'MRO',           // High
  'SLB', 'HAL', 'BKR',                   // Medium
  'KMI', 'ENB', 'TRP',                   // Low
  // Brent proxies (XOM/CVX already above)
  'BP', 'SHEL', 'TTE', 'EQNR',          // Very High
  'RIG',                                  // Medium
  // Henry Hub proxies (XOM/CVX already above)
  'EQT', 'RRC', 'CRK', 'AR',            // Very High
  'LNG', 'EXE',                           // High
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
    // Abort after 7s so a hanging call doesn't block the whole function
    req.setTimeout(7000, () => req.destroy(new Error('Request timeout')));
  });
}

async function getCommodity(symbol, apiKey) {
  const url = `https://www.alphavantage.co/query?function=${symbol}&interval=daily&apikey=${apiKey}`;
  const json = await fetchJson(url);
  const dataArr = json.data;
  if (!dataArr || dataArr.length < 2) return null;
  const latest = dataArr[0];
  const prev   = dataArr[1];
  const price  = parseFloat(latest.value);
  const prevP  = parseFloat(prev.value);
  const change = ((price - prevP) / prevP) * 100;
  return { symbol, price: price.toFixed(2), change: change.toFixed(2), date: latest.date };
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

module.exports = async (req, res) => {
  const apiKey = process.env.ALPHAVANTAGE_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ALPHAVANTAGE_KEY not configured' });
  }

  const results = { commodities: {}, equities: {} };
  const errors  = [];

  // Step 1 — Commodities: 3 in parallel (fast, needed first)
  await Promise.all(COMMODITY_SYMBOLS.map(async sym => {
    try {
      const d = await getCommodity(sym, apiKey);
      if (d) results.commodities[sym] = d;
    } catch (e) { errors.push(`${sym}: ${e.message}`); }
  }));

  // Step 2 — 1.2s pause so the burst-rate window resets before 29 equity calls fire
  await new Promise(r => setTimeout(r, 1200));

  // Step 3 — All equities in parallel (burst window is fresh; function still has ~6s left)
  await Promise.all(EQUITY_SYMBOLS.map(async sym => {
    try {
      const d = await getEquityQuote(sym, apiKey);
      if (d) results.equities[sym] = d;
    } catch (e) { errors.push(`${sym}: ${e.message}`); }
  }));

  if (errors.length) results.errors = errors;

  // Only cache for the full 15 min when we got a reasonably complete equity set.
  // A short 60s cache lets a poisoned cold-start recover on the next request.
  const equityCount = Object.keys(results.equities).length;
  const cacheSeconds = equityCount >= 20 ? 900 : 60;

  res.setHeader('Cache-Control', `s-maxage=${cacheSeconds}, stale-while-revalidate`);
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json(results);
};
