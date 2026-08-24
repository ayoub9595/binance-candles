// One-off repair for holes already sitting in the candles collection.
//
// The healer normally runs on acquire, which fixes a combo the next time
// somebody charts it. This walks every stored combo instead, so history that
// nobody has reopened yet stops disagreeing with the exchange.
//
//   npm run heal            # report only, touches nothing
//   npm run heal -- --write # actually backfill the holes
//
// Forex is skipped: XAUUSD's holes are the market calendar (weekend closes, the
// daily settlement break), not lost data.

import { connectMongo, closeMongo, getCollection } from '../src/db/mongoClient.js';
import { isForexSymbol } from '../src/services/forexInstruments.js';
import { healGaps } from '../src/services/gapHealer.js';
import { intervalMs } from '../src/utils/intervals.js';

const write = process.argv.includes('--write');

async function storedCombos() {
  const rows = await getCollection('candles')
    .aggregate([
      { $group: { _id: { symbol: '$symbol', interval: '$interval' }, n: { $sum: 1 } } },
      { $sort: { '_id.symbol': 1, '_id.interval': 1 } },
    ])
    .toArray();
  return rows.map((r) => ({ symbol: r._id.symbol, interval: r._id.interval, stored: r.n }));
}

// Same arithmetic the healer uses, but read-only — so the dry run reports
// exactly what the write pass would go after.
async function countMissing({ symbol, interval }) {
  const step = intervalMs(interval);
  if (!step) return null;
  const times = await getCollection('candles')
    .find({ symbol, interval }, { projection: { openTime: 1, _id: 0 } })
    .sort({ openTime: 1 })
    .map((d) => d.openTime)
    .toArray();
  if (times.length === 0) return { holes: 0, bars: 0 };

  let holes = 0;
  let bars = 0;
  for (let i = 1; i < times.length; i += 1) {
    const delta = times[i] - times[i - 1];
    if (delta > step) {
      holes += 1;
      bars += delta / step - 1;
    }
  }
  const newestClosed = Math.floor(Date.now() / step) * step - step;
  const trailing = (newestClosed - times[times.length - 1]) / step;
  if (trailing >= 1) {
    holes += 1;
    bars += trailing;
  }
  return { holes, bars: Math.round(bars) };
}

async function main() {
  await connectMongo();
  const combos = (await storedCombos()).filter((c) => !isForexSymbol(c.symbol) && intervalMs(c.interval));

  const damaged = [];
  for (const combo of combos) {
    const before = await countMissing(combo);
    if (before && before.bars > 0) damaged.push({ ...combo, before });
  }

  const totalBars = damaged.reduce((sum, d) => sum + d.before.bars, 0);
  console.log(
    `${combos.length} crypto combo(s) scanned — ${damaged.length} with gaps, ${totalBars} bar(s) missing in total`
  );
  if (damaged.length === 0) {
    await closeMongo();
    return;
  }

  for (const d of damaged) {
    console.log(`  ${d.symbol.padEnd(12)} ${d.interval.padEnd(4)} ${String(d.before.bars).padStart(6)} bar(s) in ${d.before.holes} hole(s)`);
  }

  if (!write) {
    console.log('\nDry run — nothing written. Re-run with --write to backfill these from Binance.');
    await closeMongo();
    return;
  }

  console.log(`\nBackfilling (paced at ~1 page/300ms, shared with the live server's budget)...`);
  let filled = 0;
  let stillMissing = 0;
  for (const d of damaged) {
    try {
      filled += await healGaps({ symbol: d.symbol, interval: d.interval });
    } catch (err) {
      console.error(`  ${d.symbol} ${d.interval}: FAILED — ${err.message}`);
      continue;
    }
    const after = await countMissing(d);
    stillMissing += after.bars;
    const verdict = after.bars === 0 ? 'clean' : `${after.bars} bar(s) still missing`;
    console.log(`  ${d.symbol.padEnd(12)} ${d.interval.padEnd(4)} -> ${verdict}`);
  }

  console.log(`\nWrote ${filled} candle(s). Remaining unfillable: ${stillMissing} bar(s).`);
  if (stillMissing > 0) {
    console.log('Unfillable bars are intervals Binance itself has no kline for (no trades, or a halt).');
  }
  await closeMongo();
}

main().catch(async (err) => {
  console.error('heal-gaps failed:', err);
  await closeMongo().catch(() => {});
  process.exit(1);
});
