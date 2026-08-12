import { Router } from 'express';
import { config } from '../config.js';

export const instrumentsRouter = Router();

instrumentsRouter.get('/instruments', (req, res) => {
  res.json({
    symbols: config.binanceSymbols,
    intervals: config.binanceIntervals,
  });
});
