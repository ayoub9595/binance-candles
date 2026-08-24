import { Router } from 'express';
import { getCollection } from '../db/mongoClient.js';
import { getStreamStats } from '../services/binanceIngestor.js';
import { getForexStats } from '../services/forexProvider.js';
import { catalogSize } from '../services/spotCatalog.js';

export const healthRouter = Router();

healthRouter.get('/health', async (req, res) => {
  // On-demand streams are ref-counted against live browser subscriptions, so
  // the counts double as the leak check: `onDemand` should drain to empty once
  // every viewer of a searched pair has left.
  const streams = getStreamStats();
  const forex = getForexStats();
  try {
    await getCollection('candles').estimatedDocumentCount();
    res.json({ status: 'ok', catalogSize: catalogSize(), streams, forex });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message, catalogSize: catalogSize(), streams, forex });
  }
});
