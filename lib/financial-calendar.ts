export type FinancialCalendarEvent = {
  id: string;
  date: string;
  type: 'earnings';
  title: string;
  symbol: string;
  source: 'nasdaq';
  sourceLabel: string;
  sourceUrl: string;
  certainty: 'estimated';
  certaintyLabel: string;
  detail: string;
  session?: string;
};

type NasdaqRow = {
  symbol?: unknown;
  name?: unknown;
  time?: unknown;
  fiscalQuarterEnding?: unknown;
  epsForecast?: unknown;
};

const NASDAQ_EARNINGS_URL = 'https://www.nasdaq.com/market-activity/earnings';
const NASDAQ_API_URL = 'https://api.nasdaq.com/api/calendar/earnings';
const NASDAQ_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Origin: 'https://www.nasdaq.com',
  Referer: 'https://www.nasdaq.com/',
};

function validDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`));
}

function addDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function weekdayDateRange(from: string, dayCount: number): string[] {
  if (!validDateKey(from)) return [];
  const safeDays = Math.max(0, Math.min(45, Math.trunc(dayCount)));
  const dates: string[] = [];
  for (let offset = 0; offset <= safeDays; offset += 1) {
    const date = addDays(from, offset);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) dates.push(date);
  }
  return dates;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function nasdaqSessionLabel(value: unknown): string {
  const session = text(value).toLowerCase();
  if (session === 'time-pre-market') return 'Piyasa açılmadan önce';
  if (session === 'time-after-hours') return 'Piyasa kapandıktan sonra';
  return 'Saat henüz belirtilmedi';
}

export function normalizeNasdaqEvents(date: string, rows: NasdaqRow[], requestedSymbols: string[]): FinancialCalendarEvent[] {
  if (!validDateKey(date)) return [];
  const requested = new Set(requestedSymbols.map(symbol => symbol.trim().toUpperCase()).filter(Boolean));
  return rows.flatMap(row => {
    const symbol = text(row.symbol).toUpperCase();
    if (!requested.has(symbol)) return [];
    const company = text(row.name);
    const quarter = text(row.fiscalQuarterEnding);
    const session = nasdaqSessionLabel(row.time);
    const detailParts = [
      'Tarih, geçmiş raporlama düzenine dayalı Nasdaq/Zacks tahminidir; şirketin resmî duyurusu kesinleştiğinde değişebilir.',
      quarter ? `Rapor dönemi: ${quarter}.` : '',
      session,
    ].filter(Boolean);
    return [{
      id: `nasdaq:${date}:${symbol}`,
      date,
      type: 'earnings' as const,
      title: `${symbol} bilanço tahmini`,
      symbol,
      source: 'nasdaq' as const,
      sourceLabel: 'Nasdaq / Zacks',
      sourceUrl: NASDAQ_EARNINGS_URL,
      certainty: 'estimated' as const,
      certaintyLabel: 'Tahmini',
      detail: `${company ? `${company}. ` : ''}${detailParts.join(' ')}`,
      session,
    }];
  });
}

async function fetchNasdaqDate(date: string, symbols: string[]): Promise<FinancialCalendarEvent[]> {
  const response = await fetch(`${NASDAQ_API_URL}?date=${encodeURIComponent(date)}`, {
    headers: NASDAQ_HEADERS,
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Nasdaq takvim servisi ${response.status} yanıtı verdi.`);
  const payload = await response.json() as { data?: { rows?: NasdaqRow[] | null } | null };
  return normalizeNasdaqEvents(date, Array.isArray(payload.data?.rows) ? payload.data.rows : [], symbols);
}

export async function fetchAutomaticFinancialCalendar(symbols: string[], from: string, dayCount: number): Promise<{
  events: FinancialCalendarEvent[];
  warnings: string[];
  usRangeDays: number;
}> {
  const safeDays = Math.max(7, Math.min(180, Math.trunc(dayCount) || 90));
  const usSymbols = symbols.filter(symbol => !symbol.endsWith('.IS'));
  const events: FinancialCalendarEvent[] = [];
  const warnings: string[] = [];
  const usRangeDays = Math.min(safeDays, 45);

  if (usSymbols.length) {
    const results = await Promise.allSettled(weekdayDateRange(from, usRangeDays).map(date => fetchNasdaqDate(date, usSymbols)));
    let failureCount = 0;
    for (const result of results) {
      if (result.status === 'fulfilled') events.push(...result.value);
      else failureCount += 1;
    }
    if (failureCount === results.length) warnings.push('ABD bilanço takvimine şu anda ulaşılamıyor.');
    else if (failureCount >= Math.max(3, Math.ceil(results.length * 0.25))) warnings.push('ABD bilanço takviminin bazı günleri daha sonra yeniden kontrol edilecek.');
  }

  const unique = new Map(events.map(event => [event.id, event]));
  return {
    events: [...unique.values()].sort((left, right) => left.date.localeCompare(right.date) || left.symbol.localeCompare(right.symbol)),
    warnings,
    usRangeDays,
  };
}
