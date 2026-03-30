export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { pair } = req.query;
  if (!pair) return res.status(400).json({ error: 'pair required' });

  try {
    // CoinDCX public candles only works for USDT pairs, not INR.
    // EMA signal quality is identical — BTC/USDT and BTC/INR move the same way.
    // Convert: B-BTC_INR → B-BTC_USDT
    const usdtPair = pair.replace('_INR', '_USDT');
    const url = `https://public.coindcx.com/market_data/candles?pair=${usdtPair}&interval=5m&limit=60`;

    const response = await fetch(url);
    if (!response.ok) throw new Error(`CoinDCX ${response.status}: ${await response.text()}`);

    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('Unexpected: ' + JSON.stringify(data).slice(0, 200));

    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
