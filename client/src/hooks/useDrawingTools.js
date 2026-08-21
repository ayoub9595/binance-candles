import { useCallback, useMemo, useRef, useState } from 'react';
import { POSITION_DEFAULTS } from '../utils/positionTool.js';

// Click-to-draw state machine for the chart tools.
//
// Each tool collects a fixed number of chart-space points ({time, price}) and
// then commits one drawing:
//   long / short — 2 clicks: STOP, then entry. Drawing from the invalidation
//                  level up to the entry matches how the setup is actually
//                  read off a chart — the stop is the level the structure
//                  gives you (under the order block, past the sweep), and the
//                  entry is chosen relative to it. The gap between the two
//                  clicks IS the risk, and the target is projected from it at
//                  DEFAULT_RR, so a position is two clicks rather than three.
//   line         — 2 clicks: both endpoints.
//   box          — 2 clicks: opposite corners.
//
// Once placed, a drawing is edited by dragging: switch back to the cursor
// tool, click to select, then drag a level, an endpoint, the right edge or the
// body. dragDrawing() below is where a grabbed part turns into a shape change;
// the pixel side of that lives in CandlestickChart and drawingsPrimitive.
//
// Drawings are stored per symbol+interval so switching instruments doesn't
// carry another chart's annotations across. Everything lives in memory for the
// session — nothing is persisted server-side.

const LINE_COLOR = 'rgba(171, 71, 188, 0.95)';
const BOX_COLOR = 'rgba(66, 165, 245, 0.9)';

// Reward projected from the drawn risk leg: a 2R setup out of the box.
const DEFAULT_RR = 2;

// Fallback risk when both clicks land on the same price (a double-click, or a
// chart zoomed so far out that two rows resolve identically). A zero-width
// risk leg would make R infinite and size the position at infinity, so the
// tool opens with a nominal 0.1% leg that the user can then drag.
const MIN_RISK_FRACTION = 0.001;

let nextId = 1;

export function useDrawingTools({ symbol, interval }) {
  // tool: null | 'long' | 'short' | 'line' | 'box'
  const [tool, setTool] = useState(null);
  const [byChart, setByChart] = useState({});
  const [selectedId, setSelectedId] = useState(null);
  // Points collected so far for the in-progress drawing.
  const pendingRef = useRef([]);
  const [pendingCount, setPendingCount] = useState(0);

  const key = `${symbol}:${interval}`;
  const drawings = useMemo(() => byChart[key] ?? [], [byChart, key]);

  const cancel = useCallback(() => {
    pendingRef.current = [];
    setPendingCount(0);
    setTool(null);
  }, []);

  const selectTool = useCallback((next) => {
    pendingRef.current = [];
    setPendingCount(0);
    // null is the cursor/select mode — always clears rather than toggling, so
    // clicking it twice can never re-arm the previously active tool.
    setTool((prev) => (next == null ? null : prev === next ? null : next));
  }, []);

  const commit = useCallback(
    (drawing) => {
      setByChart((prev) => ({ ...prev, [key]: [...(prev[key] ?? []), drawing] }));
      pendingRef.current = [];
      setPendingCount(0);
      // Stay on the same tool so several drawings can be placed in a row.
    },
    [key]
  );

  const handleChartClick = useCallback(
    ({ time, price }) => {
      if (!tool) return;
      pendingRef.current.push({ time, price });
      const pts = pendingRef.current;
      setPendingCount(pts.length);
      if (pts.length < 2) return;

      const [a, b] = pts;
      const id = `d${nextId++}`;
      if (tool === 'long' || tool === 'short') {
        // First click is the stop, second is the entry. Only the DISTANCE
        // between them is taken from the clicks — which side the stop sits on
        // is decided by the direction, so a long always ends up with its stop
        // below the entry even if the two clicks were made the other way
        // round. That keeps the bands meaning what they say without silently
        // reinterpreting which tool was chosen.
        const entry = b.price;
        const leg = Math.abs(entry - a.price) || Math.abs(entry * MIN_RISK_FRACTION);
        const stop = tool === 'long' ? entry - leg : entry + leg;
        const target = tool === 'long' ? entry + leg * DEFAULT_RR : entry - leg * DEFAULT_RR;
        commit({
          id,
          kind: 'position',
          dir: tool,
          time1: Math.min(a.time, b.time),
          time2: Math.max(a.time, b.time),
          entry,
          target,
          stop,
          // Account inputs are carried per drawing, not held globally: two
          // positions on the same chart are often two different plans, and a
          // shared account setting would silently resize both.
          ...POSITION_DEFAULTS,
        });
      } else if (tool === 'line') {
        commit({ id, kind: 'line', time1: a.time, price1: a.price, time2: b.time, price2: b.price, color: LINE_COLOR });
      } else if (tool === 'box') {
        commit({ id, kind: 'box', time1: a.time, price1: a.price, time2: b.time, price2: b.price, color: BOX_COLOR });
      }
    },
    [tool, commit]
  );

  // Drag support: apply a partial update to one drawing. `patch` may be a
  // function of the current drawing, because a drag needs to clamp against
  // the drawing's own other levels (a long's entry cannot pass its target).
  const updateDrawing = useCallback(
    (id, patch) => {
      setByChart((prev) => ({
        ...prev,
        [key]: (prev[key] ?? []).map((d) =>
          d.id === id ? { ...d, ...(typeof patch === 'function' ? patch(d) : patch) } : d
        ),
      }));
    },
    [key]
  );

  // Apply one step of a drag. `part` is what the pointer grabbed (see the
  // primitive's hitTest), `price`/`time` are the pointer in chart space and
  // `dPrice`/`dTime` its movement since the last step — absolute for grabbing
  // a single level, relative for sliding a whole drawing.
  //
  // A position's three levels are ordered by construction (long: stop < entry
  // < target), and that ordering is what makes the bands mean anything, so
  // every level drag clamps against its neighbours rather than letting the
  // tool turn inside out. `eps` keeps a dragged level from landing exactly on
  // the one it is clamped against, which would give a 0-width band and an
  // infinite R.
  const dragDrawing = useCallback(
    (id, part, { price, time, dPrice, dTime }) => {
      updateDrawing(id, (d) => {
        if (d.kind === 'position') {
          const eps = Math.max(Math.abs(d.entry) * 1e-6, Number.MIN_VALUE);
          const long = d.dir === 'long';
          if (part === 'body') {
            const moved = { entry: d.entry + dPrice, target: d.target + dPrice, stop: d.stop + dPrice };
            if (dTime) {
              moved.time1 = d.time1 + dTime;
              moved.time2 = d.time2 + dTime;
            }
            return moved;
          }
          // The right edge only sets duration, and only while the pointer is
          // over real bars — past the last candle there is no time to read.
          if (part === 'right') return time == null ? {} : { time2: Math.max(time, d.time1) };
          if (part === 'target') {
            return { target: long ? Math.max(price, d.entry + eps) : Math.min(price, d.entry - eps) };
          }
          if (part === 'stop') {
            return { stop: long ? Math.min(price, d.entry - eps) : Math.max(price, d.entry + eps) };
          }
          if (part === 'entry') {
            const lo = long ? d.stop : d.target;
            const hi = long ? d.target : d.stop;
            return { entry: Math.min(Math.max(price, lo + eps), hi - eps) };
          }
          return {};
        }

        // Lines and boxes are just two free points — no ordering to preserve.
        if (part === 'p1') return time == null ? { price1: price } : { time1: time, price1: price };
        if (part === 'p2') return time == null ? { price2: price } : { time2: time, price2: price };
        const moved = { price1: d.price1 + dPrice, price2: d.price2 + dPrice };
        if (dTime) {
          moved.time1 = d.time1 + dTime;
          moved.time2 = d.time2 + dTime;
        }
        return moved;
      });
    },
    [updateDrawing]
  );

  const remove = useCallback(
    (id) => {
      setByChart((prev) => ({ ...prev, [key]: (prev[key] ?? []).filter((d) => d.id !== id) }));
      setSelectedId((s) => (s === id ? null : s));
    },
    [key]
  );

  const clearAll = useCallback(() => {
    setByChart((prev) => ({ ...prev, [key]: [] }));
    setSelectedId(null);
  }, [key]);

  return {
    tool,
    selectTool,
    cancel,
    drawings,
    selectedId,
    setSelectedId,
    handleChartClick,
    updateDrawing,
    dragDrawing,
    remove,
    clearAll,
    // How many more clicks the active tool needs (0 when idle).
    awaiting: tool ? 2 - pendingCount : 0,
  };
}
