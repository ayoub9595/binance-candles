import { Server } from 'socket.io';

let io;

function roomName(symbol, interval) {
  return `${symbol}:${interval}`;
}

// A browser asking for a pair the ingestor does not stream is what triggers an
// on-demand Binance subscription, so every join/leave is reported through these
// hooks. They are ref-counting on the other side, which makes the bookkeeping
// here load-bearing: each socket's claims must be counted exactly once and
// released on disconnect, or an on-demand stream leaks for the process's life.
export function initSocketServer(httpServer, corsOrigin, { onSubscribe, onUnsubscribe } = {}) {
  io = new Server(httpServer, {
    cors: { origin: corsOrigin },
  });

  io.on('connection', (socket) => {
    // This socket's claims, so a duplicate subscribe is idempotent and a
    // disconnect releases exactly what was taken.
    const claims = new Set();

    const parse = ({ symbol, interval } = {}) => {
      if (typeof symbol !== 'string' || typeof interval !== 'string') return null;
      const sym = symbol.toUpperCase();
      if (!sym || !interval) return null;
      return { symbol: sym, interval };
    };

    socket.on('subscribe', (payload) => {
      const combo = parse(payload);
      if (!combo) return;
      const room = roomName(combo.symbol, combo.interval);
      if (claims.has(room)) return;
      claims.add(room);
      socket.join(room);
      onSubscribe?.(combo);
    });

    socket.on('unsubscribe', (payload) => {
      const combo = parse(payload);
      if (!combo) return;
      const room = roomName(combo.symbol, combo.interval);
      if (!claims.delete(room)) return;
      socket.leave(room);
      onUnsubscribe?.(combo);
    });

    socket.on('disconnect', () => {
      for (const room of claims) {
        const idx = room.lastIndexOf(':');
        onUnsubscribe?.({ symbol: room.slice(0, idx), interval: room.slice(idx + 1) });
      }
      claims.clear();
    });
  });

  return io;
}

export function broadcastCandleUpdate(symbol, interval, candle) {
  if (!io) return;
  io.to(roomName(symbol, interval)).emit('candle:update', candle);
}
