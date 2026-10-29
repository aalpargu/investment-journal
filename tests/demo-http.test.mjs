import assert from 'node:assert/strict';

// Run only against the disposable local Worker, never against a hosted Site.
const base = process.env.DEMO_TEST_URL || 'http://127.0.0.1:8787';
assert.equal(new URL(base).hostname, '127.0.0.1');
const run = crypto.randomUUID();
const actor = id => ({ 'oai-authenticated-user-id': `test_${run}_${id}`, 'oai-authenticated-user-email': `${id}@example.test` });
async function request(path, headers = {}, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}
assert.equal((await request('/api/sync-state')).status, 401);
assert.equal((await request('/api/sync-state', { 'x-portfolio-access-verified': '1', 'x-portfolio-authenticated-email': 'owner@example.com' })).status, 401);
const alice = actor('alice'), bob = actor('bob');
const initialA = (await request('/api/sync-state', alice)).data;
const initialB = (await request('/api/sync-state', bob)).data;
assert.equal(initialA.state.transactions.length, 9);
assert.deepEqual(initialA.state.transactions, initialB.state.transactions);
const editedA = structuredClone(initialA.state);
editedA.transactions.push({ id: 'alice_only_transaction', type: 'BUY', symbol: 'AAPL', market: 'ABD', currency: 'USD', date: '2026-10-29', quantity: 1, price: 100, fee: 0 });
assert.equal((await request('/api/sync-state', alice, 'PUT', { baseRevision: initialA.revision, state: editedA })).status, 200);
const readA = (await request('/api/sync-state', alice)).data;
const readB = (await request('/api/sync-state', bob)).data;
assert.ok(readA.state.transactions.some(t => t.id === 'alice_only_transaction'));
assert.ok(!readB.state.transactions.some(t => t.id === 'alice_only_transaction'));
assert.equal((await request('/api/sync-state', alice, 'PUT', { baseRevision: initialA.revision, state: editedA })).status, 409);
assert.equal((await request('/api/sync-state', { ...alice, Origin: 'https://untrusted.example' }, 'PUT', { baseRevision: readA.revision, state: editedA })).status, 403);
const scopeA = (await request('/api/demo-session', alice)).data.storageScope;
const scopeB = (await request('/api/demo-session', bob)).data.storageScope;
assert.notEqual(scopeA, scopeB);
const status = await request('/api/telegram-status', alice);
assert.equal(status.status, 200);
assert.equal(status.data.active, false);
assert.equal(status.data.hasToken, false);
assert.equal(status.data.hasGeminiKey, false);
const home = await request('/', alice);
assert.equal(home.status, 200);
assert.match(home.data, /Örnek portföy/);
assert.match(home.data, /release-v14.17/);
console.log('HTTP checks passed: anonymous rejection, two isolated portfolios, persisted edits, revision conflict, cross-origin rejection, distinct local-storage scopes and disconnected integrations.');
