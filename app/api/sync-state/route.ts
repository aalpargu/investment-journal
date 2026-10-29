import { ensureNormalizedPortfolioState, readPortfolioState, writePortfolioState } from '@/lib/cloud-store';
import { isPortfolioState } from '@/lib/portfolio-state-codec';
import { getRequestUserId } from '@/lib/request-user';

export const dynamic = 'force-dynamic';

const MAX_STATE_BYTES = 20_000_000;

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store, private' },
  });
}

function publicState(row: Awaited<ReturnType<typeof readPortfolioState>>) {
  if (!row) return { exists: false, revision: 0, state: null, updatedAt: null };
  try {
    return {
      exists: true,
      revision: Number(row.revision),
      state: JSON.parse(row.stateJson),
      updatedAt: row.updatedAt,
    };
  } catch {
    return { exists: false, revision: 0, state: null, updatedAt: null };
  }
}

export async function GET(request: Request): Promise<Response> {
  const userId = getRequestUserId(request);
  if (!userId) return json({ error: 'Oturum gerekli.' }, 401);
  const row = await readPortfolioState(userId);
  if (row) await ensureNormalizedPortfolioState(userId).catch(() => false);
  return json(publicState(row));
}

export async function PUT(request: Request): Promise<Response> {
  const userId = getRequestUserId(request);
  if (!userId) return json({ error: 'Oturum gerekli.' }, 401);

  const announcedSize = Number(request.headers.get('content-length') || 0);
  if (announcedSize > MAX_STATE_BYTES) return json({ error: 'Portföy verisi eşitleme sınırını aşıyor.' }, 413);

  let payload: { baseRevision?: unknown; state?: unknown };
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Geçersiz JSON.' }, 400);
  }

  const baseRevision = Number(payload.baseRevision);
  if (!Number.isInteger(baseRevision) || baseRevision < 0 || !isPortfolioState(payload.state)) {
    return json({ error: 'Geçersiz eşitleme verisi.' }, 400);
  }

  const stateJson = JSON.stringify(payload.state);
  if (new TextEncoder().encode(stateJson).byteLength > MAX_STATE_BYTES) {
    return json({ error: 'Portföy verisi eşitleme sınırını aşıyor.' }, 413);
  }

  const result = await writePortfolioState(userId, baseRevision, payload.state);
  if (!result.ok) {
    return json({ error: 'Daha yeni bir bulut kaydı var.', ...publicState(result.current) }, 409);
  }
  return json({ ok: true, exists: true, revision: result.row.revision, updatedAt: result.row.updatedAt });
}
