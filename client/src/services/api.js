import axios from 'axios';
import { API_BASE_URL } from '../config.js';

const client = axios.create({ baseURL: API_BASE_URL });

export async function getCandles(symbol, interval, limit = 500, { startTime, endTime } = {}) {
  const { data } = await client.get('/api/candles', {
    params: { symbol, interval, limit, startTime, endTime },
  });
  return data;
}

export async function getInstruments() {
  const { data } = await client.get('/api/instruments');
  return data;
}

// Ask the server to backfill this combo from Binance back to `fromMs` if its
// stored history is too shallow. Can take a while for dates far in the past
// (the server pages through Binance klines); instant once a range is covered.
export async function ensureHistory(symbol, interval, fromMs) {
  const { data } = await client.post('/api/history/ensure', { symbol, interval, fromMs });
  return data;
}
