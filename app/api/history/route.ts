import { cleanSymbols, fetchHistory, validPeriod } from '@/lib/market-data';
import { getRequestUserId } from '@/lib/request-user';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  if (!getRequestUserId(request)) return Response.json({ error: 'Erişim reddedildi.' }, { status: 403 });
  const url = new URL(request.url);
  const symbol = cleanSymbols(url.searchParams.get('symbol'), 1)[0];
  const period = url.searchParams.get('period') || '6mo';
  if (!symbol || !validPeriod(period)) return Response.json({ error: 'Geçerli sembol veya periyot yok.' }, { status: 400 });
  try {
    return Response.json(await fetchHistory(symbol, period), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Geçmiş fiyat verisi alınamadı.' }, { status: 502 });
  }
}
