import { fetchWindowPage } from './candleSource.js';
import { isForexSymbol } from './forexInstruments.js';
import { pace } from './upstreamPacer.js';
import { intervalMs } from '../utils/intervals.js';
import { bulkUpsertCandles, getOpenTimes } from '../models/candleRepository.js';

// Repair for holes in the MIDDLE (and at the newest edge) of a combo's stored
// history — the one shape of missing data nothing else here can fix.
//
// ensureHistory() only ever extends the OLDEST edge: it walks back from the
// oldest stored candle and stops as soon as `fromMs` is covered, so a hole
// sitting between two candles it already has is invisible to it. On-demand
// pairs collect exactly that hole. A searched symbol is streamed only while
// someone is watching it, so every stretch between two viewings was never
// requested by anyone, and the next viewing appends fresh bars to the RIGHT of
// the hole instead of filling it. Left alone, such a hole survives for the life
// of the database and the chart silently disagrees with the exchange.
//
// So: on acquire, scan the stored run for holes and page them in. The scan is
// index-only and the fill is paced in the background, so the chart still paints
// from stored data immediately.
//
// Forex is excluded from the AUTOMATIC path (the ingestor's acquire and
// reconnect passes only ever hand it Binance combos): most of XAUUSD's holes
// are the market calendar — weekend closes, the daily settlement break — so
// scanning them on every subscribe would spend a request per closure to learn
// what the calendar already implies. Nothing is ever invented either way: a
// hole is only closed with bars the provider actually returned, and a window
// that comes back empty is recorded as unfillable. A forex combo reaches here
// when a repair is explicitly requested for it.

// Per-run page ceiling. A combo left unviewed for months can need more than
// this; the remainder is picked up by the next acquire rather than holding one
// background task on Binance indefinitely.
const MAX_PAGES_PER_RUN = 60;
// A manual repair is one person waiting on one combo, not a background sweep
// competing with the live feed, so it gets a much larger budget — enough to
// clear a forex combo's whole calendar backlog in one press instead of making
// the user click through it sixty holes at a time.
const MAX_PAGES_PER_MANUAL_RUN = 200;
const REQUEST_LIMIT = 1000;

// combo key -> Set of hole windows already requested. A hole the provider
// cannot fill (an illiquid pair with genuinely no trades in the window, a
// halted or delisted pair, or — for forex — a weekend close or the daily
// settlement break) would otherwise be re-requested on every single acquire.
//
// This record is kept across MANUAL repairs too, and that is what makes the
// repair button converge: most of XAUUSD's holes are the market calendar, so
// re-testing them on every press would spend the whole budget relearning that
// the market was shut and never reach a hole that is actually repairable. A
// window is only recorded once the provider has definitively answered "nothing
// here" — a request that THREW is unmarked below, so a transient failure stays
// retryable.
const attempted = new Map();
const inFlight = new Map();

const EMPTY = { added: 0, gaps: 0, closed: 0, remaining: 0, pages: 0, scanned: 0 };

const comboKey = ({ symbol, interval }) => `${symbol}:${interval}`;
const holeKey = ({ fromMs, toMs }) => `${fromMs}-${toMs}`;

// Missing windows implied by a sorted run of openTimes, each expressed as the
// inclusive [fromMs, toMs] openTime range of the bars that should be there.
function findHoles(openTimes, step, now) {
  const holes = [];

  for (let i = 1; i < openTimes.length; i += 1) {
    if (openTimes[i] - openTimes[i - 1] > step) {
      holes.push({ fromMs: openTimes[i - 1] + step, toMs: openTimes[i] - step });
    }
  }

  // The trailing hole: everything between the newest stored bar and the newest
  // bar Binance could have closed by now. This is the on-demand case in its
  // purest form — the stream was dropped when the last viewer left, and nothing
  // has asked for a candle since.
  const newest = openTimes[openTimes.length - 1];
  const newestClosed = Math.floor(now / step) * step - step;
  if (newest + step <= newestClosed) {
    holes.push({ fromMs: newest + step, toMs: newestClosed });
  }

  return holes;
}

// Page one hole until it is closed or the run's page budget is spent. Which
// EDGE each page moves is the provider's business (candleSource.fetchWindowPage
// walks Binance left-to-right and Deriv right-to-left); this loop only shrinks
// the window it is handed back. `budget` is shared across every hole in a run so
// a combo with fifty small holes cannot outspend one with a single large one.
async function fillWindow({ symbol, interval, fromMs, toMs, budget }) {
  let from = fromMs;
  let to = toMs;
  let written = 0;

  // budget.max, not the module constant: a manual repair runs to a larger
  // ceiling, and a fillWindow that stopped at the smaller one while the caller
  // kept handing it holes would mark windows attempted without ever requesting
  // them — silently skipping the very gaps the press was meant to close.
  while (from <= to && budget.pages < budget.max) {
    await pace();
    budget.pages += 1;
    const page = await fetchWindowPage({ symbol, interval, fromMs: from, toMs: to, limit: REQUEST_LIMIT });
    if (page.candles.length === 0) break; // the provider has nothing here

    written += await bulkUpsertCandles(page.candles);
    if (page.done) break;

    // Whichever edge moved, it has to have actually moved — a page that leaves
    // the window unchanged would spin on it forever.
    if (page.nextFrom <= from && page.nextTo >= to) break;
    from = page.nextFrom;
    to = page.nextTo;
  }

  return written;
}

async function heal({ symbol, interval, manual = false }) {
  const step = intervalMs(interval);
  // No uniform bar width (3d/1w/1M) means holes cannot be derived by stepping.
  // Forex is skipped unless the caller explicitly asked for this combo.
  if (!step) return EMPTY;
  if (isForexSymbol(symbol) && !manual) return EMPTY;

  const openTimes = await getOpenTimes({ symbol, interval });
  // Nothing stored at all is ensureSeeded's job, not ours: with no bars there
  // is no hole to measure, only an unknown history depth.
  if (openTimes.length === 0) return EMPTY;

  const key = comboKey({ symbol, interval });
  const tried = attempted.get(key) ?? new Set();
  attempted.set(key, tried);

  const todo = findHoles(openTimes, step, Date.now()).filter((h) => !tried.has(holeKey(h)));
  if (todo.length === 0) return { ...EMPTY, scanned: openTimes.length };

  const budget = { pages: 0, max: manual ? MAX_PAGES_PER_MANUAL_RUN : MAX_PAGES_PER_RUN };
  let added = 0;
  let closed = 0;

  for (const hole of todo) {
    if (budget.pages >= budget.max) {
      console.warn(
        `[heal] ${key}: page budget spent with ${todo.length - closed} hole(s) left, resuming on the next run`
      );
      break;
    }
    // Marked before the fetch, not after: a window that comes back empty must
    // not be retried, and one only partly filled leaves a SHORTER hole whose
    // window key differs, so the remainder is still picked up next time.
    tried.add(holeKey(hole));
    try {
      added += await fillWindow({ symbol, interval, ...hole, budget });
    } catch (err) {
      // A request that failed proves nothing about the window, so drop the mark
      // and let a later run test it again.
      tried.delete(holeKey(hole));
      console.error(`[heal] ${key}: window ${holeKey(hole)} FAILED`, err.message);
    }
    closed += 1;
  }

  if (added > 0) {
    console.log(`[heal] ${key}: added ${added} candle(s) across ${closed} gap(s)`);
  }
  return { added, gaps: todo.length, closed, remaining: todo.length - closed, pages: budget.pages, scanned: openTimes.length };
}

// Concurrent heals for the same combo share one run (a browser opening the same
// pair in two tabs, or an acquire landing during the reconnect pass). Resolves
// to { filled, gaps, closed, scanned } — the ingestor's passes ignore it and
// just await; the repair route reports it back to the user.
//
// `manual` marks a user-requested repair: it allows forex (which the automatic
// passes skip) and raises the page budget. It deliberately does NOT discard the
// record of unfillable windows — see `attempted` above.
export function healGaps(combo, { manual = false } = {}) {
  const symbol = typeof combo?.symbol === 'string' ? combo.symbol.toUpperCase() : '';
  const interval = combo?.interval;
  if (!symbol || !interval) return Promise.resolve(EMPTY);

  // Keyed with the mode: a manual repair must not be quietly satisfied by an
  // in-flight background run working to the smaller budget.
  const key = `${comboKey({ symbol, interval })}${manual ? ':manual' : ''}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const run = heal({ symbol, interval, manual });
  inFlight.set(key, run);
  run.finally(() => {
    if (inFlight.get(key) === run) inFlight.delete(key);
  });
  return run;
}
