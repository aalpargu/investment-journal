import { listPendingTransactions } from '@/lib/app-settings';
import { getRequestUserId } from '@/lib/request-user';

export async function GET(request: Request): Promise<Response> {
  const userId = getRequestUserId(request);
  if (!userId) return Response.json({ error: 'Erişim reddedildi.' }, { status: 403 });
  return Response.json({ pending: await listPendingTransactions(userId) }, { headers: { 'Cache-Control': 'no-store' } });
}
