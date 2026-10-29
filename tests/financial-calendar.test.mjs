import assert from 'node:assert/strict';
import test from 'node:test';
import { nasdaqSessionLabel, normalizeNasdaqEvents, weekdayDateRange } from '../lib/financial-calendar.ts';

test('Nasdaq satırları yalnızca izlenen semboller için tahmini olaya dönüşür', () => {
  const events = normalizeNasdaqEvents('2026-09-16', [
    { symbol: 'NVDA', name: 'NVIDIA Corp', time: 'time-after-hours', fiscalQuarterEnding: 'Jul/2026' },
    { symbol: 'OTHER', name: 'Other Corp', time: 'time-pre-market' },
  ], ['NVDA']);
  assert.equal(events.length, 1);
  assert.equal(events[0].symbol, 'NVDA');
  assert.equal(events[0].certainty, 'estimated');
  assert.equal(events[0].session, 'Piyasa kapandıktan sonra');
  assert.equal(nasdaqSessionLabel('time-pre-market'), 'Piyasa açılmadan önce');
});

test('ABD sorgu günleri hafta sonlarını atlar ve 45 günle sınırlanır', () => {
  const dates = weekdayDateRange('2026-09-12', 90);
  assert.equal(dates[0], '2026-09-14');
  assert.ok(dates.every(date => ![0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay())));
  assert.ok(dates.at(-1) <= '2026-10-27');
});
