import type { MarketQuote } from '@/lib/market-data';

export type MarketProvider = 'tradingview' | 'yahoo_finance';
export type MarketProviderState = 'healthy' | 'degraded' | 'unavailable';
export type MarketCacheState = 'live' | 'fresh' | 'partial-stale' | 'stale';

export type MarketProviderHealth = {
  provider: MarketProvider;
  status: MarketProviderState;
  requestedSymbols: number;
  successfulSymbols: number;
  lastSuccessAt: string | null;
  lastError: string | null;
  latencyMs: number;
};

export type MarketStatus = {
  lastSuccessfulAt: string | null;
  cache: { status: MarketCacheState; ageSeconds: number };
  sources: Record<MarketProvider, MarketProviderHealth>;
};

type ProviderHealthInput = {
  provider: MarketProvider;
  requestedSymbols: number;
  successfulSymbols: number;
  nowIso: string;
  latencyMs: number;
  error?: string | null;
  previousLastSuccessAt?: string | null;
};

export function buildMarketProviderHealth(input: ProviderHealthInput): MarketProviderHealth {
  const requested = Math.max(0, Math.trunc(input.requestedSymbols));
  const successful = Math.min(requested, Math.max(0, Math.trunc(input.successfulSymbols)));
  const status: MarketProviderState = successful === requested && requested > 0
    ? 'healthy'
    : successful > 0
      ? 'degraded'
      : 'unavailable';
  return {
    provider: input.provider,
    status,
    requestedSymbols: requested,
    successfulSymbols: successful,
    lastSuccessAt: successful > 0 ? input.nowIso : input.previousLastSuccessAt || null,
    lastError: status === 'healthy' ? null : (input.error?.trim() || `${requested - successful} sembol alınamadı.`).slice(0, 240),
    latencyMs: Math.max(0, Math.round(input.latencyMs)),
  };
}

export function mergeQuotesWithStaleCache(
  symbols: string[],
  liveQuotes: MarketQuote[],
  cachedQuotes: MarketQuote[],
): { quotes: MarketQuote[]; recoveredSymbols: string[]; missingSymbols: string[] } {
  const liveBySymbol = new Map(liveQuotes.map(quote => [quote.symbol, quote]));
  const cachedBySymbol = new Map(cachedQuotes.map(quote => [quote.symbol, quote]));
  const quotes: MarketQuote[] = [];
  const recoveredSymbols: string[] = [];
  const missingSymbols: string[] = [];
  for (const symbol of symbols) {
    const live = liveBySymbol.get(symbol);
    if (live) {
      quotes.push(live);
      continue;
    }
    const cached = cachedBySymbol.get(symbol);
    if (cached && Number.isFinite(Number(cached.price)) && Number(cached.price) > 0) {
      quotes.push({ ...cached, cacheState: 'stale' });
      recoveredSymbols.push(symbol);
      continue;
    }
    missingSymbols.push(symbol);
  }
  return { quotes, recoveredSymbols, missingSymbols };
}
