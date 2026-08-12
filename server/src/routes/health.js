import { Router } from 'express';
import { getCollection } from '../db/mongoClient.js';

export const healthRouter = Router();

healthRouter.get('/health', async (req, res) => {
  try {
    await getCollection('candles').estimatedDocumentCount();
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
});
