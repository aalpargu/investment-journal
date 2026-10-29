import assert from 'node:assert/strict';
import { extractTransactionsFromImage, FundCodeRequiredError, normalizeTransaction } from '../lib/gemini.ts';

const transaction = normalizeTransaction({
  symbol: 'NVDA',
  market: 'ABD',
  type: 'SELL',
  quantity: 3.065513807,
  price: 218.01,
  fee: 1.5,
  total: 666.82,
  date: '2026-09-01',
  currency: 'USD',
  name: 'NVIDIA',
});

assert.ok(transaction);
assert.equal(transaction.quotedPrice, 218.01);
assert.equal(transaction.fee, 1.5);
assert.equal(transaction.total, 666.82);
assert.ok(Math.abs(Number(transaction.quantity) * Number(transaction.price) - Number(transaction.fee) - 666.82) < 1e-8);

const turkishFundSale = normalizeTransaction({
  symbol: 'TP2',
  market: 'BIST',
  type: 'SELL',
  quantity: '1.346',
  price: '2,209513',
  fee: '0',
  total: '2.974,004498',
  date: '2026-09-04',
  currency: 'TRY',
  name: 'Tera Portföy Para Piyasası Fonu',
});

assert.ok(turkishFundSale);
assert.equal(turkishFundSale.quantity, 1346);
assert.ok(Math.abs(Number(turkishFundSale.quotedPrice) - 2.209513) < 1e-9);
assert.ok(Math.abs(Number(turkishFundSale.total) - 2974.004498) < 1e-9);
assert.ok(Math.abs(Number(turkishFundSale.quantity) * Number(turkishFundSale.price) - 2974.004498) < 1e-8);

const screenshotFundSale = {
  symbol: '',
  market: 'TEFAS',
  type: 'Fon satış',
  quantity: '1.346',
  price: '2,209513',
  fee: '0',
  total: '2.974,004498',
  date: '4 Eylül 2026, 14:36:00',
  currency: 'TRY',
  name: 'Tera Portföy Para Piyasası Fonu',
};
const screenshotTransaction = normalizeTransaction(screenshotFundSale);
assert.ok(screenshotTransaction);
assert.equal(screenshotTransaction.symbol, 'TP2');
assert.equal(screenshotTransaction.market, 'FON');
assert.equal(screenshotTransaction.type, 'SELL');
assert.equal(screenshotTransaction.quantity, 1346);
assert.equal(screenshotTransaction.quotedPrice, 2.209513);
assert.equal(screenshotTransaction.total, 2974.004498);
assert.equal(screenshotTransaction.date, '2026-09-04');
assert.equal(screenshotTransaction.currency, 'TRY');

const screenshotFundBuy = normalizeTransaction({ ...screenshotFundSale, type: 'Fon alış', market: 'FON' });
assert.equal(screenshotFundBuy?.type, 'BUY');
assert.equal(screenshotFundBuy?.market, 'FON');

const unknownFundSale = { ...screenshotFundSale, name: 'Başka Portföy Para Piyasası Fonu' };
assert.equal(normalizeTransaction(unknownFundSale), null);

const originalFetch = globalThis.fetch;
const requests = [];
let responseTransaction = screenshotFundSale;
try {
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ transactions: [responseTransaction] }) }] } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const extracted = await extractTransactionsFromImage(new Uint8Array([1, 2, 3]), 'image/jpeg', 'test-key');
  assert.equal(extracted.transactions.length, 1);
  assert.equal(extracted.transactions[0].symbol, 'TP2');
  assert.equal(extracted.transactions[0].market, 'FON');
  assert.equal(extracted.transactions[0].quantity, 1346);
  assert.match(requests[0].contents[0].parts[1].text, /yatırım fonu işlemlerini/);
  assert.match(requests[0].contents[0].parts[1].text, /fon kodunu tahmin etme/);

  responseTransaction = unknownFundSale;
  await assert.rejects(
    extractTransactionsFromImage(new Uint8Array([1, 2, 3]), 'image/jpeg', 'test-key'),
    error => error instanceof FundCodeRequiredError && /Fon kodu/.test(error.message),
  );
  const captionResolved = await extractTransactionsFromImage(
    new Uint8Array([1, 2, 3]), 'image/jpeg', 'test-key', 'kod: ABC',
  );
  assert.equal(captionResolved.transactions[0].symbol, 'ABC');
  assert.equal(captionResolved.transactions[0].market, 'FON');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('Telegram hisse ve fon görseli, sayı biçimi, komisyon ve net toplam testleri geçti.');
