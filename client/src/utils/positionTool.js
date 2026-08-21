// Position sizing and trade statistics for the long/short position drawing
// tool, modelled on TradingView's Long/Short Position tools.
//
// The drawing itself only carries geometry (entry / target / stop and a time
// span). Everything a trader actually reads off the tool — how many units the
// setup is worth, what it wins or loses in money, the R multiple — is DERIVED
// from that geometry plus the account inputs. Keeping the derivation here, as
// one pure function, means the renderer and the settings panel can never
// disagree about a number, and the arithmetic is testable without a chart.
//
// TradingView's Inputs, and how each maps onto this:
//   Account Size   — the balance risk is a percentage OF.
//   Risk           — percent of the account risked on this trade. (TV also
//                    accepts a money amount; percent is the default and the
//                    one that stays meaningful as the account changes.)
//   Lot Size       — minimum tradable increment; quantity floors to a
//                    multiple of it, because a broker will not fill a third
//                    of a lot.
//   Leverage       — does NOT change quantity. Position size is decided by the
//                    stop distance; leverage only decides how much margin that
//                    position ties up. Conflating the two is the classic way
//                    to size a position 10x too big.
//   Entry / Profit / Stop Level — the geometry, edited numerically here or by
//                    dragging on the chart.
//   QTY precision  — decimals the quantity is reported to.
//
// Ticks are computed against a tick size inferred from price magnitude: the
// API carries no instrument metadata (no tickSize/stepSize from exchangeInfo),
// so a real one is not available. It is right for the majors this app tracks
// and is only ever used for display, never for sizing.

export const POSITION_DEFAULTS = {
  accountSize: 10000,
  riskPct: 1,
  lotSize: 0.001,
  leverage: 1,
  qtyPrecision: 3,
  // Style toggles that change what the renderer draws, so they live on the
  // drawing rather than in a global preference.
  alwaysShowStats: true,
  compactStats: false,
};

// Smallest price increment worth showing, inferred from magnitude. Mirrors the
// decimal rule used for price formatting so a "tick" is always one unit of the
// last displayed digit.
export function tickSizeFor(price) {
  const abs = Math.abs(price);
  if (abs >= 1000) return 0.01;
  if (abs >= 1) return 0.0001;
  return 0.000001;
}

export function fmtPrice(v) {
  const abs = Math.abs(v);
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return v.toFixed(decimals);
}

export function fmtMoney(v) {
  const sign = v < 0 ? '-' : '';
  return `${sign}${Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function fmtPct(v) {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

// d: a position drawing ({ dir, entry, target, stop, ...inputs }).
// Returns every number the tool displays. Degenerate geometry (a zero-width
// risk leg) yields zeros rather than Infinity — a tool mid-drag can briefly
// pass through it, and an Infinity would render as garbage.
export function computePositionStats(d) {
  const {
    entry,
    target,
    stop,
    accountSize = POSITION_DEFAULTS.accountSize,
    riskPct = POSITION_DEFAULTS.riskPct,
    lotSize = POSITION_DEFAULTS.lotSize,
    leverage = POSITION_DEFAULTS.leverage,
    qtyPrecision = POSITION_DEFAULTS.qtyPrecision,
  } = d;

  const riskPerUnit = Math.abs(entry - stop);
  const rewardPerUnit = Math.abs(target - entry);
  const rr = riskPerUnit > 0 ? rewardPerUnit / riskPerUnit : 0;

  // Money at risk, then the size that puts exactly that much behind the stop.
  const riskAmount = (accountSize * riskPct) / 100;
  const rawQty = riskPerUnit > 0 ? riskAmount / riskPerUnit : 0;
  // Floor to a whole number of lots: rounding UP would risk more than the
  // account setting allows, which is the one direction that must never happen.
  const lot = lotSize > 0 ? lotSize : 0;
  const qty = lot > 0 ? Math.floor(rawQty / lot) * lot : rawQty;

  // What the floored size actually risks — after flooring this is at or below
  // riskAmount, and reporting the requested figure instead would overstate it.
  const lossAmount = qty * riskPerUnit;
  const profitAmount = qty * rewardPerUnit;

  const notional = qty * entry;
  const margin = leverage > 0 ? notional / leverage : notional;

  const tickSize = tickSizeFor(entry);
  const signed = (to) => (d.dir === 'long' ? to - entry : entry - to);

  return {
    riskPerUnit,
    rewardPerUnit,
    rr,
    qty,
    qtyPrecision,
    riskAmount,
    lossAmount,
    profitAmount,
    notional,
    margin,
    tickSize,
    // Signed by DIRECTION, not by arithmetic: a short's target sits below its
    // entry, and showing that as a negative move would read as a loss.
    targetPct: entry ? (signed(target) / entry) * 100 : 0,
    stopPct: entry ? (signed(stop) / entry) * 100 : 0,
    targetTicks: Math.round(Math.abs(target - entry) / tickSize),
    stopTicks: Math.round(Math.abs(entry - stop) / tickSize),
  };
}
