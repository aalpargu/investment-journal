import { readAppSettings } from '@/lib/app-settings';
import { getRequestIdentity } from '@/lib/request-user';
import { fetchSecFundamentals, validSecContactEmail } from '@/lib/sec-fundamentals';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const identity = getRequestIdentity(request);
  if (!identity) return Response.json({ error: 'Erişim reddedildi.' }, { status: 403 });
  const symbol = new URL(request.url).searchParams.get('symbol')?.trim().toUpperCase() || '';
  if (!symbol || symbol.endsWith('.IS')) return Response.json({ error: 'SEC temel analizi yalnızca ABD hisseleri için kullanılabilir.' }, { status: 400 });
  const settings = await readAppSettings(identity.userId);
  const contactEmail = validSecContactEmail(settings.secContactEmail) ? settings.secContactEmail : identity.email;
  try {
    return Response.json(await fetchSecFundamentals(symbol, contactEmail), {
      headers: { 'Cache-Control': 'private, max-age=300' },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'SEC finansalları alınamadı.' }, { status: 502 });
  }
}
