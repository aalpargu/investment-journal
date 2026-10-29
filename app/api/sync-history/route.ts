import { listPortfolioVersionSummaries, readPortfolioVersion } from '@/lib/cloud-store';
import { getRequestUserId } from '@/lib/request-user';

export const dynamic = 'force-dynamic';

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store, private' },
  });
}

function parseState(stateJson: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(stateJson);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export async function GET(request: Request): Promise<Response> {
  const userId = getRequestUserId(request);
  if (!userId) return json({ error: 'Oturum gerekli.' }, 401);

  const url = new URL(request.url);
  const revisionValue = url.searchParams.get('revision');
  if (revisionValue !== null) {
    const revision = Number(revisionValue);
    if (!Number.isInteger(revision) || revision < 1) return json({ error: 'Geçersiz sürüm.' }, 400);
    const row = await readPortfolioVersion(userId, revision);
    const state = row ? parseState(row.stateJson) : null;
    if (!row || !state) return json({ error: 'Sürüm bulunamadı.' }, 404);
    return json({ revision: row.revision, updatedAt: row.updatedAt, state });
  }

  const versions = await listPortfolioVersionSummaries(userId, 20);
  return json({ versions });
}
