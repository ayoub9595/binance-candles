import { useCallback, useMemo, useRef, useState } from 'react';

// Click-to-draw state machine for the chart tools.
//
// Each tool collects a fixed number of chart-space points ({time, price}) and
// then commits one drawing:
//   long / short — 2 clicks: entry, then target. The stop is mirrored from the
//                  entry at the configured R distance, so a position is two
//                  clicks rather than three; it stays editable afterwards.
//   line         — 2 clicks: both endpoints.
//   box          — 2 clicks: opposite corners.
//
// Drawings are stored per symbol+interval so switching instruments doesn't
// carry another chart's annotations across. Everything lives in memory for the
// session — nothing is persisted server-side.

const LINE_COLOR = 'rgba(171, 71, 188, 0.95)';
const BOX_COLOR = 'rgba(66, 165, 245, 0.9)';

// Default risk leg as a fraction of the entry→target distance: a 2R setup.
const DEFAULT_RR = 2;

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
        const entry = a.price;
        const target = b.price;
        // Stop sits opposite the target at 1/DEFAULT_RR of its distance, so
        // the tool opens as a DEFAULT_RR setup regardless of click distance.
        const leg = Math.abs(target - entry) / DEFAULT_RR;
        const stop = tool === 'long' ? entry - leg : entry + leg;
        commit({
          id,
          kind: 'position',
          dir: tool,
          time1: Math.min(a.time, b.time),
          time2: Math.max(a.time, b.time),
          entry,
          target,
          stop,
        });
      } else if (tool === 'line') {
        commit({ id, kind: 'line', time1: a.time, price1: a.price, time2: b.time, price2: b.price, color: LINE_COLOR });
      } else if (tool === 'box') {
        commit({ id, kind: 'box', time1: a.time, price1: a.price, time2: b.time, price2: b.price, color: BOX_COLOR });
      }
    },
    [tool, commit]
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
    remove,
    clearAll,
    // How many more clicks the active tool needs (0 when idle).
    awaiting: tool ? 2 - pendingCount : 0,
  };
}
