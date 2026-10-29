import { readAppSettings } from '@/lib/app-settings';
import { getRequestIdentity } from '@/lib/request-user';
import { validSecContactEmail } from '@/lib/sec-fundamentals';

export async function GET(request: Request): Promise<Response> {
  const identity = getRequestIdentity(request);
  if (!identity) return Response.json({ error: 'Erişim reddedildi.' }, { status: 403 });
  const settings = await readAppSettings(identity.userId);
  return Response.json({
    ok: true,
    hasContactEmail: validSecContactEmail(settings.secContactEmail) || validSecContactEmail(identity.email),
    cloudMode: true,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
