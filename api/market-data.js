// Vercel Serverless Function — /api/market-data
// Returns current prices for WTI, BRENT, NATURAL_GAS only.
// Equity quotes are handled by /api/equity-data.

const https = require('https');

const COMMODITY_SYMBOLS = ['WTI', 'BRENT', 'NATURAL_GAS'];

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

module.exports = async (_req, res) => {
  const apiKey = process.env.ALPHAVANTAGE_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ALPHAVANTAGE_KEY not configured' });

  const commodities = {};

  await Promise.all(COMMODITY_SYMBOLS.map(async sym => {
    try {
      const d = await getCommodity(sym, apiKey);
      if (d) commodities[sym] = d;
    } catch (e) { /* silent — missing commodity shows as blank */ }
  }));

  const complete = Object.keys(commodities).length === 3;
  const cacheSeconds = complete ? 900 : 60;

  res.setHeader('Cache-Control', `s-maxage=${cacheSeconds}, stale-while-revalidate`);
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json({ commodities, equities: {} });
};
