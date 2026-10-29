import { env } from 'cloudflare:workers';
import {
  COLLECTION_NAMES,
  createStorageMarker,
  diffTransactions,
  joinPortfolioState,
  parsePortfolioState,
  readStorageMarker,
  splitPortfolioState,
  type CollectionName,
  type PortfolioState,
} from '@/lib/portfolio-state-codec';

export type StoredPortfolioState = {
  userId: string;
  revision: number;
  stateJson: string;
  updatedAt: string;
};

export type StoredPortfolioVersion = StoredPortfolioState;

export type StoredPortfolioVersionSummary = {
  revision: number;
  updatedAt: string;
  transactions: number;
  watchlist: number;
  journal: number;
};

type RawPortfolioState = StoredPortfolioState;

type ManifestRow = {
  userId: string;
  stateId: string;
  revision: number;
  schemaVersion: number;
  isDemo: number;
  onboardingCompleted: number;
  extraJson: string;
  updatedAt: string;
};

type ItemRow = { itemJson: string };

const COLLECTION_TABLES: Record<CollectionName, string> = {
  transactions: 'portfolio_transactions',
  watchlist: 'portfolio_watchlist_items',
  closedPositions: 'portfolio_closed_positions',
  journal: 'portfolio_journal_entries',
  dailySnapshots: 'portfolio_daily_snapshots',
  history: 'portfolio_history_entries',
  technicalAlerts: 'portfolio_technical_alerts',
};

const NORMALIZED_TABLES = [
  ...Object.values(COLLECTION_TABLES),
  'portfolio_settings',
  'portfolio_state_manifests',
] as const;

export async function getCloudStore(): Promise<D1Database> {
  if (!env.DB) throw new Error('Bulut veritabanı bağlantısı bulunamadı.');
  return env.DB;
}

async function readRawPortfolioState(db: D1Database, userId: string): Promise<RawPortfolioState | null> {
  return db.prepare(`
    SELECT user_id AS userId, revision, state_json AS stateJson, updated_at AS updatedAt
    FROM portfolio_states
    WHERE user_id = ?
  `).bind(userId).first<RawPortfolioState>();
}

async function runStatementBatches(db: D1Database, statements: D1PreparedStatement[], size = 75): Promise<void> {
  for (let offset = 0; offset < statements.length; offset += size) {
    await db.batch(statements.slice(offset, offset + size));
  }
}

async function deleteNormalizedState(db: D1Database, userId: string, stateId: string): Promise<void> {
  await db.batch(NORMALIZED_TABLES.map(table => (
    db.prepare(`DELETE FROM ${table} WHERE user_id = ? AND state_id = ?`).bind(userId, stateId)
  )));
}

async function stageNormalizedState(
  db: D1Database,
  userId: string,
  revision: number,
  state: PortfolioState,
  updatedAt: string,
): Promise<string> {
  const stateId = crypto.randomUUID();
  const split = splitPortfolioState(state);
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO portfolio_settings (user_id, state_id, settings_json)
      VALUES (?, ?, ?)
    `).bind(userId, stateId, split.settingsJson),
  ];

  for (const collection of COLLECTION_NAMES) {
    const table = COLLECTION_TABLES[collection];
    for (const item of split.collections[collection]) {
      statements.push(db.prepare(`
        INSERT INTO ${table} (user_id, state_id, item_id, position, item_json)
        VALUES (?, ?, ?, ?, ?)
      `).bind(userId, stateId, item.itemId, item.position, item.itemJson));
    }
  }

  try {
    await runStatementBatches(db, statements);
    await db.prepare(`
      INSERT INTO portfolio_state_manifests
        (user_id, state_id, revision, schema_version, is_demo, onboarding_completed, extra_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      userId,
      stateId,
      revision,
      split.schemaVersion,
      split.isDemo ? 1 : 0,
      split.onboardingCompleted ? 1 : 0,
      split.extraJson,
      updatedAt,
    ).run();
    return stateId;
  } catch (error) {
    await deleteNormalizedState(db, userId, stateId).catch(() => undefined);
    throw error;
  }
}

async function readNormalizedState(
  db: D1Database,
  userId: string,
  stateId: string,
): Promise<StoredPortfolioState | null> {
  const manifest = await db.prepare(`
    SELECT user_id AS userId, state_id AS stateId, revision, schema_version AS schemaVersion,
      is_demo AS isDemo, onboarding_completed AS onboardingCompleted,
      extra_json AS extraJson, updated_at AS updatedAt
    FROM portfolio_state_manifests
    WHERE user_id = ? AND state_id = ?
  `).bind(userId, stateId).first<ManifestRow>();
  if (!manifest) return null;

  const statements = [
    db.prepare(`
      SELECT settings_json AS itemJson FROM portfolio_settings
      WHERE user_id = ? AND state_id = ?
    `).bind(userId, stateId),
    ...COLLECTION_NAMES.map(collection => db.prepare(`
      SELECT item_json AS itemJson FROM ${COLLECTION_TABLES[collection]}
      WHERE user_id = ? AND state_id = ?
      ORDER BY position
    `).bind(userId, stateId)),
  ];
  const results = await db.batch<ItemRow>(statements);
  const settingsJson = results[0]?.results?.[0]?.itemJson;
  if (typeof settingsJson !== 'string') throw new Error('Normalize portföy ayarları bulunamadı.');

  const collections = Object.fromEntries(COLLECTION_NAMES.map((collection, index) => [
    collection,
    (results[index + 1]?.results || []).map(row => ({ itemJson: String(row.itemJson) })),
  ])) as Record<CollectionName, ItemRow[]>;
  const state = joinPortfolioState({
    schemaVersion: Number(manifest.schemaVersion),
    settingsJson,
    isDemo: Number(manifest.isDemo) === 1,
    onboardingCompleted: Number(manifest.onboardingCompleted) === 1,
    extraJson: manifest.extraJson,
    collections,
  });
  return {
    userId,
    revision: Number(manifest.revision),
    stateJson: JSON.stringify(state),
    updatedAt: manifest.updatedAt,
  };
}

async function readStateFromRaw(db: D1Database, row: RawPortfolioState | null): Promise<StoredPortfolioState | null> {
  if (!row) return null;
  const stateId = readStorageMarker(row.stateJson);
  if (!stateId) return row;
  const normalized = await readNormalizedState(db, row.userId, stateId);
  if (normalized) return normalized;
  return db.prepare(`
    SELECT user_id AS userId, revision, state_json AS stateJson, updated_at AS updatedAt
    FROM portfolio_state_versions
    WHERE user_id = ? AND revision = ?
  `).bind(row.userId, row.revision).first<StoredPortfolioState>();
}

async function writeTransactionAudit(
  db: D1Database,
  userId: string,
  stateId: string,
  revision: number,
  before: PortfolioState | null,
  after: PortfolioState,
  changedAt: string,
  backfill = false,
): Promise<void> {
  const changes = diffTransactions(before, after, backfill);
  if (changes.length === 0) return;
  await runStatementBatches(db, changes.map(change => db.prepare(`
    INSERT INTO portfolio_transaction_audit
      (event_id, user_id, state_id, transaction_id, revision, action, before_json, after_json, changed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(),
    userId,
    stateId,
    change.transactionId,
    revision,
    change.action,
    change.beforeJson,
    change.afterJson,
    changedAt,
  )));
}

async function cleanupOldNormalizedVersions(db: D1Database, userId: string): Promise<void> {
  const stale = await db.prepare(`
    SELECT state_id AS stateId
    FROM portfolio_state_manifests
    WHERE user_id = ?
    ORDER BY revision DESC
    LIMIT -1 OFFSET 20
  `).bind(userId).all<{ stateId: string }>();
  for (const row of stale.results || []) {
    await deleteNormalizedState(db, userId, row.stateId);
  }
}

async function saveLegacyPortfolioVersion(
  db: D1Database,
  userId: string,
  revision: number,
  state: PortfolioState,
  updatedAt: string,
): Promise<void> {
  await db.batch([
    db.prepare(`
      INSERT OR REPLACE INTO portfolio_state_versions
        (user_id, revision, state_json, updated_at)
      VALUES (?, ?, ?, ?)
    `).bind(userId, revision, JSON.stringify(state), updatedAt),
    db.prepare(`
      DELETE FROM portfolio_state_versions
      WHERE user_id = ? AND revision NOT IN (
        SELECT revision FROM portfolio_state_versions
        WHERE user_id = ?
        ORDER BY revision DESC
        LIMIT 20
      )
    `).bind(userId, userId),
  ]);
}

export async function readPortfolioState(userId: string): Promise<StoredPortfolioState | null> {
  const db = await getCloudStore();
  return readStateFromRaw(db, await readRawPortfolioState(db, userId));
}

export async function ensureNormalizedPortfolioState(userId: string): Promise<boolean> {
  const db = await getCloudStore();
  const raw = await readRawPortfolioState(db, userId);
  if (!raw || readStorageMarker(raw.stateJson)) return false;
  const state = parsePortfolioState(raw.stateJson);
  if (!state) return false;

  const stateId = await stageNormalizedState(db, userId, raw.revision, state, raw.updatedAt);
  const marker = createStorageMarker(stateId);
  const result = await db.prepare(`
    UPDATE portfolio_states
    SET state_json = ?
    WHERE user_id = ? AND revision = ? AND state_json = ?
  `).bind(marker, userId, raw.revision, raw.stateJson).run();
  if (Number(result.meta?.changes || 0) !== 1) {
    await deleteNormalizedState(db, userId, stateId);
    return false;
  }
  await saveLegacyPortfolioVersion(db, userId, raw.revision, state, raw.updatedAt).catch(error => {
    console.error('Eski biçimli portföy sürümü kaydedilemedi.', error);
  });
  await writeTransactionAudit(db, userId, stateId, raw.revision, null, state, raw.updatedAt, true).catch(error => {
    console.error('İlk işlem denetim kayıtları yazılamadı.', error);
  });
  return true;
}

export async function writePortfolioState(
  userId: string,
  baseRevision: number,
  state: PortfolioState,
): Promise<{ ok: true; row: StoredPortfolioState } | { ok: false; current: StoredPortfolioState | null }> {
  const db = await getCloudStore();
  const raw = await readRawPortfolioState(db, userId);
  if (Number(raw?.revision || 0) !== baseRevision) {
    return { ok: false, current: await readStateFromRaw(db, raw) };
  }

  const beforeRow = await readStateFromRaw(db, raw);
  const beforeState = beforeRow ? parsePortfolioState(beforeRow.stateJson) : null;
  const revision = baseRevision + 1;
  const updatedAt = new Date().toISOString();
  const stateId = await stageNormalizedState(db, userId, revision, state, updatedAt);
  const marker = createStorageMarker(stateId);
  const result = raw
    ? await db.prepare(`
        UPDATE portfolio_states
        SET revision = ?, state_json = ?, updated_at = ?
        WHERE user_id = ? AND revision = ?
      `).bind(revision, marker, updatedAt, userId, baseRevision).run()
    : await db.prepare(`
        INSERT OR IGNORE INTO portfolio_states (user_id, revision, state_json, updated_at)
        VALUES (?, ?, ?, ?)
      `).bind(userId, revision, marker, updatedAt).run();

  if (Number(result.meta?.changes || 0) !== 1) {
    await deleteNormalizedState(db, userId, stateId);
    return { ok: false, current: await readPortfolioState(userId) };
  }

  await saveLegacyPortfolioVersion(db, userId, revision, state, updatedAt).catch(error => {
    console.error('Eski biçimli portföy sürümü kaydedilemedi.', error);
  });
  await writeTransactionAudit(db, userId, stateId, revision, beforeState, state, updatedAt).catch(error => {
    console.error('İşlem denetim kayıtları yazılamadı.', error);
  });
  await cleanupOldNormalizedVersions(db, userId).catch(error => {
    console.error('Eski normalize portföy sürümleri temizlenemedi.', error);
  });
  return {
    ok: true,
    row: { userId, revision, stateJson: JSON.stringify(state), updatedAt },
  };
}

export async function readAppliedSyncOperation(userId: string, operationId: string): Promise<number | null> {
  const db = await getCloudStore();
  const row = await db.prepare(`
    SELECT applied_revision AS appliedRevision
    FROM portfolio_sync_operations
    WHERE user_id = ? AND operation_id = ?
  `).bind(userId, operationId).first<{ appliedRevision: number }>();
  return row ? Number(row.appliedRevision) : null;
}

export async function recordAppliedSyncOperation(
  userId: string,
  operationId: string,
  revision: number,
): Promise<void> {
  const db = await getCloudStore();
  await db.prepare(`
    INSERT OR IGNORE INTO portfolio_sync_operations
      (user_id, operation_id, applied_revision, applied_at)
    VALUES (?, ?, ?, ?)
  `).bind(userId, operationId, revision, new Date().toISOString()).run();
  await db.prepare(`
    DELETE FROM portfolio_sync_operations
    WHERE user_id = ? AND operation_id NOT IN (
      SELECT operation_id
      FROM portfolio_sync_operations
      WHERE user_id = ?
      ORDER BY applied_at DESC
      LIMIT 5000
    )
  `).bind(userId, userId).run();
}

export async function listPortfolioVersionSummaries(userId: string, limit = 20): Promise<StoredPortfolioVersionSummary[]> {
  const db = await getCloudStore();
  const safeLimit = Math.max(1, Math.min(20, Math.trunc(limit)));
  const normalized = await db.prepare(`
    SELECT m.revision, m.updated_at AS updatedAt,
      (SELECT COUNT(*) FROM portfolio_transactions t WHERE t.user_id = m.user_id AND t.state_id = m.state_id) AS transactions,
      (SELECT COUNT(*) FROM portfolio_watchlist_items w WHERE w.user_id = m.user_id AND w.state_id = m.state_id) AS watchlist,
      (SELECT COUNT(*) FROM portfolio_journal_entries j WHERE j.user_id = m.user_id AND j.state_id = m.state_id) AS journal
    FROM portfolio_state_manifests m
    WHERE m.user_id = ?
    ORDER BY m.revision DESC
    LIMIT ?
  `).bind(userId, safeLimit).all<StoredPortfolioVersionSummary>();

  const legacy = await db.prepare(`
    SELECT revision, state_json AS stateJson, updated_at AS updatedAt
    FROM portfolio_state_versions
    WHERE user_id = ?
    ORDER BY revision DESC
    LIMIT ?
  `).bind(userId, safeLimit).all<{ revision: number; stateJson: string; updatedAt: string }>();

  const byRevision = new Map<number, StoredPortfolioVersionSummary>();
  for (const row of legacy.results || []) {
    const state = parsePortfolioState(row.stateJson);
    byRevision.set(Number(row.revision), {
      revision: Number(row.revision),
      updatedAt: row.updatedAt,
      transactions: state?.transactions.length || 0,
      watchlist: state?.watchlist.length || 0,
      journal: state?.journal.length || 0,
    });
  }
  for (const row of normalized.results || []) {
    byRevision.set(Number(row.revision), {
      revision: Number(row.revision),
      updatedAt: row.updatedAt,
      transactions: Number(row.transactions),
      watchlist: Number(row.watchlist),
      journal: Number(row.journal),
    });
  }
  return [...byRevision.values()].sort((a, b) => b.revision - a.revision).slice(0, safeLimit);
}

export async function readPortfolioVersion(userId: string, revision: number): Promise<StoredPortfolioVersion | null> {
  const db = await getCloudStore();
  const manifest = await db.prepare(`
    SELECT state_id AS stateId
    FROM portfolio_state_manifests
    WHERE user_id = ? AND revision = ?
  `).bind(userId, revision).first<{ stateId: string }>();
  if (manifest) return readNormalizedState(db, userId, manifest.stateId);
  return db.prepare(`
    SELECT user_id AS userId, revision, state_json AS stateJson, updated_at AS updatedAt
    FROM portfolio_state_versions
    WHERE user_id = ? AND revision = ?
  `).bind(userId, revision).first<StoredPortfolioVersion>();
}
