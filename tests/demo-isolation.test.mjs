import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getRequestIdentity } from '../lib/request-user.ts';
import { createDemoState } from '../lib/demo-state.ts';
import { isPortfolioState } from '../lib/portfolio-state-codec.ts';

test('no identity is inferred from a URL, personal allowlist, or old auth header', () => {
  for (const host of ['localhost:3000', 'public.example']) {
    assert.equal(getRequestIdentity(new Request(`https://${host}/api/sync-state`, {
      headers: { 'x-portfolio-access-verified': '1', 'x-portfolio-authenticated-email': 'owner@example.com' },
    })), null);
  }
});
test('different Sites visitors have distinct portfolio and settings identities', () => {
  const identity = id => getRequestIdentity(new Request('https://demo.example/api/sync-state', {
    headers: { 'oai-authenticated-user-id': id, 'oai-authenticated-user-email': 'visitor@example.com' },
  }));
  const first = identity('visitor-one'), second = identity('visitor-two');
  assert.notEqual(first.userId, second.userId);
  assert.equal(first.accountUserId, first.userId);
  assert.equal(second.accountUserId, second.userId);
});
test('partial or empty trusted identity is rejected', () => {
  assert.equal(getRequestIdentity(new Request('https://demo.example', {
    headers: { 'oai-authenticated-user-id': 'id' },
  })), null);
});
test('invented seed satisfies the complete storage codec and is independently editable', () => {
  const now = new Date('2026-10-29T00:00:00Z');
  const first = createDemoState(now), second = createDemoState(now);
  assert.ok(isPortfolioState(first));
  assert.equal(first.transactions.length, 9);
  assert.ok(first.transactions.every(tx => tx.id.startsWith('example_tx_') && !tx.demo));
  first.transactions.pop();
  assert.equal(second.transactions.length, 9);
  assert.equal(second.transactions.at(-1).date, '2026-10-24');
});
