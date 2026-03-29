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

  const result = {};

  // Fetch all series in parallel to avoid sequential timeout failures
  await Promise.all([

    // SPY, UUP, GLD daily close
    ...['SPY', 'UUP', 'GLD'].map(async sym => {
      try {
        const json = await fetchJson(
          `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${sym}&outputsize=compact&apikey=${apiKey}`
        );
        const series = json['Time Series (Daily)'];
        result[sym] = series
          ? Object.entries(series).slice(0, 40).map(([date, v]) => ({ date, value: parseFloat(v['4. close']) })).reverse()
          : [];
      } catch(e) { result[sym] = []; }
    }),

    // 10-Year Treasury Yield
    (async () => {
      try {
        const json = await fetchJson(
          `https://www.alphavantage.co/query?function=TREASURY_YIELD&interval=daily&maturity=10year&apikey=${apiKey}`
        );
        result['TREASURY_10Y'] = json.data
          ? json.data.filter(d => d.value && d.value !== '.').slice(0, 40).map(d => ({ date: d.date, value: parseFloat(d.value) })).reverse()
          : [];
      } catch(e) { result['TREASURY_10Y'] = []; }
    })(),

    // Federal Funds Rate
    (async () => {
      try {
        const json = await fetchJson(
          `https://www.alphavantage.co/query?function=FEDERAL_FUNDS_RATE&interval=monthly&apikey=${apiKey}`
        );
        result['FED_RATE'] = (json.data && json.data.length) ? parseFloat(json.data[0].value) : null;
      } catch(e) { result['FED_RATE'] = null; }
    })(),

  ]);

  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json(result);
};
