import { useState } from 'react';
import { REPLAY_SPEEDS } from '../hooks/useBarReplay.js';

// Local-time value for <input type="datetime-local">, e.g. "2026-08-11T14:30".
function toLocalInputValue(date) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000);
  return shifted.toISOString().slice(0, 16);
}

function defaultStartValue() {
  return toLocalInputValue(new Date(Date.now() - 24 * 60 * 60 * 1000));
}

export function ReplayControls({
  replay,
  onExit,
  onSkipBull,
  onSkipBear,
  onSkipBackBull,
  onSkipBackBear,
  skipDisabled,
  skipBackDisabled,
  skipBullTitle,
  skipBearTitle,
  skipBackBullTitle,
  skipBackBearTitle,
  skipNote,
}) {
  const [startValue, setStartValue] = useState(defaultStartValue);

  if (!replay.active) {
    const startMs = startValue ? new Date(startValue).getTime() : NaN;
    return (
      <div className="replay-controls">
        <span className="replay-label">Replay:</span>
        <input
          type="datetime-local"
          value={startValue}
          max={toLocalInputValue(new Date())}
          onChange={(e) => setStartValue(e.target.value)}
        />
        <button type="button" disabled={Number.isNaN(startMs)} onClick={() => replay.start(startMs)}>
          ▶ Start
        </button>
        {replay.error && <span className="replay-error">{replay.error}</span>}
      </div>
    );
  }

  return (
    <div className="replay-controls">
      <span className="replay-label">Replay:</span>
      <button type="button" title="Exit replay" onClick={onExit}>
        ✕
      </button>
      <button
        type="button"
        title={replay.playing ? 'Pause' : 'Play'}
        onClick={replay.playing ? replay.pause : replay.play}
        disabled={replay.loading || (replay.atEnd && !replay.playing)}
      >
        {replay.playing ? '⏸' : '▶'}
      </button>
      <button
        type="button"
        title="Step back one candle"
        onClick={replay.stepBack}
        disabled={replay.loading || replay.atStart}
      >
        ⏮
      </button>
      <button
        type="button"
        title="Step one candle"
        onClick={replay.stepForward}
        disabled={replay.loading || replay.playing || replay.atEnd}
      >
        ⏭
      </button>
      {/* Skip to a setup, one button per direction and side of the cursor.
          They sit after the single-step controls because they are the same
          motion, just further: forward skips reveal every bar in between,
          backward skips rewind to the zone's detection bar. Colored to the
          candles they hunt, so each pair reads at a glance. */}
      {onSkipBackBull && (
        <button
          type="button"
          className="replay-skip bull"
          title={skipBackBullTitle}
          onClick={onSkipBackBull}
          disabled={skipBackDisabled}
        >
          ⏮▲
        </button>
      )}
      {onSkipBackBear && (
        <button
          type="button"
          className="replay-skip bear"
          title={skipBackBearTitle}
          onClick={onSkipBackBear}
          disabled={skipBackDisabled}
        >
          ⏮▼
        </button>
      )}
      {onSkipBull && (
        <button
          type="button"
          className="replay-skip bull"
          title={skipBullTitle}
          onClick={onSkipBull}
          disabled={skipDisabled}
        >
          ⏭▲
        </button>
      )}
      {onSkipBear && (
        <button
          type="button"
          className="replay-skip bear"
          title={skipBearTitle}
          onClick={onSkipBear}
          disabled={skipDisabled}
        >
          ⏭▼
        </button>
      )}
      <select
        title="Candles per second"
        value={replay.speed}
        onChange={(e) => replay.setSpeed(Number(e.target.value))}
      >
        {REPLAY_SPEEDS.map((s) => (
          <option key={s} value={s}>
            {s}x
          </option>
        ))}
      </select>
      <span className="replay-progress">
        {replay.loading
          ? 'Loading…'
          : `${Math.max(replay.cursor + 1, 0)} / ${replay.total}${
              replay.extending
                ? ' · loading more…'
                : replay.atEnd
                  ? replay.windowCapped
                    ? ' · window limit reached'
                    : ' · end of data'
                  : ''
            }`}
        {/* A failed skip must say so: the cursor does not move, which on its
            own is indistinguishable from a dead button. */}
        {skipNote && <span className="replay-note"> · {skipNote}</span>}
      </span>
    </div>
  );
}
