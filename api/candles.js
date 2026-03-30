export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { pair } = req.query;
  if (!pair) return res.status(400).json({ error: 'pair required' });

  try {
    // CoinDCX candles endpoint — 5m interval, last 60 candles
    const url = `https://public.coindcx.com/market_data/candles?pair=${pair}&interval=5m&limit=60`;
    const response = await fetch(url);
    const data = await response.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
