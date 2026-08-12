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
