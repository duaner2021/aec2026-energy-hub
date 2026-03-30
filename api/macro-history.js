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

  // Staggered launch: one call every 300ms to stay well below AV burst limit.
  // 5 calls × 300ms = 1.2s launch window; last call starts at 1.2s,
  // completes by ~9s — safely within Vercel's 10s function limit.
  const SERIES = [
    // [delay_ms, fetcher]
    [0,    async () => {
      const json = await fetchJson(
        `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=SPY&outputsize=compact&apikey=${apiKey}`
      );
      const series = json['Time Series (Daily)'];
      result['SPY'] = series
        ? Object.entries(series).slice(0, 40).map(([date, v]) => ({ date, value: parseFloat(v['4. close']) })).reverse()
        : [];
    }],
    [300,  async () => {
      const json = await fetchJson(
        `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=UUP&outputsize=compact&apikey=${apiKey}`
      );
      const series = json['Time Series (Daily)'];
      result['UUP'] = series
        ? Object.entries(series).slice(0, 40).map(([date, v]) => ({ date, value: parseFloat(v['4. close']) })).reverse()
        : [];
    }],
    [600,  async () => {
      const json = await fetchJson(
        `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=GLD&outputsize=compact&apikey=${apiKey}`
      );
      const series = json['Time Series (Daily)'];
      result['GLD'] = series
        ? Object.entries(series).slice(0, 40).map(([date, v]) => ({ date, value: parseFloat(v['4. close']) })).reverse()
        : [];
    }],
    [900,  async () => {
      const json = await fetchJson(
        `https://www.alphavantage.co/query?function=TREASURY_YIELD&interval=daily&maturity=10year&apikey=${apiKey}`
      );
      result['TREASURY_10Y'] = json.data
        ? json.data.filter(d => d.value && d.value !== '.').slice(0, 40).map(d => ({ date: d.date, value: parseFloat(d.value) })).reverse()
        : [];
    }],
    [1200, async () => {
      const json = await fetchJson(
        `https://www.alphavantage.co/query?function=FEDERAL_FUNDS_RATE&interval=monthly&apikey=${apiKey}`
      );
      result['FED_RATE'] = (json.data && json.data.length) ? parseFloat(json.data[0].value) : null;
    }],
  ];

  // Set defaults in case a call fails
  result['SPY'] = []; result['UUP'] = []; result['GLD'] = [];
  result['TREASURY_10Y'] = []; result['FED_RATE'] = null;

  await Promise.all(SERIES.map(([delay, fn]) =>
    new Promise(r => setTimeout(r, delay)).then(fn).catch(() => {})
  ));

  // Only cache for 24h when the key series have data.
  // A 60s cache on partial results lets the next request recover quickly.
  const complete = result['SPY'] && result['SPY'].length > 0 &&
                   result['GLD'] && result['GLD'].length > 0 &&
                   result['TREASURY_10Y'] && result['TREASURY_10Y'].length > 0;
  const cacheSeconds = complete ? 86400 : 60;

  res.setHeader('Cache-Control', `s-maxage=${cacheSeconds}, stale-while-revalidate`);
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json(result);
};
