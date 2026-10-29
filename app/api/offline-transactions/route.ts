import {
  readAppliedSyncOperation,
  readPortfolioState,
  recordAppliedSyncOperation,
  writePortfolioState,
} from '@/lib/cloud-store';
import { applyOfflineTransactionOperation, parseOfflineTransactionOperation } from '@/lib/offline-transaction';
import { isPortfolioState, type PortfolioState } from '@/lib/portfolio-state-codec';
import { getRequestUserId } from '@/lib/request-user';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 20_500_000;
const OPERATION_ID_PATTERN = /^[a-zA-Z0-9_.:-]{8,180}$/;

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store, private' },
  });
}

function parseStoredState(stateJson: string): PortfolioState | null {
  try {
    const state = JSON.parse(stateJson);
    return isPortfolioState(state) ? state : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  const userId = getRequestUserId(request);
  if (!userId) return json({ error: 'Oturum gerekli.' }, 401);

  const announcedSize = Number(request.headers.get('content-length') || 0);
  if (announcedSize > MAX_BODY_BYTES) return json({ error: 'Çevrimdışı işlem verisi sınırı aşıyor.' }, 413);

  let payload: { operationId?: unknown; operation?: unknown; fallbackState?: unknown };
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Geçersiz JSON.' }, 400);
  }

  const operationId = typeof payload.operationId === 'string' ? payload.operationId.trim() : '';
  const operation = parseOfflineTransactionOperation(payload.operation);
  if (!OPERATION_ID_PATTERN.test(operationId) || !operation) {
    return json({ error: 'Geçersiz çevrimdışı işlem.' }, 400);
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const currentRow = await readPortfolioState(userId);
    if (await readAppliedSyncOperation(userId, operationId)) {
      if (!currentRow) return json({ error: 'İşlem kaydı bulundu ancak portföy okunamadı.' }, 503);
      return json({
        ok: true,
        duplicate: true,
        revision: currentRow.revision,
        state: parseStoredState(currentRow.stateJson),
        updatedAt: currentRow.updatedAt,
      });
    }

    if (!currentRow) {
      if (!isPortfolioState(payload.fallbackState)) {
        return json({ error: 'İlk eşitleme için geçerli portföy durumu gerekli.' }, 409);
      }
      const created = await writePortfolioState(userId, 0, payload.fallbackState);
      if (!created.ok) continue;
      await recordAppliedSyncOperation(userId, operationId, created.row.revision);
      return json({
        ok: true,
        revision: created.row.revision,
        state: parseStoredState(created.row.stateJson),
        updatedAt: created.row.updatedAt,
      });
    }

    const currentState = parseStoredState(currentRow.stateJson);
    if (!currentState) return json({ error: 'Bulut portföy kaydı okunamadı.' }, 503);
    const applied = applyOfflineTransactionOperation(currentState, operation);
    if (!applied.changed) {
      await recordAppliedSyncOperation(userId, operationId, currentRow.revision);
      return json({
        ok: true,
        duplicate: true,
        revision: currentRow.revision,
        state: currentState,
        updatedAt: currentRow.updatedAt,
      });
    }
    if (!isPortfolioState(applied.state)) return json({ error: 'İşlem portföy doğrulamasından geçmedi.' }, 400);

    const written = await writePortfolioState(userId, currentRow.revision, applied.state);
    if (!written.ok) continue;
    await recordAppliedSyncOperation(userId, operationId, written.row.revision);
    return json({
      ok: true,
      revision: written.row.revision,
      state: parseStoredState(written.row.stateJson),
      updatedAt: written.row.updatedAt,
    });
  }

  return json({ error: 'Bulut kaydı aynı anda değişti; işlem kuyrukta korunuyor.' }, 409);
}
