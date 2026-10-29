import { cleanSymbols } from '@/lib/market-data';
import { fetchAutomaticFinancialCalendar } from '@/lib/financial-calendar';
import { getRequestUserId } from '@/lib/request-user';

export const dynamic = 'force-dynamic';

function localDateKey(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = (type: string) => parts.find(item => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function edgeCache(): Cache | null {
  try { return (globalThis.caches as CacheStorage & { default?: Cache }).default || null; }
  catch { return null; }
}

export async function GET(request: Request): Promise<Response> {
  if (!getRequestUserId(request)) return Response.json({ error: 'Erişim reddedildi.' }, { status: 403 });
  const url = new URL(request.url);
  const symbols = cleanSymbols(url.searchParams.get('symbols'), 30).filter(symbol => !symbol.endsWith('.IS'));
  const days = Math.max(7, Math.min(180, Number.parseInt(url.searchParams.get('days') || '90', 10) || 90));
  const from = localDateKey();
  if (!symbols.length) return Response.json({ events: [], warnings: [], generatedAt: new Date().toISOString(), trackedSymbols: 0 }, { headers: { 'Cache-Control': 'no-store' } });

  const canonical = new URL('/api/financial-calendar', request.url);
  canonical.searchParams.set('symbols', symbols.slice().sort().join(','));
  canonical.searchParams.set('days', String(days));
  canonical.searchParams.set('from', from);
  canonical.searchParams.set('_calendar_cache', 'v2');
  const cacheRequest = new Request(canonical, { method: 'GET' });
  const cache = edgeCache();
  if (cache) {
    try {
      const cached = await cache.match(cacheRequest);
      if (cached) return Response.json(await cached.json(), { headers: { 'Cache-Control': 'no-store', 'X-Calendar-Cache': 'HIT' } });
    } catch { /* A cache miss/failure must not block a live calendar request. */ }
  }

  try {
    const result = await fetchAutomaticFinancialCalendar(symbols, from, days);
    const payload = {
      ...result,
      generatedAt: new Date().toISOString(),
      trackedSymbols: symbols.length,
      coverage: { usDays: result.usRangeDays },
    };
    if (cache) {
      const cacheResponse = Response.json(payload, { headers: { 'Cache-Control': 'public, max-age=21600' } });
      try { await cache.put(cacheRequest, cacheResponse); } catch { /* Edge cache is optional. */ }
    }
    return Response.json(payload, { headers: { 'Cache-Control': 'no-store', 'X-Calendar-Cache': 'MISS' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Finansal takvim alınamadı.' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
