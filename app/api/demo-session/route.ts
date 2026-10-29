import { getRequestIdentity } from '@/lib/request-user';
export async function GET(request: Request): Promise<Response> {
  const user = getRequestIdentity(request);
  if (!user) return Response.json({ error: 'Oturum gerekli.' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  return Response.json({ storageScope: `investment-demo:${encodeURIComponent(user.userId)}:` }, { headers: { 'Cache-Control': 'no-store, private' } });
}
