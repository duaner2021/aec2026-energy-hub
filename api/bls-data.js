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
  const SERIES = [
    { id: 'APU000074714', label: 'Gasoline (Unleaded Regular)', unit: '$/gal' },
    { id: 'APU000072511', label: 'Fuel Oil No. 2',              unit: '$/gal' },
    { id: 'CUUR0000SAH',  label: 'Energy CPI',                  unit: 'index' },
    { id: 'CUUR0000SEHF01', label: 'Electricity',               unit: 'index' },
  ];

  const result = {};
  const year = new Date().getFullYear();

  for (const s of SERIES) {
    try {
      const url = `https://api.bls.gov/publicAPI/v1/timeseries/data/${s.id}?startyear=${year - 4}&endyear=${year}`;
      const json = await fetchJson(url);
      const series = json.Results && json.Results.series && json.Results.series[0];
      const data = series ? series.data : [];
      const sorted = data
        .filter(d => d.period !== 'M13')
        .sort((a, b) => (b.year + b.period).localeCompare(a.year + a.period))
        .slice(0, 60);
      result[s.id] = { label: s.label, unit: s.unit, data: sorted };
    } catch(e) {
      result[s.id] = { label: s.label, unit: s.unit, data: [] };
    }
    await new Promise(r => setTimeout(r, 200));
  }

  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json(result);
};
