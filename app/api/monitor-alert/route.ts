import { decryptSecret, readAppSettings } from '@/lib/app-settings';
import { getRequestUserId } from '@/lib/request-user';
import { sendTelegramPlainText } from '@/lib/telegram';

export const dynamic = 'force-dynamic';

type AlertKind = 'test' | 'alert' | 'recovery';
type AlertItem = { label: string; detail?: string };

function text(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function messageFor(kind: AlertKind, items: AlertItem[]): string {
  if (kind === 'test') {
    return '✅ Yatırım Defterim izleme sistemi hazır. Site, bulut eşitleme verisi ve yedekler kontrol ediliyor.';
  }
  const title = kind === 'alert'
    ? '⚠️ Yatırım Defterim uyarısı'
    : '✅ Yatırım Defterim sorunu düzeldi';
  const lines = items.map(item => kind === 'alert' && item.detail
    ? `• ${item.label}: ${item.detail}`
    : `• ${item.label}`);
  return `${title}\n\n${lines.join('\n')}`;
}

export async function POST(request: Request): Promise<Response> {
  const userId = getRequestUserId(request);
  if (!userId) return Response.json({ error: 'Erişim reddedildi.' }, { status: 403 });

  let body: { kind?: unknown; items?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Geçersiz JSON.' }, { status: 400 });
  }
  const kind = body.kind;
  if (kind !== 'test' && kind !== 'alert' && kind !== 'recovery') {
    return Response.json({ error: 'Geçersiz bildirim türü.' }, { status: 400 });
  }
  const rawItems = Array.isArray(body.items) ? body.items.slice(0, 8) : [];
  const items = rawItems.flatMap(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    const label = text(row.label, 80);
    if (!label) return [];
    return [{ label, detail: text(row.detail, 240) }];
  });
  if (kind !== 'test' && items.length === 0) {
    return Response.json({ error: 'Bildirim ayrıntısı eksik.' }, { status: 400 });
  }

  const settings = await readAppSettings(userId);
  if (!settings.telegramBotTokenEncrypted || !settings.telegramUserId) {
    return Response.json({ error: 'Telegram ayarı etkin değil.' }, { status: 503 });
  }
  await sendTelegramPlainText(
    await decryptSecret(settings.telegramBotTokenEncrypted),
    settings.telegramUserId,
    messageFor(kind, items),
  );
  return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
