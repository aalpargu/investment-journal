import { cleanSymbols, fetchBenchmark, fetchQuote, fetchTradingViewSnapshot, fetchUsdTry } from '@/lib/market-data';
import type { MarketQuote, TradingViewSnapshot } from '@/lib/market-data';
import {
  buildMarketProviderHealth,
  mergeQuotesWithStaleCache,
} from '@/lib/market-resilience';
import type { MarketProviderHealth, MarketStatus } from '@/lib/market-resilience';
import { getRequestUserId } from '@/lib/request-user';

export const dynamic = 'force-dynamic';

const EDGE_FRESH_MS = 30_000;
const EDGE_STALE_SECONDS = 30 * 60;

type QuoteError = { symbol: string; message: string };
type QuoteWarning = { symbol: string; message: string };
type QuotePayload = {
  quotes: MarketQuote[];
  errors: QuoteError[];
  warnings: QuoteWarning[];
  fxUsdTry: number | null;
  benchmarks: Record<string, unknown>;
  cached: boolean;
  generatedAt: string;
  marketStatus: MarketStatus;
};

type TimedResult<T> =
  | { ok: true; value: T; latencyMs: number }
  | { ok: false; error: unknown; latencyMs: number };

async function timed<T>(operation: Promise<T>): Promise<TimedResult<T>> {
  const startedAt = Date.now();
  try {
    return { ok: true, value: await operation, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, error, latencyMs: Date.now() - startedAt };
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message.trim() : fallback;
}

function edgeCache(): Cache | null {
  try {
    return (globalThis.caches as CacheStorage & { default?: Cache }).default || null;
  } catch {
    return null;
  }
}

function validCachedPayload(value: unknown): value is QuotePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Partial<QuotePayload>;
  return Array.isArray(payload.quotes)
    && typeof payload.generatedAt === 'string'
    && Number.isFinite(Date.parse(payload.generatedAt))
    && Boolean(payload.marketStatus?.sources);
}

function responseJson(payload: QuotePayload): Response {
  return Response.json(payload, { headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(request: Request): Promise<Response> {
  if (!getRequestUserId(request)) return Response.json({ error: 'Erişim reddedildi.' }, { status: 403 });
  const symbols = cleanSymbols(new URL(request.url).searchParams.get('symbols'));
  if (!symbols.length) {
    return Response.json({ quotes: [], errors: [{ message: 'Geçerli sembol yok.' }] }, { status: 400 });
  }

  const canonicalUrl = new URL('/api/quotes', request.url);
  canonicalUrl.searchParams.set('symbols', symbols.slice().sort().join(','));
  canonicalUrl.searchParams.set('_market_cache', 'v2');
  const cacheRequest = new Request(canonicalUrl, { method: 'GET' });
  const cache = edgeCache();
  let cachedPayload: QuotePayload | null = null;
  if (cache) {
    try {
      const cachedResponse = await cache.match(cacheRequest);
      const candidate = cachedResponse ? await cachedResponse.json() : null;
      if (validCachedPayload(candidate)) cachedPayload = candidate;
    } catch { /* Cache failures must not block live providers. */ }
  }
  let cachedAgeMs = cachedPayload ? Math.max(0, Date.now() - Date.parse(cachedPayload.generatedAt)) : 0;
  if (cachedPayload && cachedAgeMs > EDGE_STALE_SECONDS * 1000) {
    cachedPayload = null;
    cachedAgeMs = 0;
  }
  if (cachedPayload && cachedAgeMs <= EDGE_FRESH_MS) {
    return responseJson({
      ...cachedPayload,
      quotes: cachedPayload.quotes.map(quote => ({ ...quote, cacheState: 'fresh' })),
      cached: true,
      marketStatus: {
        ...cachedPayload.marketStatus,
        cache: { status: 'fresh', ageSeconds: Math.round(cachedAgeMs / 1000) },
      },
    });
  }

  const [tradingViewResult, quoteBatchResult, fxResult, xuResult, spResult] = await Promise.all([
    timed(fetchTradingViewSnapshot(symbols)),
    timed(Promise.allSettled(symbols.map(fetchQuote))),
    timed(fetchUsdTry()),
    timed(fetchBenchmark('XU100.IS', 'XU100')),
    timed(fetchBenchmark('^GSPC', 'SP500')),
  ]);
  const tradingView: TradingViewSnapshot = tradingViewResult.ok
    ? tradingViewResult.value
    : { quotes: {}, fxUsdTry: null };
  const quoteResults = quoteBatchResult.ok
    ? quoteBatchResult.value
    : symbols.map(() => ({ status: 'rejected', reason: quoteBatchResult.error } as PromiseRejectedResult));
  const generatedAt = new Date().toISOString();
  const liveQuotes: MarketQuote[] = [];
  const errors: QuoteError[] = [];
  quoteResults.forEach((result, index) => {
    const symbol = symbols[index];
    const tvQuote = tradingView.quotes[symbol];
    if (tvQuote && result.status === 'fulfilled') {
      const yahooQuote = result.value;
      liveQuotes.push({
        ...tvQuote,
        changePct: tvQuote.changePct === 0 && yahooQuote.changePct !== 0 ? yahooQuote.changePct : tvQuote.changePct,
        logoid: tvQuote.logoid || yahooQuote.logoid,
        cacheState: 'live',
        retrievedAt: generatedAt,
      });
    } else if (tvQuote) {
      liveQuotes.push({ ...tvQuote, cacheState: 'live', retrievedAt: generatedAt });
    } else if (result.status === 'fulfilled') {
      liveQuotes.push({ ...result.value, cacheState: 'live', retrievedAt: generatedAt });
    } else {
      errors.push({ symbol, message: result.reason instanceof Error ? result.reason.message : 'Fiyat alınamadı.' });
    }
  });

  const merged = mergeQuotesWithStaleCache(symbols, liveQuotes, cachedPayload?.quotes || []);
  const recovered = new Set(merged.recoveredSymbols);
  const finalErrors = errors.filter(error => !recovered.has(error.symbol));
  const warnings = merged.recoveredSymbols.map(symbol => ({
    symbol,
    message: 'Canlı kaynaklara ulaşılamadı; son başarılı fiyat önbellekten gösteriliyor.',
  }));
  const previousSources = cachedPayload?.marketStatus.sources;
  const tvSuccesses = Object.keys(tradingView.quotes).filter(symbol => symbols.includes(symbol)).length;
  const yahooSuccesses = quoteResults.filter(result => result.status === 'fulfilled').length;
  const firstYahooFailure = quoteResults.find(result => result.status === 'rejected') as PromiseRejectedResult | undefined;
  const sources: Record<'tradingview' | 'yahoo_finance', MarketProviderHealth> = {
    tradingview: buildMarketProviderHealth({
      provider: 'tradingview',
      requestedSymbols: symbols.length,
      successfulSymbols: tvSuccesses,
      nowIso: generatedAt,
      latencyMs: tradingViewResult.latencyMs,
      error: tradingViewResult.ok ? null : errorMessage(tradingViewResult.error, 'TradingView yanıt vermedi.'),
      previousLastSuccessAt: previousSources?.tradingview?.lastSuccessAt,
    }),
    yahoo_finance: buildMarketProviderHealth({
      provider: 'yahoo_finance',
      requestedSymbols: symbols.length,
      successfulSymbols: yahooSuccesses,
      nowIso: generatedAt,
      latencyMs: quoteBatchResult.latencyMs,
      error: firstYahooFailure ? errorMessage(firstYahooFailure.reason, 'Yahoo Finance yanıt vermedi.') : null,
      previousLastSuccessAt: previousSources?.yahoo_finance?.lastSuccessAt,
    }),
  };
  const cacheStatus = merged.recoveredSymbols.length
    ? (liveQuotes.length ? 'partial-stale' : 'stale')
    : 'live';
  const marketStatus: MarketStatus = {
    lastSuccessfulAt: liveQuotes.length > 0
      ? generatedAt
      : cachedPayload?.marketStatus.lastSuccessfulAt || null,
    cache: {
      status: cacheStatus,
      ageSeconds: merged.recoveredSymbols.length ? Math.round(cachedAgeMs / 1000) : 0,
    },
    sources,
  };
  const payload: QuotePayload = {
    quotes: merged.quotes,
    errors: finalErrors,
    warnings,
    fxUsdTry: tradingView.fxUsdTry ?? (fxResult.ok ? fxResult.value : null),
    benchmarks: {
      ...(xuResult.ok ? { XU100: xuResult.value } : {}),
      ...(spResult.ok ? { SP500: spResult.value } : {}),
    },
    cached: merged.recoveredSymbols.length > 0,
    generatedAt,
    marketStatus,
  };

  if (cache && merged.recoveredSymbols.length === 0 && merged.missingSymbols.length === 0) {
    try {
      await cache.put(cacheRequest, Response.json(payload, {
        headers: { 'Cache-Control': `public, max-age=${EDGE_STALE_SECONDS}` },
      }));
    } catch { /* A live response remains valid when edge caching is unavailable. */ }
  }

  return responseJson(payload);
}
