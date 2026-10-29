import { decryptSecret, readAppSettings } from '@/lib/app-settings';
import { geminiRequest } from '@/lib/gemini';
import { getRequestIdentity } from '@/lib/request-user';

export async function GET(request: Request): Promise<Response> {
  const identity = getRequestIdentity(request);
  if (!identity) return Response.json({ error: 'Erişim reddedildi.' }, { status: 403 });
  const settings = await readAppSettings(identity.userId);
  if (!settings.geminiApiKeyEncrypted) return Response.json({ models: [], hasGeminiKey: false }, { status: 400 });
  try {
    const payload = await geminiRequest('models', await decryptSecret(settings.geminiApiKeyEncrypted));
    const models = Array.isArray(payload.models) ? payload.models.flatMap(value => {
      const model = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      return [{
        name: typeof model.name === 'string' ? model.name : '',
        displayName: typeof model.displayName === 'string' ? model.displayName : '',
        supportedGenerationMethods: Array.isArray(model.supportedGenerationMethods) ? model.supportedGenerationMethods : [],
      }];
    }) : [];
    return Response.json({ models, hasGeminiKey: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Gemini model listesi alınamadı.', models: [], hasGeminiKey: true }, { status: 502 });
  }
}
