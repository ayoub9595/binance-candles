import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { searchSymbols } from '../services/api.js';

// Type-to-search over every tradable Binance spot pair. The old control was a
// <select> over the six configured symbols; the server now indexes the whole
// exchange, so this is a combobox instead — closed it reads as the current
// pair, open it is a search field over ~2000 results.
//
// Closed the input shows the selected symbol; opening clears it to a prompt so
// typing replaces rather than edits, which is what a search field should do.
// Escape restores the selection, so an accidental open costs nothing.

const DEBOUNCE_MS = 160;
const RESULT_LIMIT = 25;
const RECENTS_KEY = 'binance-candles:recent-symbols';
const RECENTS_MAX = 8;

function readRecents() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((s) => typeof s === 'string').slice(0, RECENTS_MAX) : [];
  } catch {
    return [];
  }
}

function pushRecent(symbol) {
  const next = [symbol, ...readRecents().filter((s) => s !== symbol)].slice(0, RECENTS_MAX);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // Private-mode / quota — recents are a convenience, never a requirement.
  }
  return next;
}

export function SymbolSearch({ symbol, defaultSymbols = [], onSymbolChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [recents, setRecents] = useState(readRecents);

  const inputRef = useRef(null);
  const listRef = useRef(null);
  const wrapRef = useRef(null);

  // With no query there is nothing to search for, so the list is the useful
  // shortlist instead: what this user actually charts, then the server's
  // configured pairs. Deduped, recents first.
  const shortlist = useMemo(() => {
    const seen = new Set();
    return [...recents, ...defaultSymbols]
      .filter((s) => (seen.has(s) ? false : seen.add(s)))
      .slice(0, RESULT_LIMIT)
      .map((s) => ({ symbol: s }));
  }, [recents, defaultSymbols]);

  const trimmed = query.trim();
  const options = trimmed ? results : shortlist;

  // Debounced search. A response is applied only if the query that asked for it
  // is still the current one — out-of-order responses on a fast typist would
  // otherwise leave the list showing an earlier prefix's matches.
  useEffect(() => {
    if (!open || !trimmed) {
      setResults([]);
      setLoading(false);
      setFailed(false);
      return undefined;
    }
    setLoading(true);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchSymbols(trimmed, RESULT_LIMIT, { signal: controller.signal })
        .then((data) => {
          setResults(data.results ?? []);
          setFailed(false);
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          console.error('symbol search failed', err);
          setResults([]);
          setFailed(true);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, trimmed]);

  // Any change to the option set invalidates the highlight position.
  useEffect(() => setActiveIndex(0), [trimmed, results, open]);

  // Keep the highlighted row in view under keyboard navigation.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    inputRef.current?.blur();
  }, []);

  const choose = useCallback(
    (picked) => {
      if (!picked) return;
      setRecents(pushRecent(picked));
      close();
      if (picked !== symbol) onSymbolChange(picked);
    },
    [symbol, onSymbolChange, close]
  );

  // Clicking outside commits nothing and restores the selected symbol.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e) => {
      if (!wrapRef.current?.contains(e.target)) close();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open, close]);

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') setOpen(true);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!options.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((i) => (i + step + options.length) % options.length);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      // Typing a full pair and hitting Enter works before the response lands,
      // and while search is unreachable. NOT once a search has come back
      // empty though — then the pair is known not to exist, and accepting it
      // would strand the chart on a symbol that can never load.
      const typed = trimmed && (loading || failed) ? trimmed.toUpperCase() : null;
      choose(options[activeIndex]?.symbol ?? typed);
      return;
    }
    if (e.key === 'Tab') close();
  };

  const status = () => {
    if (loading) return 'Searching…';
    if (failed) return 'Search unavailable — check the server';
    if (trimmed) return `No spot pair matches “${trimmed}”`;
    return 'Type to search every Binance spot pair';
  };

  return (
    <div className="symbol-search" ref={wrapRef}>
      <input
        ref={inputRef}
        type="text"
        className="symbol-search-input"
        role="combobox"
        aria-expanded={open}
        aria-controls="symbol-search-list"
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck="false"
        title="Search any Binance spot pair — by symbol (BTCUSDT) or asset (btc, pepe)"
        placeholder={open ? 'Search pairs…' : symbol}
        value={open ? query : symbol}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setOpen(true)}
        onMouseDown={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && (
        <div className="symbol-search-panel">
          {!trimmed && shortlist.length > 0 && (
            <div className="symbol-search-heading">{recents.length ? 'Recent & default pairs' : 'Default pairs'}</div>
          )}
          {options.length > 0 ? (
            <ul className="symbol-search-list" id="symbol-search-list" role="listbox" ref={listRef}>
              {options.map((o, i) => (
                <li
                  key={o.symbol}
                  role="option"
                  aria-selected={o.symbol === symbol}
                  data-active={i === activeIndex}
                  className={`symbol-search-option ${i === activeIndex ? 'active' : ''} ${
                    o.symbol === symbol ? 'current' : ''
                  }`}
                  onMouseEnter={() => setActiveIndex(i)}
                  // mousedown, not click: the input's blur would otherwise
                  // close the panel before the click could land.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(o.symbol);
                  }}
                >
                  <span className="symbol-search-symbol">{o.symbol}</span>
                  {o.baseAsset && (
                    <span className="symbol-search-assets">
                      {o.baseAsset} / {o.quoteAsset}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="symbol-search-status">{status()}</div>
          )}
        </div>
      )}
    </div>
  );
}
