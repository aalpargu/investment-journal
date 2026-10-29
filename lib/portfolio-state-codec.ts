export const NORMALIZED_STORAGE_VERSION = 'normalized-v1';

export const COLLECTION_NAMES = [
  'transactions',
  'watchlist',
  'closedPositions',
  'journal',
  'dailySnapshots',
  'history',
  'technicalAlerts',
] as const;

export type CollectionName = typeof COLLECTION_NAMES[number];

export type PortfolioState = Record<string, unknown> & {
  schemaVersion: number;
  settings: Record<string, unknown>;
  isDemo: boolean;
  onboardingCompleted: boolean;
  transactions: unknown[];
  watchlist: unknown[];
  closedPositions: unknown[];
  journal: unknown[];
  dailySnapshots: unknown[];
  history: unknown[];
  technicalAlerts: unknown[];
};

export type NormalizedItem = {
  itemId: string;
  position: number;
  itemJson: string;
};

export type SplitPortfolioState = {
  schemaVersion: number;
  settingsJson: string;
  isDemo: boolean;
  onboardingCompleted: boolean;
  extraJson: string;
  collections: Record<CollectionName, NormalizedItem[]>;
};

export type TransactionAuditChange = {
  transactionId: string;
  action: 'create' | 'update' | 'delete' | 'backfill';
  beforeJson: string | null;
  afterJson: string | null;
};

export function isPortfolioState(value: unknown): value is PortfolioState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return Number.isInteger(state.schemaVersion)
    && Boolean(state.settings) && typeof state.settings === 'object' && !Array.isArray(state.settings)
    && COLLECTION_NAMES.every(name => Array.isArray(state[name]));
}

export function parsePortfolioState(stateJson: string): PortfolioState | null {
  try {
    const value = JSON.parse(stateJson);
    return isPortfolioState(value) ? value : null;
  } catch {
    return null;
  }
}

function itemKey(value: unknown, collection: CollectionName, position: number): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const item = value as Record<string, unknown>;
    for (const candidate of [item.id, item.date, item.symbol]) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
  }
  return `${collection}-${position}`;
}

function splitCollection(values: unknown[], collection: CollectionName): NormalizedItem[] {
  const seen = new Set<string>();
  return values.map((value, position) => {
    const baseKey = itemKey(value, collection, position);
    let itemId = baseKey;
    let suffix = 1;
    while (seen.has(itemId)) {
      itemId = `${baseKey}#${suffix}`;
      suffix += 1;
    }
    seen.add(itemId);
    return { itemId, position, itemJson: JSON.stringify(value) };
  });
}

export function splitPortfolioState(state: PortfolioState): SplitPortfolioState {
  const extra: Record<string, unknown> = { ...state };
  delete extra.schemaVersion;
  delete extra.settings;
  delete extra.isDemo;
  delete extra.onboardingCompleted;
  for (const collection of COLLECTION_NAMES) delete extra[collection];

  return {
    schemaVersion: state.schemaVersion,
    settingsJson: JSON.stringify(state.settings),
    isDemo: state.isDemo === true,
    onboardingCompleted: state.onboardingCompleted === true,
    extraJson: JSON.stringify(extra),
    collections: Object.fromEntries(
      COLLECTION_NAMES.map(collection => [collection, splitCollection(state[collection], collection)]),
    ) as Record<CollectionName, NormalizedItem[]>,
  };
}

function parseObject(json: string, label: string): Record<string, unknown> {
  const value = JSON.parse(json);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} nesne degil.`);
  }
  return value as Record<string, unknown>;
}

export function joinPortfolioState(input: {
  schemaVersion: number;
  settingsJson: string;
  isDemo: boolean;
  onboardingCompleted: boolean;
  extraJson: string;
  collections: Record<CollectionName, Array<{ itemJson: string }>>;
}): PortfolioState {
  const value = {
    ...parseObject(input.extraJson, 'extraJson'),
    schemaVersion: input.schemaVersion,
    settings: parseObject(input.settingsJson, 'settingsJson'),
    isDemo: input.isDemo,
    onboardingCompleted: input.onboardingCompleted,
    ...Object.fromEntries(COLLECTION_NAMES.map(collection => [
      collection,
      input.collections[collection].map(row => JSON.parse(row.itemJson)),
    ])),
  };
  if (!isPortfolioState(value)) throw new Error('Normalize portfoy durumu dogrulanamadi.');
  return value;
}

export function createStorageMarker(stateId: string): string {
  return JSON.stringify({ storage: NORMALIZED_STORAGE_VERSION, stateId });
}

export function readStorageMarker(stateJson: string): string | null {
  try {
    const value = JSON.parse(stateJson) as { storage?: unknown; stateId?: unknown };
    return value?.storage === NORMALIZED_STORAGE_VERSION
      && typeof value.stateId === 'string'
      && value.stateId.length > 0
      ? value.stateId
      : null;
  } catch {
    return null;
  }
}

function transactionMap(values: unknown[]): Map<string, string> {
  const result = new Map<string, string>();
  values.forEach((value, position) => {
    const key = itemKey(value, 'transactions', position);
    result.set(key, JSON.stringify(value));
  });
  return result;
}

export function diffTransactions(before: PortfolioState | null, after: PortfolioState, backfill = false): TransactionAuditChange[] {
  const previous = transactionMap(before?.transactions || []);
  const next = transactionMap(after.transactions);
  const changes: TransactionAuditChange[] = [];

  for (const [transactionId, afterJson] of next) {
    const beforeJson = previous.get(transactionId) || null;
    if (backfill) {
      changes.push({ transactionId, action: 'backfill', beforeJson: null, afterJson });
    } else if (beforeJson === null) {
      changes.push({ transactionId, action: 'create', beforeJson: null, afterJson });
    } else if (beforeJson !== afterJson) {
      changes.push({ transactionId, action: 'update', beforeJson, afterJson });
    }
  }
  if (!backfill) {
    for (const [transactionId, beforeJson] of previous) {
      if (!next.has(transactionId)) {
        changes.push({ transactionId, action: 'delete', beforeJson, afterJson: null });
      }
    }
  }
  return changes;
}
