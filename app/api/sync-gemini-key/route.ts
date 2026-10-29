import { encryptSecret, readAppSettings, saveAppSettings } from '@/lib/app-settings';
import { getRequestIdentity } from '@/lib/request-user';

export async function POST(request: Request): Promise<Response> {
  const identity = getRequestIdentity(request);
  if (!identity) return Response.json({ error: 'Erişim reddedildi.' }, { status: 403 });
  const body = await request.json().catch(() => null) as { geminiKey?: unknown } | null;
  const key = typeof body?.geminiKey === 'string' ? body.geminiKey.trim() : '';
  if (key.length > 256) return Response.json({ error: 'Gemini anahtarı çok uzun.' }, { status: 400 });
  const current = await readAppSettings(identity.userId);
  if (key) await saveAppSettings(identity.userId, { geminiApiKeyEncrypted: await encryptSecret(key) });
  return Response.json({ ok: true, hasGeminiKey: Boolean(key || current.geminiApiKeyEncrypted), recoveredPreviousConfig: false });
}
