import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { config } from './config.js';
import { connectMongo, closeMongo } from './db/mongoClient.js';
import { initSocketServer } from './sockets/socketServer.js';
import { startIngestor } from './services/binanceIngestor.js';
import { candlesRouter } from './routes/candles.js';
import { healthRouter } from './routes/health.js';
import { instrumentsRouter } from './routes/instruments.js';
import { historyRouter } from './routes/history.js';

async function main() {
  console.log('[server] connecting to MongoDB...');
  await connectMongo();
  console.log('[server] connected to MongoDB');

  const app = express();
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json());
  app.use('/api', candlesRouter);
  app.use('/api', healthRouter);
  app.use('/api', instrumentsRouter);
  app.use('/api', historyRouter);

  const httpServer = createServer(app);
  initSocketServer(httpServer, config.corsOrigin);

  httpServer.listen(config.port, () => {
    console.log(`[server] listening on :${config.port}`);
  });

  const combos = config.binanceSymbols.flatMap((symbol) =>
    config.binanceIntervals.map((interval) => ({ symbol, interval }))
  );

  startIngestor({
    combos,
    backfillLimit: config.backfillLimit,
  }).catch((err) => {
    console.error('[server] ingestor failed to start', err);
  });

  const shutdown = async () => {
    console.log('[server] shutting down...');
    await closeMongo();
    httpServer.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[server] fatal startup error', err);
  process.exit(1);
});
