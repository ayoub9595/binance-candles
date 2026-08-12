const BASE_URL = 'https://api.binance.com/api/v3/klines';

export async function fetchKlines({ symbol, interval, startTime, endTime, limit = 1000 }) {
  const params = new URLSearchParams({ symbol, interval, limit: String(limit) });
  if (startTime) params.set('startTime', String(startTime));
  if (endTime) params.set('endTime', String(endTime));

  const res = await fetch(`${BASE_URL}?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Binance klines request failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}
