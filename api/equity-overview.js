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

  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  try {
    const json = await fetchJson(
      `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`
    );
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(json);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
