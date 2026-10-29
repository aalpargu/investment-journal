import assert from 'node:assert/strict';

const originalFetch = globalThis.fetch;

globalThis.fetch = async () => new Response(JSON.stringify({
  chart: {
    result: [{
      meta: {
        currency: 'USD',
        regularMarketPrice: null,
        chartPreviousClose: 100,
        regularMarketTime: 1_723_000_000,
      },
      timestamp: [1_720_000_000, 1_721_000_000, 1_722_000_000],
      indicators: {
        quote: [{
          open: [null, null, 108],
          high: [null, null, 112],
          low: [null, null, 107],
          close: [100, null, 110],
          volume: [null, null, 1_000],
        }],
      },
    }],
    error: null,
  },
}), { status: 200, headers: { 'Content-Type': 'application/json' } });

try {
  const { fetchBenchmark, fetchHistory, fetchQuote, usMarketSessionInfo } = await import('../lib/market-data.ts');
  const { buildMarketProviderHealth, mergeQuotesWithStaleCache } = await import('../lib/market-resilience.ts');

  const degradedHealth = buildMarketProviderHealth({
    provider: 'tradingview', requestedSymbols: 4, successfulSymbols: 2,
    nowIso: '2026-09-10T09:00:00.000Z', latencyMs: 123.6,
  });
  assert.equal(degradedHealth.status, 'degraded');
  assert.equal(degradedHealth.lastSuccessAt, '2026-09-10T09:00:00.000Z');
  assert.equal(degradedHealth.latencyMs, 124);
  const unavailableHealth = buildMarketProviderHealth({
    provider: 'yahoo_finance', requestedSymbols: 2, successfulSymbols: 0,
    nowIso: '2026-09-10T09:05:00.000Z', latencyMs: 400,
    error: 'geçici hata', previousLastSuccessAt: '2026-09-10T08:59:00.000Z',
  });
  assert.equal(unavailableHealth.status, 'unavailable');
  assert.equal(unavailableHealth.lastSuccessAt, '2026-09-10T08:59:00.000Z');

  const cachedQuote = { symbol: 'FALLBACK', price: 42, currency: 'USD', changePct: 1, asOf: '2026-09-10T08:59:00.000Z', source: 'yahoo_finance' };
  const mergedQuotes = mergeQuotesWithStaleCache(['LIVE', 'FALLBACK', 'MISSING'], [
    { ...cachedQuote, symbol: 'LIVE', price: 50, cacheState: 'live' },
  ], [cachedQuote]);
  assert.deepEqual(mergedQuotes.quotes.map(quote => quote.symbol), ['LIVE', 'FALLBACK']);
  assert.equal(mergedQuotes.quotes[1].cacheState, 'stale');
  assert.deepEqual(mergedQuotes.recoveredSymbols, ['FALLBACK']);
  assert.deepEqual(mergedQuotes.missingSymbols, ['MISSING']);

  const fridayAfterHours = usMarketSessionInfo(new Date('2026-08-28T23:59:00.000Z'));
  assert.equal(fridayAfterHours.session, 'after-hours');
  assert.equal(fridayAfterHours.latestExtendedClose, null);

  const fridayExtendedClose = usMarketSessionInfo(new Date('2026-08-29T00:00:00.000Z'));
  assert.equal(fridayExtendedClose.session, 'closed');
  assert.equal(
    fridayExtendedClose.latestExtendedClose,
    '2026-08-29T00:00:00.000Z',
    'summer-time Friday 20:00 ET must map to Saturday 03:00 in Türkiye',
  );

  const weekend = usMarketSessionInfo(new Date('2026-08-30T16:00:00.000Z'));
  assert.equal(weekend.session, 'closed');
  assert.equal(
    weekend.latestExtendedClose,
    '2026-08-29T00:00:00.000Z',
    'the weekend timestamp must keep the last completed extended-hours close',
  );

  const history = await fetchHistory('RKLB', '6mo');
  assert.equal(history.points.length, 2, 'null close candles must be discarded');
  assert.deepEqual(history.points[0], {
    t: 1_720_000_000,
    date: new Date(1_720_000_000 * 1000).toISOString().slice(0, 10),
    o: 100,
    ohlcComplete: false,
    h: 100,
    l: 100,
    c: 100,
    v: 0,
  });
  assert.ok(history.points.every(point => point.c > 0 && point.o > 0 && point.h > 0 && point.l > 0));

  const benchmark = await fetchBenchmark('MOCK-INDEX', 'SP500');
  assert.equal(benchmark.changePct, 10, 'a missing candle must not become a -100% return');
  assert.equal(benchmark.periods['1m'], null, 'Missing monthly history cannot reuse the daily change');
  assert.equal(benchmark.periods['1y'], null);
  assert.ok(benchmark.chart.every(point => point.c > 0));

  const quote = await fetchQuote('MOCK');
  assert.equal(quote.price, 110, 'quote must fall back to the last positive close');
  assert.equal(quote.changePct, 10);

  globalThis.fetch = async () => new Response(JSON.stringify({ chart: { result: [{
    meta: { currency: 'TRY', exchangeTimezoneName: 'Europe/London' },
    timestamp: [Date.parse('2026-08-30T23:00:00Z') / 1000],
    indicators: { quote: [{ close: [40] }] },
  }] } }), { status: 200 });
  const fxHistory = await fetchHistory('USDTRY=X', '6mo');
  assert.equal(fxHistory.points[0].date, '2026-08-31', 'exchange midnight must keep August 31 even when UTC is August 30');
  globalThis.fetch = async () => new Response(JSON.stringify({ chart: { result: [{
    meta: { currency: 'TRY', exchangeTimezoneName: 'Europe/Istanbul', firstTradeDate: Date.parse('2026-09-01T06:30:00Z') / 1000 },
    timestamp: [Date.parse('2026-09-02T06:30:00Z') / 1000],
    indicators: { quote: [{ close: [60] }] },
  }] } }), { status: 200 });
  const ipoHistory = await fetchHistory('NEW.IS', '6mo');
  assert.equal(ipoHistory.firstTradeDate, '2026-09-01', 'listing date is independent from the first candle in the requested range');
  assert.equal(ipoHistory.points[0].date, '2026-09-02');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('market-data tests passed');
