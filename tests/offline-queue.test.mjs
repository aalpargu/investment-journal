import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {
  applyOfflineTransactionOperation,
  parseOfflineTransactionOperation,
} from '../lib/offline-transaction.ts';

async function queueApi() {
  const source = await readFile(new URL('../public/legacy/offline-queue.js', import.meta.url), 'utf8');
  const context = vm.createContext({ globalThis: {}, Date, Math, JSON, Map });
  vm.runInContext(source, context);
  return context.globalThis.PortfolioOfflineQueue;
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test('transaction differences are queued in create, update and delete order', async () => {
  const api = await queueApi();
  const before = [
    { id: 'tx-1', quantity: 1 },
    { id: 'tx-2', quantity: 2 },
    { id: 'demo', demo: true, quantity: 1 },
  ];
  const after = [
    { id: 'tx-1', quantity: 3 },
    { id: 'tx-3', quantity: 4 },
  ];
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.diffTransactions(before, after))),
    [
      { type: 'upsert', transactionId: 'tx-1', transaction: after[0] },
      { type: 'upsert', transactionId: 'tx-3', transaction: after[1] },
      { type: 'delete', transactionId: 'tx-2' },
    ],
  );
});

test('outbox persists entries and acknowledges only the FIFO head', async () => {
  const api = await queueApi();
  const storage = memoryStorage();
  let id = 0;
  const options = { storage, key: 'outbox', idFactory: () => `operation-${++id}`, now: () => 123 };
  const outbox = api.createOutbox(options);
  outbox.enqueueMany([
    { type: 'upsert', transactionId: 'tx-1', transaction: { id: 'tx-1' } },
    { type: 'delete', transactionId: 'tx-2' },
  ]);
  assert.equal(outbox.count(), 2);
  assert.equal(outbox.acknowledge('operation-2'), false);
  assert.equal(outbox.acknowledge('operation-1'), true);
  assert.equal(api.createOutbox(options).peek().id, 'operation-2');
});

test('server operation application is naturally idempotent', () => {
  const base = {
    schemaVersion: 3,
    settings: {},
    isDemo: false,
    onboardingCompleted: true,
    transactions: [],
    watchlist: [],
    closedPositions: [],
    journal: [],
    dailySnapshots: [],
    history: [],
    technicalAlerts: [],
  };
  const operation = parseOfflineTransactionOperation({
    type: 'upsert',
    transactionId: 'tx-1',
    transaction: { id: 'tx-1', quantity: 2 },
  });
  assert.ok(operation);
  const first = applyOfflineTransactionOperation(base, operation);
  assert.equal(first.changed, true);
  const second = applyOfflineTransactionOperation(first.state, operation);
  assert.equal(second.changed, false);
});
