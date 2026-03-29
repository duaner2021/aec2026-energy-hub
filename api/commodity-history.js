const https = require('https');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('Request timeout')));
  });
}

module.exports = async (_req, res) => {
  const apiKey = process.env.ALPHAVANTAGE_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ALPHAVANTAGE_KEY not configured' });

  const result = {};

  // Fetch all three commodities in parallel to avoid sequential cold-start failures
  await Promise.all(['WTI', 'BRENT', 'NATURAL_GAS'].map(async sym => {
    try {
      const json = await fetchJson(
        `https://www.alphavantage.co/query?function=${sym}&interval=daily&apikey=${apiKey}`
      );
      result[sym] = json.data
        ? json.data.filter(d => d.value && d.value !== '.').map(d => ({ date: d.date, value: parseFloat(d.value) })).reverse()
        : [];
    } catch(e) { result[sym] = []; }
  }));

  // Only cache for 24h when all three series returned data.
  // A 60s cache on partial results lets the next request recover quickly.
  const complete = ['WTI', 'BRENT', 'NATURAL_GAS'].every(s => result[s] && result[s].length > 0);
  const cacheSeconds = complete ? 86400 : 60;

  res.setHeader('Cache-Control', `s-maxage=${cacheSeconds}, stale-while-revalidate`);
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json(result);
};
