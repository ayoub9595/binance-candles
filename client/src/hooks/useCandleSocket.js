import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { SOCKET_URL } from '../config.js';

export function useCandleSocket(combos, onUpdate) {
  const [connected, setConnected] = useState(false);
  const socketRef = useRef(null);
  const subscribedRef = useRef(new Set());
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  useEffect(() => {
    const socket = io(SOCKET_URL || undefined);
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      for (const key of subscribedRef.current) {
        const [symbol, interval] = key.split(':');
        socket.emit('subscribe', { symbol, interval });
      }
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('candle:update', (candle) => onUpdateRef.current(candle));

    return () => {
      socket.disconnect();
      socketRef.current = null;
      subscribedRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;

    const desired = new Set(combos.map(({ symbol, interval }) => `${symbol}:${interval}`));

    for (const key of subscribedRef.current) {
      if (!desired.has(key)) {
        const [symbol, interval] = key.split(':');
        socket.emit('unsubscribe', { symbol, interval });
        subscribedRef.current.delete(key);
      }
    }
    for (const key of desired) {
      if (!subscribedRef.current.has(key)) {
        const [symbol, interval] = key.split(':');
        socket.emit('subscribe', { symbol, interval });
        subscribedRef.current.add(key);
      }
    }
  }, [combos]);

  return { connected };
}
