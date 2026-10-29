import { decryptSecret, readAppSettings } from '@/lib/app-settings';
import { geminiRequest, validateGeminiModel } from '@/lib/gemini';
import { getRequestIdentity } from '@/lib/request-user';

export async function POST(request: Request): Promise<Response> {
  const identity = getRequestIdentity(request);
  if (!identity) return Response.json({ error: 'Erişim reddedildi.' }, { status: 403 });
  const announcedSize = Number(request.headers.get('content-length') || 0);
  if (announcedSize > 25 * 1024 * 1024) return Response.json({ error: 'İstek gövdesi izin verilen boyutu aşıyor.' }, { status: 413 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const model = validateGeminiModel(body?.model);
  const contents = body?.contents;
  if (!model || !Array.isArray(contents) || !contents.length) return Response.json({ error: 'Geçerli model ve içerik gerekli.' }, { status: 400 });
  const settings = await readAppSettings(identity.userId);
  if (!settings.geminiApiKeyEncrypted) return Response.json({ error: 'Gemini API anahtarı yapılandırılmamış.' }, { status: 400 });
  const requested = body?.generationConfig && typeof body.generationConfig === 'object' ? body.generationConfig as Record<string, unknown> : {};
  const temperature = Math.min(1, Math.max(0, Number(requested.temperature) || 0.2));
  const maxOutputTokens = Math.min(4096, Math.max(64, Math.trunc(Number(requested.maxOutputTokens) || 2048)));
  try {
    return Response.json(await geminiRequest(`models/${model}:generateContent`, await decryptSecret(settings.geminiApiKeyEncrypted), {
      contents,
      generationConfig: { temperature, maxOutputTokens },
    }));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Gemini isteği başarısız oldu.' }, { status: 502 });
  }
}
