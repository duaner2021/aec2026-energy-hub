const https = require('https');

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

module.exports = async (req, res) => {
  const linkupKey = process.env.LINKUP_KEY;
  if (!linkupKey) return res.status(500).json({ error: 'LINKUP_KEY not configured' });

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
      result[t.key] = { answer: '', sources: [] };
    }
  }

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json(result);
};
