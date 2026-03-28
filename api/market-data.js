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
  'EQT', 'CHK', 'CRK', 'AR',            // Very High
  'LNG', 'EXE',                           // High
  // Macro indicators
  'SPY', 'UUP', 'GLD',
];

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 100))); }
      });
    }).on('error', reject);
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
    price:  parseFloat(q['05. price']).toFixed(2),
    change: parseFloat(q['10. change percent'].replace('%','')).toFixed(2),
    prevClose: parseFloat(q['08. previous close']).toFixed(2),
  };
}

module.exports = async (req, res) => {
  const apiKey = process.env.ALPHAVANTAGE_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ALPHAVANTAGE_KEY not configured' });
  }

  // Fetch commodities and equities — throttle to 5 req/min free tier
  const results = { commodities: {}, equities: {} };
  const errors  = [];

  // Commodities first
  for (const sym of COMMODITY_SYMBOLS) {
    try {
      const d = await getCommodity(sym, apiKey);
      if (d) results.commodities[sym] = d;
    } catch (e) { errors.push(`${sym}: ${e.message}`); }
    await new Promise(r => setTimeout(r, 250)); // gentle throttle
  }

  // Equities
  for (const sym of EQUITY_SYMBOLS) {
    try {
      const d = await getEquityQuote(sym, apiKey);
      if (d) results.equities[sym] = d;
    } catch (e) { errors.push(`${sym}: ${e.message}`); }
    await new Promise(r => setTimeout(r, 250));
  }

  if (errors.length) results.errors = errors;

  // Cache at CDN layer for 15 minutes
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json(results);
};
