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

// Resolves to the number of candles that were genuinely NEW. Callers that page
// upstream almost always re-fetch bars they already hold (providers return
// whole windows, not just the missing parts), so a write count would report
// work done rather than data gained — which is what the repair route shows the
// user.
export async function bulkUpsertCandles(candles) {
  if (candles.length === 0) return 0;
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
  const result = await candlesCollection().bulkWrite(ops, { ordered: false });
  return result.upsertedCount ?? 0;
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

// Just the openTimes for a combo, ascending. Projected down to openTime so the
// query is served entirely from the {symbol, interval, openTime} index: the gap
// scan reads every stored bar of a combo, which as full documents would mean
// pulling tens of megabytes to answer a question about timestamps.
export async function getOpenTimes({ symbol, interval, fromMs }) {
  const query = { symbol, interval };
  if (fromMs != null) query.openTime = { $gte: fromMs };
  return candlesCollection()
    .find(query, { projection: { openTime: 1, _id: 0 } })
    .sort({ openTime: 1 })
    .map((doc) => doc.openTime)
    .toArray();
}
