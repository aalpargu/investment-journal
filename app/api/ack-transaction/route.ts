import { acknowledgePendingTransaction } from '@/lib/app-settings';
import { getRequestUserId } from '@/lib/request-user';

export async function POST(request: Request): Promise<Response> {
  const userId = getRequestUserId(request);
  if (!userId) return Response.json({ error: 'Erişim reddedildi.' }, { status: 403 });
  const body = await request.json().catch(() => null) as { id?: unknown; transactionId?: unknown } | null;
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  const transactionId = typeof body?.transactionId === 'string' ? body.transactionId.trim() : '';
  if (!id) return Response.json({ error: 'Bekleyen işlem kimliği gerekli.' }, { status: 400 });
  return Response.json({ ok: true, ...await acknowledgePendingTransaction(userId, id, transactionId) });
}
