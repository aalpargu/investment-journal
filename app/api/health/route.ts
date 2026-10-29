import { getRequestUserId } from '@/lib/request-user';
import { readAppSettings } from '@/lib/app-settings';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const userId = getRequestUserId(request);
  if (!userId) return Response.json({ error: 'Erişim reddedildi.' }, { status: 403 });
  const settings = await readAppSettings(userId);
  return Response.json({
    ok: true,
    provider: 'cloud',
    version: '11.2',
    cloudSync: true,
    lanEnabled: false,
    telegram: Boolean(settings.telegramBotTokenEncrypted && settings.telegramUserId),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
