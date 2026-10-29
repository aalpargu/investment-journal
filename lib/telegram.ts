import {
  claimTelegramUpdate,
  decryptSecret,
  insertPendingTransactions,
  readAppSettingsByWebhookId,
  releaseTelegramUpdate,
  saveAppSettings,
  type AppSettings,
} from '@/lib/app-settings';
import { extractTransactionsFromImage, FundCodeRequiredError } from '@/lib/gemini';

type JsonObject = { [key: string]: unknown };

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function scalarText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}`;
  if (typeof value === 'bigint') return `${value}`;
  return '';
}

export async function telegramRequest(method: string, token: string, payload: JsonObject = {}): Promise<JsonObject> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(25_000),
  });
  const data = object(await response.json().catch(() => ({})));
  if (!response.ok || data.ok !== true) throw new Error(scalarText(data.description) || `Telegram isteği başarısız oldu (HTTP ${response.status}).`);
  return data;
}

export async function registerTelegramWebhook(token: string, webhookUrl: string, secret: string): Promise<void> {
  await telegramRequest('setWebhook', token, {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ['message'],
    drop_pending_updates: false,
  });
}

async function sendMessage(token: string, chatId: string, text: string): Promise<void> {
  if (!chatId) return;
  await telegramRequest('sendMessage', token, { chat_id: chatId, text, parse_mode: 'HTML' }).catch(() => undefined);
}

export async function sendTelegramPlainText(token: string, chatId: string, text: string): Promise<void> {
  if (!chatId) throw new Error('Telegram kullanici/chat ID bulunamadi.');
  await telegramRequest('sendMessage', token, { chat_id: chatId, text });
}

function sameSecret(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function mimeFromFile(filePath: string, declared = ''): string {
  const normalized = declared.toLowerCase();
  if (['image/jpeg', 'image/png', 'image/webp'].includes(normalized)) return normalized;
  const extension = filePath.split('.').at(-1)?.toLowerCase();
  return extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg';
}

async function recordDiagnostic(settings: AppSettings, status: string, model = '', error = ''): Promise<void> {
  await saveAppSettings(settings.userId, {
    telegramDiagnosticsJson: JSON.stringify({ status, model, error: error.slice(0, 240), updatedAt: new Date().toISOString() }),
  });
}

export async function handleTelegramWebhook(request: Request): Promise<Response> {
  const webhookId = new URL(request.url).searchParams.get('id')?.trim() || '';
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(webhookId)) return new Response('Not found', { status: 404 });
  const settings = await readAppSettingsByWebhookId(webhookId);
  if (!settings?.telegramWebhookSecretEncrypted || !settings.telegramBotTokenEncrypted) return new Response('Not found', { status: 404 });
  const providedSecret = request.headers.get('x-telegram-bot-api-secret-token') || '';
  const expectedSecret = await decryptSecret(settings.telegramWebhookSecretEncrypted);
  if (!sameSecret(providedSecret, expectedSecret)) return new Response('Forbidden', { status: 403 });
  const update = object(await request.json().catch(() => ({})));
  const updateId = Number(update.update_id);
  if (!Number.isInteger(updateId) || updateId < 0) return new Response('Bad request', { status: 400 });
  if (!await claimTelegramUpdate(settings.userId, updateId)) return Response.json({ ok: true, duplicate: true });

  const token = await decryptSecret(settings.telegramBotTokenEncrypted);
  const message = object(update.message);
  const fromId = scalarText(object(message.from).id);
  const chatId = scalarText(object(message.chat).id);
  if (!fromId || fromId !== settings.telegramUserId) return Response.json({ ok: true, ignored: true });
  try {
    const messageText = scalarText(message.text).trim().toLowerCase();
    if (messageText === '/start') {
      await sendMessage(token, chatId, '👋 <b>Yatırım Defterim Botu Hazır!</b>\n\nMidas işlem ekran görüntüsünü fotoğraf olarak gönder; işlem web uygulamasında onayına sunulsun.');
      return Response.json({ ok: true });
    }
    const photos = Array.isArray(message.photo) ? message.photo.map(object) : [];
    const document = object(message.document);
    let fileId = '';
    let declaredMime = '';
    if (photos.length) {
      const best = photos.toSorted((left, right) => Number(right.file_size || 0) - Number(left.file_size || 0))[0];
      fileId = scalarText(best.file_id);
    } else if (scalarText(document.mime_type).toLowerCase().startsWith('image/')) {
      fileId = scalarText(document.file_id);
      declaredMime = scalarText(document.mime_type);
    } else {
      await sendMessage(token, chatId, '📷 Lütfen işlem ekran görüntüsünü fotoğraf veya PNG/JPG dosyası olarak gönderin.');
      return Response.json({ ok: true });
    }
    if (!settings.geminiApiKeyEncrypted) {
      await sendMessage(token, chatId, '⚠️ <b>Gemini API anahtarı bulunamadı.</b>\nWeb uygulamasında Ayarlar → Yapay Zekâ bölümünden anahtarı kaydedin.');
      return Response.json({ ok: true });
    }
    await sendMessage(token, chatId, '⏳ Ekran görüntüsü analiz ediliyor…');
    const fileInfo = await telegramRequest('getFile', token, { file_id: fileId });
    const filePath = scalarText(object(fileInfo.result).file_path);
    if (!filePath) throw new Error('Telegram görsel yolu döndürmedi.');
    const fileResponse = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, { signal: AbortSignal.timeout(30_000) });
    if (!fileResponse.ok) throw new Error('Telegram görseli indirilemedi.');
    const announcedSize = Number(fileResponse.headers.get('content-length') || 0);
    if (announcedSize > 20 * 1024 * 1024) throw new Error('Telegram görseli 20 MB sınırını aşıyor.');
    const image = new Uint8Array(await fileResponse.arrayBuffer());
    if (image.byteLength > 20 * 1024 * 1024) throw new Error('Telegram görseli 20 MB sınırını aşıyor.');
    const { transactions, model } = await extractTransactionsFromImage(
      image,
      mimeFromFile(filePath, declaredMime),
      await decryptSecret(settings.geminiApiKeyEncrypted),
      scalarText(message.caption),
    );
    if (transactions.some(transaction => transaction.type === 'IPO_BUY' && transaction.tickerPending === true)) {
      await recordDiagnostic(settings, 'ipo_code_missing', model);
      await sendMessage(token, chatId, '⚠️ Halka arz işlemi bulundu ancak hisse kodu görünmüyor. Fotoğrafı <code>kod: CITAS</code> benzeri bir açıklamayla yeniden gönderin.');
      return Response.json({ ok: true });
    }
    if (!transactions.length) {
      await recordDiagnostic(settings, 'no_transaction', model);
      await sendMessage(token, chatId, 'ℹ️ Görsel işlendi ancak güvenle kaydedilebilecek tamamlanmış bir işlem bulunamadı.');
      return Response.json({ ok: true });
    }
    const groupId = `tg_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const queued = transactions.map((transaction, index) => ({ ...transaction, _pendingTransactionId: `${groupId}_${index}` }));
    await insertPendingTransactions(settings.userId, { id: groupId, source: 'telegram', model, receivedAt: new Date().toISOString(), transactions: queued });
    await recordDiagnostic(settings, 'success', model);
    const summary = transactions.map(transaction => {
      const kind = transaction.type === 'BUY' ? '🟢 ALIŞ' : transaction.type === 'SELL' ? '🔴 SATIŞ' : '🟣 HALKA ARZ';
      const currency = transaction.market === 'BIST' || transaction.market === 'FON' ? '₺' : '$';
      const quotedPrice = scalarText(transaction.quotedPrice) || scalarText(transaction.price) || '?';
      const fee = scalarText(transaction.fee) || '0';
      const total = scalarText(transaction.total) || '?';
      const totalLabel = transaction.type === 'SELL' ? 'Net toplam' : 'Toplam ödeme';
      return `${kind} <b>${scalarText(transaction.symbol) || '?'}</b> (${scalarText(transaction.market) || '?'})\n   • Adet: ${scalarText(transaction.quantity) || '?'}\n   • Fiyat: ${currency}${quotedPrice}\n   • İşlem ücreti: ${currency}${fee}\n   • ${totalLabel}: ${currency}${total}`;
    }).join('\n\n');
    await sendMessage(token, chatId, `✅ <b>${transactions.length} işlem tespit edildi!</b>\n\n${summary}\n\n👉 Web uygulamasındaki bildirimi onaylayarak portföye ekleyebilirsiniz.`);
    return Response.json({ ok: true });
  } catch (error) {
    await releaseTelegramUpdate(settings.userId, updateId);
    await recordDiagnostic(settings, 'error', '', error instanceof Error ? error.message : 'Beklenmeyen hata');
    await sendMessage(token, chatId, error instanceof FundCodeRequiredError
      ? '⚠️ Fon işlemi okundu ancak fon kodu görselde yok. Fotoğrafı <code>kod: FONKODU</code> açıklamasıyla yeniden gönderin.'
      : '⚠️ Görsel işlendi ancak doğrulanmış işlem verisi üretilemedi. Lütfen işlem satırlarının tamamı görünecek şekilde tekrar gönderin.');
    return Response.json({ ok: false }, { status: 500 });
  }
}
