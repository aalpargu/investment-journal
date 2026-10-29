import { handleTelegramWebhook } from '@/lib/telegram';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleTelegramWebhook(request);
}
