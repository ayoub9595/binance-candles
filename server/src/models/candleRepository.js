import { getCollection } from '../db/mongoClient.js';
import { toWireShape } from '../utils/normalizeCandle.js';

function candlesCollection() {
  return getCollection('candles');
}

export async function upsertCandle(candle) {
  const { symbol, interval, openTime, ...fields } = candle;
  await candlesCollection().updateOne(
    { symbol, interval, openTime },
    { $set: { ...fields, updatedAt: new Date() } },
    { upsert: true }
  );
}

export async function bulkUpsertCandles(candles) {
  if (candles.length === 0) return;
  const ops = candles.map((candle) => {
    const { symbol, interval, openTime, ...fields } = candle;
    return {
      updateOne: {
        filter: { symbol, interval, openTime },
        update: { $set: { ...fields, updatedAt: new Date() } },
        upsert: true,
      },
    };
  });
  await candlesCollection().bulkWrite(ops, { ordered: false });
}

export async function getCandles({ symbol, interval, limit = 500, startTime, endTime }) {
  const query = { symbol, interval };
  if (startTime != null || endTime != null) {
    query.openTime = {};
    if (startTime != null) query.openTime.$gte = startTime;
    if (endTime != null) query.openTime.$lte = endTime;
  }

  // With a lower bound the caller wants the first N candles from that point
  // (replay feeds forward); otherwise keep the "latest N" behavior.
  if (startTime != null) {
    const docs = await candlesCollection().find(query).sort({ openTime: 1 }).limit(limit).toArray();
    return docs.map(toWireShape);
  }

  const docs = await candlesCollection().find(query).sort({ openTime: -1 }).limit(limit).toArray();
  return docs.reverse().map(toWireShape);
}

export async function getLatestOpenTime({ symbol, interval }) {
  const doc = await candlesCollection().findOne(
    { symbol, interval },
    { sort: { openTime: -1 }, projection: { openTime: 1 } }
  );
  return doc ? doc.openTime : null;
}

export async function getOldestOpenTime({ symbol, interval }) {
  const doc = await candlesCollection().findOne(
    { symbol, interval },
    { sort: { openTime: 1 }, projection: { openTime: 1 } }
  );
  return doc ? doc.openTime : null;
}
