import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function writeHashed(filePath, contents) {
  writeFileSync(filePath, contents);
  writeFileSync(`${filePath}.sha256`, createHash('sha256').update(contents).digest('hex'));
}

test('normalize SQL ve JSON yedekleri yeniden kurularak dogrulanir', () => {
  const directory = mkdtempSync(join(tmpdir(), 'portfolio-restore-test-'));
  try {
    const stateId = 'state-test-1';
    const marker = JSON.stringify({ storage: 'normalized-v1', stateId });
    const transaction = JSON.stringify({ id: 'tx-1', symbol: 'NVDA', quantity: 2 });
    const watchlist = JSON.stringify({ id: 'watch-1', symbol: 'AAPL' });
    const sql = `
CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE pending_transactions (id TEXT PRIMARY KEY, transactions_json TEXT NOT NULL);
CREATE TABLE portfolio_state_versions (user_id TEXT NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE portfolio_states (user_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE telegram_updates (id TEXT PRIMARY KEY);
CREATE TABLE portfolio_state_manifests (user_id TEXT NOT NULL, state_id TEXT NOT NULL, revision INTEGER NOT NULL, schema_version INTEGER NOT NULL, is_demo INTEGER NOT NULL, onboarding_completed INTEGER NOT NULL, extra_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE portfolio_settings (user_id TEXT NOT NULL, state_id TEXT NOT NULL, settings_json TEXT NOT NULL);
CREATE TABLE portfolio_transactions (user_id TEXT NOT NULL, state_id TEXT NOT NULL, item_id TEXT NOT NULL, position INTEGER NOT NULL, item_json TEXT NOT NULL);
CREATE TABLE portfolio_watchlist_items (user_id TEXT NOT NULL, state_id TEXT NOT NULL, item_id TEXT NOT NULL, position INTEGER NOT NULL, item_json TEXT NOT NULL);
CREATE TABLE portfolio_closed_positions (user_id TEXT NOT NULL, state_id TEXT NOT NULL, item_id TEXT NOT NULL, position INTEGER NOT NULL, item_json TEXT NOT NULL);
CREATE TABLE portfolio_journal_entries (user_id TEXT NOT NULL, state_id TEXT NOT NULL, item_id TEXT NOT NULL, position INTEGER NOT NULL, item_json TEXT NOT NULL);
CREATE TABLE portfolio_daily_snapshots (user_id TEXT NOT NULL, state_id TEXT NOT NULL, item_id TEXT NOT NULL, position INTEGER NOT NULL, item_json TEXT NOT NULL);
CREATE TABLE portfolio_history_entries (user_id TEXT NOT NULL, state_id TEXT NOT NULL, item_id TEXT NOT NULL, position INTEGER NOT NULL, item_json TEXT NOT NULL);
CREATE TABLE portfolio_technical_alerts (user_id TEXT NOT NULL, state_id TEXT NOT NULL, item_id TEXT NOT NULL, position INTEGER NOT NULL, item_json TEXT NOT NULL);
CREATE TABLE portfolio_transaction_audit (event_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, state_id TEXT NOT NULL, transaction_id TEXT NOT NULL, revision INTEGER NOT NULL, action TEXT NOT NULL, before_json TEXT, after_json TEXT, changed_at TEXT NOT NULL);
CREATE TABLE portfolio_sync_operations (user_id TEXT NOT NULL, operation_id TEXT NOT NULL, applied_revision INTEGER NOT NULL, applied_at TEXT NOT NULL);
INSERT INTO portfolio_states VALUES ('test-user', 7, '${marker}', '2026-09-06T12:00:00.000Z');
INSERT INTO portfolio_state_versions VALUES ('test-user', 7, '{"schemaVersion":3,"settings":{"baseCurrency":"TRY"},"isDemo":false,"onboardingCompleted":true,"transactions":[${transaction}],"watchlist":[${watchlist}],"closedPositions":[],"journal":[],"dailySnapshots":[],"history":[],"technicalAlerts":[]}', '2026-09-06T12:00:00.000Z');
INSERT INTO portfolio_state_manifests VALUES ('test-user', '${stateId}', 7, 3, 0, 1, '{"futureField":{"preserved":true}}', '2026-09-06T12:00:00.000Z');
INSERT INTO portfolio_settings VALUES ('test-user', '${stateId}', '{"baseCurrency":"TRY"}');
INSERT INTO portfolio_transactions VALUES ('test-user', '${stateId}', 'tx-1', 0, '${transaction}');
INSERT INTO portfolio_watchlist_items VALUES ('test-user', '${stateId}', 'watch-1', 0, '${watchlist}');
INSERT INTO portfolio_transaction_audit VALUES ('event-1', 'test-user', '${stateId}', 'tx-1', 7, 'backfill', NULL, '${transaction}', '2026-09-06T12:00:00.000Z');
INSERT INTO portfolio_sync_operations VALUES ('test-user', 'operation-1', 7, '2026-09-06T12:00:00.000Z');
`;
    const tables = {
      portfolio_states: [{ user_id: 'test-user', revision: 7, state_json: marker }],
      portfolio_state_manifests: [{ user_id: 'test-user', state_id: stateId, revision: 7, schema_version: 3, is_demo: 0, onboarding_completed: 1, extra_json: '{"futureField":{"preserved":true}}' }],
      portfolio_settings: [{ user_id: 'test-user', state_id: stateId, settings_json: '{"baseCurrency":"TRY"}' }],
      portfolio_transactions: [{ user_id: 'test-user', state_id: stateId, item_id: 'tx-1', position: 0, item_json: transaction }],
      portfolio_watchlist_items: [{ user_id: 'test-user', state_id: stateId, item_id: 'watch-1', position: 0, item_json: watchlist }],
      portfolio_closed_positions: [],
      portfolio_journal_entries: [],
      portfolio_daily_snapshots: [],
      portfolio_history_entries: [],
      portfolio_technical_alerts: [],
      portfolio_transaction_audit: [{ event_id: 'event-1', user_id: 'test-user', state_id: stateId }],
      portfolio_sync_operations: [{ user_id: 'test-user', operation_id: 'operation-1', applied_revision: 7 }],
    };
    const json = JSON.stringify({ format: 'yatirim-defterim-d1-json-backup', formatVersion: 1, tables });
    const sqlPath = join(directory, 'backup.sql');
    const jsonPath = join(directory, 'backup.json');
    const databasePath = join(directory, 'restored.sqlite');
    writeHashed(sqlPath, sql);
    writeHashed(jsonPath, json);

    const result = spawnSync(process.execPath, [
      resolve('ops/verify-backup-restore.mjs'),
      '--sql', sqlPath,
      '--json', jsonPath,
      '--database', databasePath,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.normalizedStates, 1);
    assert.equal(report.transactions, 1);
    assert.equal(report.watchlist, 1);
    assert.equal(report.transactionAuditEvents, 1);
    assert.equal(report.appliedSyncOperations, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
