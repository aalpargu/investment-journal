import {
  decryptSecret,
  encryptSecret,
  randomSecret,
  readAppSettings,
  saveAppSettings,
} from '@/lib/app-settings';
import { getRequestIdentity } from '@/lib/request-user';
import { registerTelegramWebhook } from '@/lib/telegram';

const TOKEN_PATTERN = /^\d{5,16}:[A-Za-z0-9_-]{20,140}$/;
const USER_ID_PATTERN = /^\d{1,24}$/;

export async function POST(request: Request): Promise<Response> {
  const identity = getRequestIdentity(request);
  if (!identity) return Response.json({ error: 'Erişim reddedildi.' }, { status: 403 });
  const body = await request.json().catch(() => null) as { token?: unknown; userId?: unknown; geminiKey?: unknown } | null;
  const tokenInput = typeof body?.token === 'string' ? body.token.trim() : '';
  const userIdInput = typeof body?.userId === 'string' ? body.userId.trim() : '';
  const geminiInput = typeof body?.geminiKey === 'string' ? body.geminiKey.trim() : '';
  if (tokenInput && !TOKEN_PATTERN.test(tokenInput)) return Response.json({ error: 'Telegram bot token biçimi geçersiz.' }, { status: 400 });
  if (userIdInput && !USER_ID_PATTERN.test(userIdInput)) return Response.json({ error: 'Telegram kullanıcı ID yalnızca rakamlardan oluşmalı.' }, { status: 400 });
  if (geminiInput.length > 256) return Response.json({ error: 'Gemini anahtarı çok uzun.' }, { status: 400 });
  const current = await readAppSettings(identity.userId);
  const token = tokenInput || await decryptSecret(current.telegramBotTokenEncrypted);
  const telegramUserId = userIdInput || current.telegramUserId;
  const webhookId = current.telegramWebhookId || randomSecret(24);
  const webhookSecret = current.telegramWebhookSecretEncrypted ? await decryptSecret(current.telegramWebhookSecretEncrypted) : randomSecret(32);
  if (token && telegramUserId && !identity.local) {
    try {
      await registerTelegramWebhook(token, `${new URL(request.url).origin}/api/telegram-webhook?id=${encodeURIComponent(webhookId)}`, webhookSecret);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Telegram webhook kurulamadı.' }, { status: 502 });
    }
  }
  await saveAppSettings(identity.userId, {
    telegramBotTokenEncrypted: tokenInput ? await encryptSecret(tokenInput) : current.telegramBotTokenEncrypted,
    telegramUserId,
    telegramWebhookId: token && telegramUserId ? webhookId : current.telegramWebhookId,
    telegramWebhookSecretEncrypted: token && telegramUserId ? await encryptSecret(webhookSecret) : current.telegramWebhookSecretEncrypted,
    geminiApiKeyEncrypted: geminiInput ? await encryptSecret(geminiInput) : current.geminiApiKeyEncrypted,
  });
  return Response.json({ ok: true, active: Boolean(token && telegramUserId && !identity.local), recoveredPreviousConfig: false });
}
