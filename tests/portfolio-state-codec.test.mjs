import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COLLECTION_NAMES,
  createStorageMarker,
  diffTransactions,
  joinPortfolioState,
  readStorageMarker,
  splitPortfolioState,
} from '../lib/portfolio-state-codec.ts';

function sampleState() {
  return {
    schemaVersion: 5,
    settings: { baseCurrency: 'TRY', theme: 'dark' },
    isDemo: false,
    onboardingCompleted: true,
    transactions: [
      { id: 'tx-1', type: 'BUY', quantity: 2 },
      { id: 'tx-2', type: 'SELL', quantity: 1 },
    ],
    watchlist: [{ id: 'watch-1', symbol: 'NVDA' }],
    calendarEvents: [{ id: 'calendar-1', date: '2026-09-30', title: 'Kart son ödeme', type: 'card', repeat: 'monthly' }],
    stockTheses: [{ id: 'thesis-1', symbol: 'NVDA', thesis: 'Veri merkezi büyümesi', invalidation: 'Marj kalıcı bozulur', status: 'same' }],
    investmentBudget: { monthlyIncome: 50000, cashBalance: 120000, bufferMonths: 3, safetyMarginPct: 10 },
    closedPositions: [{ id: 'closed-1', symbol: 'AAPL' }],
    journal: [{ id: 'journal-1', body: 'Not' }],
    dailySnapshots: [{ date: '2026-09-06', value: 100 }],
    history: [{ date: '2026-09-06', value: 100 }],
    technicalAlerts: [{ id: 'alert-1', symbol: 'NVDA' }],
    futureField: { preserved: true },
  };
}

test('portfoy durumu tablolara ayrilip kayipsiz birlestirilir', () => {
  const state = sampleState();
  const split = splitPortfolioState(state);
  const restored = joinPortfolioState({
    ...split,
    collections: Object.fromEntries(COLLECTION_NAMES.map(collection => [
      collection,
      split.collections[collection].map(({ itemJson }) => ({ itemJson })),
    ])),
  });
  assert.deepEqual(restored, state);
});

test('normalize depolama isaretcisi yalniz gecerli bicimi kabul eder', () => {
  const marker = createStorageMarker('state-123');
  assert.equal(readStorageMarker(marker), 'state-123');
  assert.equal(readStorageMarker('{"storage":"legacy","stateId":"state-123"}'), null);
  assert.equal(readStorageMarker('gecersiz-json'), null);
});

test('islem denetim gecmisi ekleme, degistirme ve silmeyi ayirir', () => {
  const before = sampleState();
  const after = sampleState();
  after.transactions = [
    { id: 'tx-1', type: 'BUY', quantity: 3 },
    { id: 'tx-3', type: 'DIVIDEND', quantity: 1 },
  ];
  const changes = diffTransactions(before, after);
  assert.deepEqual(
    changes.map(change => [change.transactionId, change.action])
      .sort((left, right) => left[0].localeCompare(right[0])),
    [['tx-1', 'update'], ['tx-2', 'delete'], ['tx-3', 'create']],
  );
});

test('ilk aktarim butun islemleri backfill olarak kaydeder', () => {
  const changes = diffTransactions(null, sampleState(), true);
  assert.equal(changes.length, 2);
  assert.ok(changes.every(change => change.action === 'backfill'));
});
