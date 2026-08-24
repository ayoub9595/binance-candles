import { config } from '../config.js';
import * as deriv from './derivFeed.js';
import * as ctrader from './ctraderFeed.js';

// Which upstream serves the forex symbols: Deriv (keyless, the default) or the
// cTrader Open API (broker-real candles — e.g. a Fusion Markets account — needs
// credentials, see .env.example). Selected once at boot via FOREX_PROVIDER and
// re-exported under provider-neutral names, so candleSource, the socket wiring
// and /health never know which one is behind the curtain. Candles from both
// land in the same Mongo collection: switch providers on an existing database
// and the histories will interleave — different brokers quote slightly
// different prices, so start a fresh DB_NAME if that matters to you.
const providers = {
  deriv: {
    fetchForexKlines: deriv.fetchForexKlines,
    acquireForexCombo: deriv.acquireForexCombo,
    releaseForexCombo: deriv.releaseForexCombo,
    startForexFeed: deriv.startForexFeed,
    getForexStats: () => ({ provider: 'deriv', ...deriv.getForexStats() }),
  },
  ctrader: {
    fetchForexKlines: ctrader.fetchCtraderKlines,
    acquireForexCombo: ctrader.acquireCtraderCombo,
    releaseForexCombo: ctrader.releaseCtraderCombo,
    startForexFeed: ctrader.startCtraderFeed,
    getForexStats: ctrader.getCtraderStats,
  },
};

export const { fetchForexKlines, acquireForexCombo, releaseForexCombo, startForexFeed, getForexStats } =
  providers[config.forexProvider];
