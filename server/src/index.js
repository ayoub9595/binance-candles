import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { config } from './config.js';
import { connectMongo, closeMongo } from './db/mongoClient.js';
import { initSocketServer } from './sockets/socketServer.js';
import { acquireCombo, releaseCombo, startIngestor } from './services/binanceIngestor.js';
import { acquireForexCombo, releaseForexCombo, startForexFeed } from './services/forexProvider.js';
import { isForexSymbol } from './services/forexInstruments.js';
import { startCatalogRefresh } from './services/spotCatalog.js';
import { candlesRouter } from './routes/candles.js';
import { healthRouter } from './routes/health.js';
import { instrumentsRouter } from './routes/instruments.js';
import { historyRouter } from './routes/history.js';
import { moversRouter } from './routes/movers.js';

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
  app.use('/api', moversRouter);

  // Load the tradable-spot catalog in the background: it gates symbol search
  // and on-demand streaming, but nothing about the configured pairs depends on
  // it, so a slow or failing exchangeInfo must not delay listening.
  startCatalogRefresh();

  const httpServer = createServer(app);
  // Browser subscriptions drive upstream subscriptions — a pair outside the
  // configured set gets a stream while someone is watching it, and loses it
  // when the last viewer leaves. Forex symbols route to the configured forex
  // provider (Deriv or cTrader), everything else to the Binance ingestor.
  initSocketServer(httpServer, config.corsOrigin, {
    onSubscribe: (combo) => (isForexSymbol(combo?.symbol) ? acquireForexCombo(combo) : acquireCombo(combo)),
    onUnsubscribe: (combo) => (isForexSymbol(combo?.symbol) ? releaseForexCombo(combo) : releaseCombo(combo)),
  });

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

  const forexCombos = config.forexSymbols.flatMap((symbol) =>
    config.binanceIntervals.map((interval) => ({ symbol, interval }))
  );

  startForexFeed({
    combos: forexCombos,
    backfillLimit: config.backfillLimit,
  }).catch((err) => {
    console.error('[server] forex feed failed to start', err);
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
