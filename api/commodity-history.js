const https = require('https');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

module.exports = async (req, res) => {
  const apiKey = process.env.ALPHAVANTAGE_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ALPHAVANTAGE_KEY not configured' });

  const symbols = ['WTI', 'BRENT', 'NATURAL_GAS'];
  const result = {};
  for (const sym of symbols) {
    try {
      const json = await fetchJson(
        `https://www.alphavantage.co/query?function=${sym}&interval=daily&apikey=${apiKey}`
      );
      if (json.data) {
        result[sym] = json.data
          .filter(d => d.value && d.value !== '.')
          .map(d => ({ date: d.date, value: parseFloat(d.value) }))
          .reverse();
      }
    } catch(e) { result[sym] = []; }
    await new Promise(r => setTimeout(r, 300));
  }

  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json(result);
};
