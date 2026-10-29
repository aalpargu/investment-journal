import { saveAppSettings } from '@/lib/app-settings';
import { getRequestIdentity } from '@/lib/request-user';
import { validSecContactEmail } from '@/lib/sec-fundamentals';

export async function POST(request: Request): Promise<Response> {
  const identity = getRequestIdentity(request);
  if (!identity) return Response.json({ error: 'Erişim reddedildi.' }, { status: 403 });
  const body = await request.json().catch(() => null) as { contactEmail?: unknown } | null;
  const contactEmail = typeof body?.contactEmail === 'string' ? body.contactEmail.trim().toLowerCase() : '';
  if (!validSecContactEmail(contactEmail)) return Response.json({ error: 'Geçerli bir SEC iletişim e-postası gerekli.' }, { status: 400 });
  await saveAppSettings(identity.userId, { secContactEmail: contactEmail });
  return Response.json({ ok: true, hasContactEmail: true, recoveredPreviousConfig: false });
}
