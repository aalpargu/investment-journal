import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const COLLECTION_TABLES = {
  transactions: 'portfolio_transactions',
  watchlist: 'portfolio_watchlist_items',
  closedPositions: 'portfolio_closed_positions',
  journal: 'portfolio_journal_entries',
  dailySnapshots: 'portfolio_daily_snapshots',
  history: 'portfolio_history_entries',
  technicalAlerts: 'portfolio_technical_alerts',
};

const NORMALIZED_TABLES = [
  'portfolio_state_manifests',
  'portfolio_settings',
  ...Object.values(COLLECTION_TABLES),
  'portfolio_transaction_audit',
  'portfolio_sync_operations',
];

function readArguments(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error('Gecersiz geri yukleme testi argumani.');
    }
    result.set(key.slice(2), value);
  }
  return result;
}

function requiredPath(argumentsMap, name) {
  const value = argumentsMap.get(name);
  if (!value) throw new Error(`Eksik arguman: --${name}`);
  return resolve(value);
}

function verifyHash(filePath) {
  const sidecar = `${filePath}.sha256`;
  const expected = readFileSync(sidecar, 'utf8').trim().split(/\s+/u)[0]?.toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(expected || '')) {
    throw new Error(`Gecersiz SHA-256 dosyasi: ${basename(sidecar)}`);
  }
  const contents = readFileSync(filePath);
  const actual = createHash('sha256').update(contents).digest('hex');
  if (actual !== expected) {
    throw new Error(`Yedek butunluk kontrolu basarisiz: ${basename(filePath)}`);
  }
  return { contents, sha256: actual };
}

function decodeUtf8(contents) {
  return contents.toString('utf8').replace(/^\uFEFF/u, '');
}

function validatePortfolioState(rawState) {
  let state;
  try {
    state = JSON.parse(rawState);
  } catch {
    throw new Error('Geri yuklenen portfolio state_json alani gecerli JSON degil.');
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)
    || !Number.isInteger(state.schemaVersion)
    || !Array.isArray(state.transactions)
    || !Array.isArray(state.watchlist)
    || !Array.isArray(state.dailySnapshots)
    || !state.settings || typeof state.settings !== 'object' || Array.isArray(state.settings)) {
    throw new Error('Geri yuklenen portfoy uygulamanin bekledigi veri semasiyla uyusmuyor.');
  }
  return state;
}

function parseObject(rawValue, label) {
  let value;
  try {
    value = JSON.parse(String(rawValue));
  } catch {
    throw new Error(`${label} gecerli JSON degil.`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} bir JSON nesnesi degil.`);
  }
  return value;
}

function storageMarker(rawState) {
  const value = parseObject(rawState, 'portfolio_states.state_json');
  return value.storage === 'normalized-v1' && typeof value.stateId === 'string' && value.stateId
    ? value.stateId
    : null;
}

function assembleNormalizedState(manifest, settingsJson, rowsByCollection) {
  const state = {
    ...parseObject(manifest.extra_json, 'portfolio_state_manifests.extra_json'),
    schemaVersion: Number(manifest.schema_version),
    settings: parseObject(settingsJson, 'portfolio_settings.settings_json'),
    isDemo: Number(manifest.is_demo) === 1,
    onboardingCompleted: Number(manifest.onboarding_completed) === 1,
  };
  for (const [collection, rows] of Object.entries(rowsByCollection)) {
    state[collection] = rows.map((row) => {
      try {
        return JSON.parse(String(row.item_json));
      } catch {
        throw new Error(`${COLLECTION_TABLES[collection]}.item_json gecerli JSON degil.`);
      }
    });
  }
  return validatePortfolioState(JSON.stringify(state));
}

function normalizedStateFromDatabase(database, userId, stateId) {
  const manifest = database.prepare(`
    SELECT schema_version, is_demo, onboarding_completed, extra_json
    FROM portfolio_state_manifests
    WHERE user_id = ? AND state_id = ?
  `).get(userId, stateId);
  if (!manifest) throw new Error(`Normalize portfoy manifesti bulunamadi: ${stateId}`);
  const settings = database.prepare(`
    SELECT settings_json FROM portfolio_settings
    WHERE user_id = ? AND state_id = ?
  `).get(userId, stateId);
  if (!settings) throw new Error(`Normalize portfoy ayarlari bulunamadi: ${stateId}`);

  const rowsByCollection = Object.fromEntries(Object.entries(COLLECTION_TABLES).map(([collection, table]) => [
    collection,
    database.prepare(`
      SELECT item_json FROM ${table}
      WHERE user_id = ? AND state_id = ?
      ORDER BY position
    `).all(userId, stateId),
  ]));
  return assembleNormalizedState(manifest, settings.settings_json, rowsByCollection);
}

function normalizedStateFromJsonBackup(tables, userId, stateId) {
  const matchingRow = (table) => (tables[table] || []).find(
    (row) => String(row.user_id) === userId && String(row.state_id) === stateId,
  );
  const manifest = matchingRow('portfolio_state_manifests');
  const settings = matchingRow('portfolio_settings');
  if (!manifest) throw new Error(`JSON yedeginde normalize portfoy manifesti bulunamadi: ${stateId}`);
  if (!settings) throw new Error(`JSON yedeginde normalize portfoy ayarlari bulunamadi: ${stateId}`);

  const rowsByCollection = Object.fromEntries(Object.entries(COLLECTION_TABLES).map(([collection, table]) => [
    collection,
    (tables[table] || [])
      .filter((row) => String(row.user_id) === userId && String(row.state_id) === stateId)
      .sort((left, right) => Number(left.position) - Number(right.position)),
  ]));
  return assembleNormalizedState(manifest, settings.settings_json, rowsByCollection);
}

function scalar(database, sql) {
  const row = database.prepare(sql).get();
  return row ? Number(Object.values(row)[0]) : 0;
}

const argumentsMap = readArguments(process.argv.slice(2));
const sqlPath = requiredPath(argumentsMap, 'sql');
const jsonPath = requiredPath(argumentsMap, 'json');
const databasePath = requiredPath(argumentsMap, 'database');

const sqlBackup = verifyHash(sqlPath);
const jsonBackup = verifyHash(jsonPath);
let jsonDocument;
try {
  jsonDocument = JSON.parse(decodeUtf8(jsonBackup.contents));
} catch {
  throw new Error('JSON yedegi ayrıştırılamadı.');
}
if (jsonDocument?.format !== 'yatirim-defterim-d1-json-backup'
  || jsonDocument?.formatVersion !== 1
  || !jsonDocument.tables || typeof jsonDocument.tables !== 'object') {
  throw new Error('JSON yedegi beklenen Yatirim Defterim biciminde degil.');
}

const database = new DatabaseSync(databasePath);
try {
  database.exec(decodeUtf8(sqlBackup.contents));

  const integrityRow = database.prepare('PRAGMA integrity_check').get();
  const integrity = integrityRow ? String(Object.values(integrityRow)[0]) : '';
  if (integrity.toLowerCase() !== 'ok') {
    throw new Error(`SQLite butunluk kontrolu basarisiz: ${integrity || 'yanit yok'}`);
  }

  const requiredTables = [
    'app_settings',
    'pending_transactions',
    'portfolio_state_versions',
    'portfolio_states',
    'telegram_updates',
  ];
  const restoredTables = database.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map((row) => String(row.name));
  for (const tableName of requiredTables) {
    if (!restoredTables.includes(tableName)) {
      throw new Error(`Geri yuklenen veritabaninda zorunlu tablo eksik: ${tableName}`);
    }
  }

  const currentStates = database.prepare(
    'SELECT user_id AS userId, revision, state_json AS stateJson FROM portfolio_states ORDER BY user_id',
  ).all();
  if (currentStates.length === 0) {
    throw new Error('Geri yuklenen veritabaninda guncel portfoy kaydi yok.');
  }

  let transactions = 0;
  let watchlist = 0;
  let normalizedStates = 0;
  for (const row of currentStates) {
    if (!Number.isInteger(Number(row.revision)) || Number(row.revision) < 1) {
      throw new Error('Geri yuklenen portfoy revizyonu gecersiz.');
    }
    const stateId = storageMarker(String(row.stateJson));
    if (stateId) {
      for (const tableName of NORMALIZED_TABLES) {
        if (!restoredTables.includes(tableName)) {
          throw new Error(`Normalize geri yukleme icin zorunlu tablo eksik: ${tableName}`);
        }
      }
      normalizedStates += 1;
    }
    const state = stateId
      ? normalizedStateFromDatabase(database, String(row.userId), stateId)
      : validatePortfolioState(String(row.stateJson));
    transactions += state.transactions.length;
    watchlist += state.watchlist.length;
  }

  const pendingRows = database.prepare(
    'SELECT transactions_json AS transactionsJson FROM pending_transactions',
  ).all();
  let pendingTransactions = 0;
  for (const row of pendingRows) {
    let entries;
    try {
      entries = JSON.parse(String(row.transactionsJson));
    } catch {
      throw new Error('Bekleyen islem kaydi gecerli JSON degil.');
    }
    if (!Array.isArray(entries)) {
      throw new Error('Bekleyen islem kaydi dizi degil.');
    }
    pendingTransactions += entries.length;
  }

  const jsonStates = jsonDocument.tables.portfolio_states;
  if (!Array.isArray(jsonStates) || jsonStates.length === 0) {
    throw new Error('JSON yedeginde guncel portfoy kaydi yok.');
  }
  for (const row of jsonStates) {
    const stateId = storageMarker(String(row.state_json));
    if (stateId) {
      for (const tableName of NORMALIZED_TABLES) {
        if (!Array.isArray(jsonDocument.tables[tableName])) {
          throw new Error(`JSON yedeginde normalize tablo eksik: ${tableName}`);
        }
      }
      normalizedStateFromJsonBackup(jsonDocument.tables, String(row.user_id), stateId);
    } else {
      validatePortfolioState(String(row.state_json));
    }
  }

  const report = {
    status: 'ok',
    testedAtUtc: new Date().toISOString(),
    sqlBackup: basename(sqlPath),
    sqlSha256: sqlBackup.sha256,
    jsonBackup: basename(jsonPath),
    jsonSha256: jsonBackup.sha256,
    sqliteIntegrity: integrity,
    restoredTables: restoredTables.length,
    portfolioStates: currentStates.length,
    normalizedStates,
    portfolioVersions: scalar(database, 'SELECT COUNT(*) FROM portfolio_state_versions'),
    transactionAuditEvents: restoredTables.includes('portfolio_transaction_audit')
      ? scalar(database, 'SELECT COUNT(*) FROM portfolio_transaction_audit')
      : 0,
    appliedSyncOperations: restoredTables.includes('portfolio_sync_operations')
      ? scalar(database, 'SELECT COUNT(*) FROM portfolio_sync_operations')
      : 0,
    transactions,
    watchlist,
    pendingTransactionGroups: pendingRows.length,
    pendingTransactions,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  database.close();
}
