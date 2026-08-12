import { Server } from 'socket.io';

let io;

function roomName(symbol, interval) {
  return `${symbol}:${interval}`;
}

export function initSocketServer(httpServer, corsOrigin) {
  io = new Server(httpServer, {
    cors: { origin: corsOrigin },
  });

  io.on('connection', (socket) => {
    socket.on('subscribe', ({ symbol, interval }) => {
      socket.join(roomName(symbol, interval));
    });
    socket.on('unsubscribe', ({ symbol, interval }) => {
      socket.leave(roomName(symbol, interval));
    });
  });

  return io;
}

export function broadcastCandleUpdate(symbol, interval, candle) {
  if (!io) return;
  io.to(roomName(symbol, interval)).emit('candle:update', candle);
}
