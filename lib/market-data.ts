type YahooChartResult = {
  meta?: Record<string, unknown>;
  timestamp?: number[];
  indicators?: {
    quote?: Array<Record<string, Array<number | null> | undefined>>;
  };
};

export type HistoryPoint = {
  ohlcComplete?: boolean; t: number; date: string; o: number; h: number; l: number; c: number; v: number };

export type MarketQuote = {
  symbol: string;
  price: number;
  currency: string;
  changePct: number;
  asOf: string;
  source: 'tradingview' | 'yahoo_finance';
  delayed: boolean;
  session: string;
  regularClose: number;
  extendedChangePct: number | null;
  logoid: string | null;
  priceType: string;
  cacheState?: 'live' | 'fresh' | 'stale';
  retrievedAt?: string;
};

export type TradingViewSnapshot = {
  quotes: Record<string, MarketQuote>;
  fxUsdTry: number | null;
};

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const TRADINGVIEW_SCAN_URL = 'https://scanner.tradingview.com/global/scan';
const SYMBOL_PATTERN = /^[A-Z0-9.^=_-]{1,24}$/;
const USER_AGENT = 'Mozilla/5.0 (compatible; YatirimDefterim/11.2; personal-portfolio-app)';
const cache = new Map<string, { expires: number; value: unknown }>();

function finite(value: unknown): number | null {
  // Number(null), Number('') and Number(false) are all zero in JavaScript.
  // Market-data providers use those values to mean "missing", so accepting
  // them creates fake zero-price candles and exactly -100% returns.
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positive(value: unknown): number | null {
  const number = finite(value);
  return number !== null && number > 0 ? number : null;
}

function textValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function rounded(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

export function cleanSymbols(raw: string | null, limit = 30): string[] {
  const unique = new Set<string>();
  for (const part of String(raw || '').split(',')) {
    const symbol = part.trim().toUpperCase();
    if (SYMBOL_PATTERN.test(symbol)) unique.add(symbol);
    if (unique.size >= limit) break;
  }
  return [...unique];
}

async function yahooChart(symbol: string, range: string, interval: string, includePrePost = false): Promise<YahooChartResult> {
  const key = `${symbol}|${range}|${interval}|${includePrePost ? 'extended' : 'regular'}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value as YahooChartResult;

  const url = `${YAHOO_BASE}/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=${includePrePost ? 'true' : 'false'}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`${symbol} fiyat servisi ${response.status} yanıtı verdi.`);
  const payload = await response.json() as { chart?: { result?: YahooChartResult[]; error?: { description?: string } } };
  const result = payload.chart?.result?.[0];
  if (!result) throw new Error(payload.chart?.error?.description || `${symbol} için fiyat bulunamadı.`);
  cache.set(key, { expires: Date.now() + (interval === '1m' ? 25_000 : 300_000), value: result });
  return result;
}

function closeSeries(chart: YahooChartResult): Array<{ t: number; c: number }> {
  const timestamps = chart.timestamp || [];
  const closes = chart.indicators?.quote?.[0]?.close || [];
  const points: Array<{ t: number; c: number }> = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const timestamp = positive(timestamps[index]);
    const close = positive(closes[index]);
    if (timestamp !== null && close !== null) points.push({ t: timestamp, c: close });
  }
  return points.sort((a, b) => a.t - b.t);
}

export async function fetchQuote(symbol: string): Promise<MarketQuote> {
  const chart = await yahooChart(symbol, '1d', '1m', true);
  const meta = chart.meta || {};
  const points = closeSeries(chart);
  const regularPrice = positive(meta.regularMarketPrice) ?? points.at(-1)?.c ?? null;
  const previousClose = positive(meta.chartPreviousClose) ?? positive(meta.previousClose);
  if (regularPrice === null) throw new Error(`${symbol} için geçerli fiyat bulunamadı.`);
  const isBist = symbol.endsWith('.IS');
  const market = marketSessionInfo(symbol);
  const regularMarketTime = positive(meta.regularMarketTime);
  const preMarketPrice = positive(meta.preMarketPrice);
  const preMarketTime = positive(meta.preMarketTime);
  const postMarketPrice = positive(meta.postMarketPrice);
  const postMarketTime = positive(meta.postMarketTime);
  let price = regularPrice;
  let asOfSeconds = regularMarketTime;
  let priceType = market.session === 'regular' ? 'last-trade' : isBist ? 'daily-close' : 'regular-close';
  let extendedChangePct: number | null = null;
  if (!isBist && market.session === 'pre-market' && preMarketPrice !== null) {
    price = preMarketPrice;
    asOfSeconds = preMarketTime ?? asOfSeconds;
    extendedChangePct = finite(meta.preMarketChangePercent);
    priceType = 'extended';
  } else if (!isBist && market.session === 'after-hours' && postMarketPrice !== null) {
    price = postMarketPrice;
    asOfSeconds = postMarketTime ?? asOfSeconds;
    extendedChangePct = finite(meta.postMarketChangePercent);
    priceType = 'extended';
  } else if (!isBist && market.session === 'closed' && postMarketPrice !== null && postMarketTime !== null
    && (!regularMarketTime || postMarketTime > regularMarketTime) && Date.now() / 1000 - postMarketTime < 7 * 86_400) {
    price = postMarketPrice;
    asOfSeconds = postMarketTime;
    extendedChangePct = finite(meta.postMarketChangePercent);
    priceType = 'extended-close';
  }
  const changePct = previousClose ? ((price / previousClose) - 1) * 100 : 0;

  return {
    symbol,
    price: rounded(price),
    currency: textValue(meta.currency, isBist ? 'TRY' : 'USD'),
    changePct: rounded(changePct, 2),
    asOf: new Date(asOfSeconds ? asOfSeconds * 1000 : Date.now()).toISOString(),
    source: 'yahoo_finance',
    delayed: true,
    session: market.session,
    regularClose: rounded(regularPrice),
    extendedChangePct: extendedChangePct === null ? null : rounded(extendedChangePct, 2),
    logoid: null,
    priceType,
  };
}

type MarketClock = { weekday: string; minutes: number; dateKey: string; year: number; month: number; day: number };
export type MarketSessionInfo = { session: string; latestExtendedClose: string | null };

function marketClock(timeZone: string, now = new Date()): MarketClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: string) => parts.find(item => item.type === type)?.value || '';
  const year = Number(part('year'));
  const month = Number(part('month'));
  const day = Number(part('day'));
  return {
    weekday: part('weekday'),
    minutes: Number(part('hour')) * 60 + Number(part('minute')),
    dateKey: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    year, month, day,
  };
}

function shiftDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days, 12)).toISOString().slice(0, 10);
}

function weekdayIndex(dateKey: string): number {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
}

function observedFixedDate(year: number, month: number, day: number): string {
  const base = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const weekday = weekdayIndex(base);
  return weekday === 6 ? shiftDateKey(base, -1) : weekday === 0 ? shiftDateKey(base, 1) : base;
}

function nthWeekdayDate(year: number, month: number, weekday: number, occurrence: number): string {
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  const day = 1 + ((weekday - weekdayIndex(first) + 7) % 7) + (occurrence - 1) * 7;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function lastWeekdayDate(year: number, month: number, weekday: number): string {
  const lastDay = new Date(Date.UTC(year, month, 0, 12)).getUTCDate();
  const last = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return shiftDateKey(last, -((weekdayIndex(last) - weekday + 7) % 7));
}

function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function usHolidayDates(year: number): Set<string> {
  return new Set([
    observedFixedDate(year, 1, 1),
    observedFixedDate(year + 1, 1, 1),
    nthWeekdayDate(year, 1, 1, 3),
    nthWeekdayDate(year, 2, 1, 3),
    shiftDateKey(easterSunday(year), -2),
    lastWeekdayDate(year, 5, 1),
    observedFixedDate(year, 6, 19),
    observedFixedDate(year, 7, 4),
    nthWeekdayDate(year, 9, 1, 1),
    nthWeekdayDate(year, 11, 4, 4),
    observedFixedDate(year, 12, 25),
  ]);
}

function isUsTradingDay(dateKey: string): boolean {
  const weekday = weekdayIndex(dateKey);
  const year = Number(dateKey.slice(0, 4));
  return weekday !== 0 && weekday !== 6 && !usHolidayDates(year).has(dateKey);
}

function isUsEarlyClose(dateKey: string): boolean {
  const year = Number(dateKey.slice(0, 4));
  const dayAfterThanksgiving = shiftDateKey(nthWeekdayDate(year, 11, 4, 4), 1);
  const christmasEve = `${year}-12-24`;
  const julyThird = `${year}-07-03`;
  return dateKey === dayAfterThanksgiving
    || (dateKey === christmasEve && isUsTradingDay(dateKey))
    || (dateKey === julyThird && isUsTradingDay(dateKey));
}

function zonedDateTimeToUtc(dateKey: string, hour: number, minute: number, timeZone: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let guess = desired;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const represented = marketClock(timeZone, new Date(guess));
    const representedUtc = Date.UTC(represented.year, represented.month - 1, represented.day, Math.floor(represented.minutes / 60), represented.minutes % 60);
    guess += desired - representedUtc;
  }
  return new Date(guess);
}

export function usMarketSessionInfo(now = new Date()): MarketSessionInfo {
  const clock = marketClock('America/New_York', now);
  const tradingDay = isUsTradingDay(clock.dateKey);
  const regularClose = isUsEarlyClose(clock.dateKey) ? 13 * 60 : 16 * 60;
  const extendedClose = isUsEarlyClose(clock.dateKey) ? 17 * 60 : 20 * 60;
  let session = 'closed';
  if (tradingDay && clock.minutes >= 4 * 60 && clock.minutes < 9 * 60 + 30) session = 'pre-market';
  else if (tradingDay && clock.minutes >= 9 * 60 + 30 && clock.minutes < regularClose) session = 'regular';
  else if (tradingDay && clock.minutes >= regularClose && clock.minutes < extendedClose) session = 'after-hours';

  let latestExtendedClose: string | null = null;
  if (session === 'closed') {
    let latestDate = clock.dateKey;
    if (!tradingDay || clock.minutes < 4 * 60) latestDate = shiftDateKey(latestDate, -1);
    while (!isUsTradingDay(latestDate)) latestDate = shiftDateKey(latestDate, -1);
    const closeHour = isUsEarlyClose(latestDate) ? 17 : 20;
    latestExtendedClose = zonedDateTimeToUtc(latestDate, closeHour, 0, 'America/New_York').toISOString();
  }
  return { session, latestExtendedClose };
}

export function marketSessionInfo(symbol: string, now = new Date()): MarketSessionInfo {
  if (symbol.endsWith('.IS')) {
    const clock = marketClock('Europe/Istanbul', now);
    if (clock.weekday === 'Sat' || clock.weekday === 'Sun') return { session: 'closed', latestExtendedClose: null };
    return { session: clock.minutes >= 10 * 60 && clock.minutes < 18 * 60 ? 'regular' : 'closed', latestExtendedClose: null };
  }
  return usMarketSessionInfo(now);
}

function tradingViewQuote(symbol: string, data: unknown[]): MarketQuote | null {
  const regularClose = positive(data[1]);
  if (regularClose === null) return null;
  const regularChange = finite(data[2]) ?? 0;
  const market = marketSessionInfo(symbol);
  const session = market.session;
  const premarketClose = positive(data[5]);
  const postmarketClose = positive(data[3]);
  let price = regularClose;
  let extendedChangePct: number | null = null;
  let priceType = session === 'regular' ? 'last-trade' : 'daily-close';
  let asOf = new Date().toISOString();

  if (session === 'pre-market' && premarketClose !== null) {
    price = premarketClose;
    extendedChangePct = finite(data[6]);
    priceType = 'extended';
  } else if (session === 'after-hours' && postmarketClose !== null) {
    price = postmarketClose;
    extendedChangePct = finite(data[4]);
    priceType = 'extended';
  } else if (!symbol.endsWith('.IS') && session === 'closed' && postmarketClose !== null && market.latestExtendedClose) {
    price = postmarketClose;
    extendedChangePct = finite(data[4]);
    priceType = 'extended-close';
    asOf = market.latestExtendedClose;
  }

  const previousClose = regularChange !== -100
    ? regularClose / (1 + regularChange / 100)
    : regularClose;
  const changePct = previousClose > 0 ? ((price / previousClose) - 1) * 100 : regularChange;
  const isBist = symbol.endsWith('.IS');

  return {
    symbol,
    price: rounded(price),
    currency: textValue(data[7], isBist ? 'TRY' : 'USD'),
    changePct: rounded(changePct, 2),
    asOf,
    source: 'tradingview',
    delayed: false,
    session,
    regularClose: rounded(regularClose),
    extendedChangePct: extendedChangePct === null ? null : rounded(extendedChangePct, 2),
    logoid: typeof data[14] === 'string' && data[14].trim() ? data[14].trim() : null,
    priceType,
  };
}

export async function fetchTradingViewSnapshot(symbols: string[]): Promise<TradingViewSnapshot> {
  const normalized = [...new Set(symbols.map(symbol => symbol.trim().toUpperCase()).filter(Boolean))];
  const cacheKey = `tradingview|${normalized.slice().sort().join(',')}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value as TradingViewSnapshot;

  const tickerToSymbol = new Map<string, string>();
  const tickers = ['FX_IDC:USDTRY', 'FX:USDTRY'];
  for (const symbol of normalized) {
    if (symbol.endsWith('.IS')) {
      const ticker = `BIST:${symbol.slice(0, -3)}`;
      tickers.push(ticker);
      tickerToSymbol.set(ticker, symbol);
    } else {
      for (const exchange of ['NASDAQ', 'NYSE', 'AMEX']) {
        const ticker = `${exchange}:${symbol}`;
        tickers.push(ticker);
        tickerToSymbol.set(ticker, symbol);
      }
    }
  }

  const response = await fetch(TRADINGVIEW_SCAN_URL, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      symbols: { tickers },
      columns: [
        'name', 'close', 'change', 'postmarket_close', 'postmarket_change',
        'premarket_close', 'premarket_change', 'currency', 'description',
        'Perf.1M', 'Perf.3M', 'Perf.6M', 'Perf.YTD', 'Perf.Y', 'logoid',
      ],
    }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`TradingView fiyat servisi ${response.status} yanıtı verdi.`);
  const payload = await response.json() as { data?: Array<{ s?: string; d?: unknown[] }> };
  const quotes: Record<string, MarketQuote> = {};
  let fxUsdTry: number | null = null;

  for (const item of payload.data || []) {
    const ticker = String(item.s || '');
    const data = Array.isArray(item.d) ? item.d : [];
    if (ticker === 'FX_IDC:USDTRY' || ticker === 'FX:USDTRY') {
      fxUsdTry ??= positive(data[1]);
      continue;
    }
    const symbol = tickerToSymbol.get(ticker);
    if (!symbol || quotes[symbol]) continue;
    const quote = tradingViewQuote(symbol, data);
    if (quote) quotes[symbol] = quote;
  }

  const snapshot = { quotes, fxUsdTry };
  cache.set(cacheKey, { expires: Date.now() + 25_000, value: snapshot });
  return snapshot;
}

function periodReturn(points: Array<{ t: number; c: number }>, target: number): number | null {
  const latest = points.at(-1)?.c;
  if (!latest || latest <= 0 || !points.length) return null;
  const start = points.filter(point => point.t <= target).at(-1);
  if (!start || target - start.t > 7 * 86_400) return null;
  return start.c > 0 ? rounded(((latest / start.c) - 1) * 100, 2) : null;
}

export async function fetchBenchmark(symbol: string, key: 'XU100' | 'SP500') {
  const chart = await yahooChart(symbol, '2y', '1d');
  const points = closeSeries(chart);
  if (points.length < 2) throw new Error(`${key} verisi alınamadı.`);
  const latest = points.at(-1)!;
  const previous = points.at(-2)!;
  const now = new Date(latest.t * 1000);
  const oneDay = rounded(((latest.c / previous.c) - 1) * 100, 2);
  const period = (months: number) => {
    const target = new Date(now);
    target.setUTCDate(1);
    target.setUTCMonth(target.getUTCMonth() - months);
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(now.getUTCDate(), lastDay));
    return periodReturn(points, target.getTime() / 1000);
  };
  const ytdTarget = Date.UTC(now.getUTCFullYear(), 0, 1) / 1000;

  return {
    name: key === 'XU100' ? 'BIST 100' : 'S&P 500',
    price: rounded(latest.c, 2),
    changePct: oneDay,
    currency: key === 'XU100' ? 'TRY' : 'USD',
    periods: {
      '1d': oneDay,
      '1m': period(1),
      '3m': period(3),
      '6m': period(6),
      ytd: periodReturn(points, ytdTarget),
      '1y': period(12),
    },
    chart: points.map(point => ({ t: point.t, c: rounded(point.c, 2) })),
  };
}

export async function fetchUsdTry(): Promise<number | null> {
  const chart = await yahooChart('TRY=X', '1d', '1m');
  const metaPrice = positive(chart.meta?.regularMarketPrice);
  return metaPrice ?? closeSeries(chart).at(-1)?.c ?? null;
}

const PERIOD_OPTIONS: Record<string, { range: string; interval: string }> = {
  '1d': { range: '1d', interval: '1m' },
  '1w': { range: '5d', interval: '5m' },
  '1mo': { range: '1mo', interval: '15m' },
  '3mo': { range: '3mo', interval: '1h' },
  '6mo': { range: '6mo', interval: '1d' },
  ytd: { range: 'ytd', interval: '1d' },
  '1y': { range: '1y', interval: '1d' },
  '2y': { range: '2y', interval: '1d' },
  '5y': { range: '5y', interval: '1d' },
  max: { range: 'max', interval: '1d' },
};

export function validPeriod(period: string): boolean {
  return Boolean(PERIOD_OPTIONS[period]);
}

export async function fetchHistory(symbol: string, period: string) {
  const option = PERIOD_OPTIONS[period];
  if (!option) throw new Error('Geçersiz fiyat dönemi.');
  const chart = await yahooChart(symbol, option.range, option.interval);
  const timestamps = chart.timestamp || [];
  const quote = chart.indicators?.quote?.[0] || {};
  const exchangeDate = (timestamp: number | null): string | null => {
    if (timestamp === null || !Number.isFinite(new Date(timestamp * 1000).getTime())) return null;
    try {
      return marketClock(textValue(chart.meta?.exchangeTimezoneName, 'UTC'), new Date(timestamp * 1000)).dateKey;
    } catch {
      return new Date((timestamp + (finite(chart.meta?.gmtoffset) ?? 0)) * 1000).toISOString().slice(0, 10);
    }
  };
  const points: HistoryPoint[] = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const timestamp = positive(timestamps[index]);
    const close = positive(quote.close?.[index]);
    if (timestamp === null || close === null) continue;
    const open = positive(quote.open?.[index]) ?? close;
    const rawHigh = positive(quote.high?.[index]) ?? close;
    const rawLow = positive(quote.low?.[index]) ?? close;
    const high = Math.max(rawHigh, rawLow, open, close);
    const low = Math.min(rawHigh, rawLow, open, close);
    const volume = finite(quote.volume?.[index]) ?? 0;
    const tradingDate = exchangeDate(timestamp);
    if (!tradingDate) continue;
    points.push({
      t: timestamp,
      ohlcComplete: positive(quote.high?.[index]) !== null && positive(quote.low?.[index]) !== null
        && Number(quote.high?.[index]) >= Math.max(Number(quote.low?.[index]), close, open)
        && Number(quote.low?.[index]) <= Math.min(close, open),
      date: tradingDate,
      o: rounded(open), h: rounded(high), l: rounded(low), c: rounded(close), v: Math.max(0, volume),
    });
  }
  if (!points.length) throw new Error('Geçmiş fiyat verisi alınamadı.');
  points.sort((a, b) => a.t - b.t);
  return {
    symbol,
    period,
    currency: textValue(chart.meta?.currency, symbol.endsWith('.IS') ? 'TRY' : 'USD'),
    source: 'yahoo_finance',
    points,
    firstTradeDate: exchangeDate(positive(chart.meta?.firstTradeDate)),
  };
}
