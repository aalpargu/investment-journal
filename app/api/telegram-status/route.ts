import { listPendingTransactions, readAppSettings } from '@/lib/app-settings';
import { getRequestIdentity } from '@/lib/request-user';

export async function GET(request: Request): Promise<Response> {
  const identity = getRequestIdentity(request);
  if (!identity) return Response.json({ error: 'Erişim reddedildi.' }, { status: 403 });
  const settings = await readAppSettings(identity.userId);
  const pending = await listPendingTransactions(identity.userId);
  let diagnostics = {};
  try { diagnostics = settings.telegramDiagnosticsJson ? JSON.parse(settings.telegramDiagnosticsJson) : {}; } catch { diagnostics = {}; }
  return Response.json({
    ok: true,
    active: Boolean(settings.telegramBotTokenEncrypted && settings.telegramUserId && settings.telegramWebhookId),
    hasToken: Boolean(settings.telegramBotTokenEncrypted),
    userId: settings.telegramUserId,
    hasGeminiKey: Boolean(settings.geminiApiKeyEncrypted),
    pendingCount: pending.length,
    cloudMode: true,
    diagnostics,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
