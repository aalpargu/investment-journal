type JsonObject = { [key: string]: unknown };
type SecEntry = JsonObject & {
  val?: unknown;
  form?: unknown;
  fp?: unknown;
  frame?: unknown;
  start?: unknown;
  end?: unknown;
  filed?: unknown;
  accn?: unknown;
};

type SecTicker = { cik: number; name: string; exchange: string };

const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SEC_FACTS_URL = 'https://data.sec.gov/api/xbrl/companyfacts/CIK';
const SEC_USER_AGENT_PREFIX = 'YatirimDefterim/11.2 PersonalPortfolio';
const EMAIL_PATTERN = /^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,63}$/;
const FORMS = new Set(['10-K', '10-K/A', '10-Q', '10-Q/A']);
const tickerCache = new Map<string, { expiresAt: number; value: SecTicker }>();
const factsCache = new Map<string, { expiresAt: number; value: JsonObject }>();

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}`;
  if (typeof value === 'bigint') return `${value}`;
  return '';
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rounded(value: number | null, digits = 4): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const multiplier = 10 ** digits;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
}

function dayDifference(end: unknown, start: unknown): number | null {
  const endTime = Date.parse(textValue(end));
  const startTime = Date.parse(textValue(start));
  return Number.isFinite(endTime) && Number.isFinite(startTime)
    ? Math.round((endTime - startTime) / 86_400_000)
    : null;
}

function secUserAgent(contactEmail: string): string {
  const contact = contactEmail.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(contact)) throw new Error('SEC erişimi için geçerli bir iletişim e-postası gerekli.');
  return `${SEC_USER_AGENT_PREFIX} ${contact}`;
}

async function secJson(url: string, contactEmail: string): Promise<JsonObject> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': secUserAgent(contactEmail) },
    signal: AbortSignal.timeout(18_000),
  });
  if (!response.ok) throw new Error(`SEC EDGAR isteği başarısız oldu (HTTP ${response.status}).`);
  return object(await response.json());
}

async function fetchTicker(symbol: string, contactEmail: string): Promise<SecTicker> {
  const normalized = symbol.replace('.', '-').toUpperCase();
  const cached = tickerCache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const payload = await secJson(SEC_TICKERS_URL, contactEmail);
  for (const value of Object.values(payload)) {
    const record = object(value);
    if (textValue(record.ticker).trim().toUpperCase() !== normalized) continue;
    const cik = finite(record.cik_str);
    if (cik === null) break;
    const ticker = { cik: Math.trunc(cik), name: textValue(record.title).trim() || normalized, exchange: '' };
    tickerCache.set(normalized, { expiresAt: Date.now() + 86_400_000, value: ticker });
    return ticker;
  }
  throw new Error('Sembol SEC şirket listesinde bulunamadı.');
}

function factEntries(payload: JsonObject, taxonomy: string, tags: string[], unit: string): SecEntry[] {
  const taxonomyFacts = object(object(payload.facts)[taxonomy]);
  const result: SecEntry[] = [];
  for (const tag of tags) {
    const units = object(object(taxonomyFacts[tag]).units);
    for (const raw of array(units[unit])) {
      const entry = object(raw) as SecEntry;
      if (finite(entry.val) !== null) result.push(entry);
    }
  }
  return result;
}

function preferredEntries(payload: JsonObject, taxonomy: string, tags: string[], unit: string): [SecEntry[], string | null] {
  const taxonomyFacts = object(object(payload.facts)[taxonomy]);
  let selected: SecEntry[] = [];
  let selectedTag: string | null = null;
  let selectedLatestEnd = '';
  for (const tag of tags) {
    const entries = array(object(object(taxonomyFacts[tag]).units)[unit])
      .map(value => object(value) as SecEntry)
      .filter(entry => finite(entry.val) !== null && FORMS.has(textValue(entry.form)));
    if (!entries.length) continue;
    const latestEnd = entries.reduce((latest, entry) => Math.max(latest.localeCompare(textValue(entry.end)), 0) === latest.localeCompare(textValue(entry.end)) ? latest : textValue(entry.end), '');
    if (latestEnd > selectedLatestEnd) {
      selected = entries;
      selectedTag = tag;
      selectedLatestEnd = latestEnd;
    }
  }
  return [selected, selectedTag];
}

function dedupe(entries: SecEntry[], keyName: keyof SecEntry): SecEntry[] {
  const selected = new Map<string, SecEntry>();
  for (const entry of entries) {
    const key = textValue(entry[keyName]);
    if (!key) continue;
    const previous = selected.get(key);
    const rank = `${textValue(entry.filed)}|${textValue(entry.accn)}`;
    const previousRank = previous ? `${textValue(previous.filed)}|${textValue(previous.accn)}` : '';
    if (!previous || rank > previousRank) selected.set(key, entry);
  }
  return [...selected.values()].sort((left, right) => textValue(left.end).localeCompare(textValue(right.end)));
}

function annualFacts(entries: SecEntry[]): SecEntry[] {
  return dedupe(entries.filter(entry => {
    const duration = dayDifference(entry.end, entry.start);
    return ['10-K', '10-K/A'].includes(textValue(entry.form))
      && textValue(entry.fp) === 'FY'
      && duration !== null && duration >= 300 && duration <= 430;
  }), 'end');
}

function quarterlyFacts(entries: SecEntry[]): SecEntry[] {
  return dedupe(entries.filter(entry => {
    const duration = dayDifference(entry.end, entry.start);
    return ['10-Q', '10-Q/A'].includes(textValue(entry.form))
      && /^CY\d{4}Q[1-4]$/.test(textValue(entry.frame))
      && duration !== null && duration >= 60 && duration <= 150;
  }), 'frame');
}

function interimFacts(entries: SecEntry[]): SecEntry[] {
  const limits: Record<string, [number, number]> = { Q1: [60, 150], Q2: [120, 230], Q3: [210, 320] };
  const selected = new Map<string, { entry: SecEntry; duration: number }>();
  for (const entry of entries) {
    const fp = textValue(entry.fp);
    const duration = dayDifference(entry.end, entry.start);
    const limit = limits[fp];
    if (!['10-Q', '10-Q/A'].includes(textValue(entry.form)) || !limit || duration === null || duration < limit[0] || duration > limit[1]) continue;
    const end = textValue(entry.end);
    if (!end) continue;
    const previous = selected.get(end);
    const rank = `${String(duration).padStart(4, '0')}|${textValue(entry.filed)}|${textValue(entry.accn)}`;
    const previousRank = previous ? `${String(previous.duration).padStart(4, '0')}|${textValue(previous.entry.filed)}|${textValue(previous.entry.accn)}` : '';
    if (!previous || rank > previousRank) selected.set(end, { entry, duration });
  }
  return [...selected.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value.entry);
}

function instantFacts(entries: SecEntry[]): SecEntry[] {
  return dedupe(entries.filter(entry => FORMS.has(textValue(entry.form)) && Boolean(textValue(entry.end))), 'end');
}

function entryValue(entry: SecEntry | null | undefined): number | null {
  return entry ? finite(entry.val) : null;
}

function sameQuarter(entries: SecEntry[], frame: string, yearsBack: number): SecEntry | null {
  const match = /^CY(\d{4})Q([1-4])$/.exec(frame);
  if (!match) return null;
  const target = `CY${Number(match[1]) - yearsBack}Q${match[2]}`;
  return entries.find(entry => textValue(entry.frame) === target) || null;
}

function priorComparableInterim(interims: SecEntry[], current: SecEntry): SecEntry | null {
  const currentDuration = dayDifference(current.end, current.start);
  const currentEnd = Date.parse(textValue(current.end));
  if (currentDuration === null || !Number.isFinite(currentEnd)) return null;
  return interims.filter(entry => {
    if (entry === current || textValue(entry.fp) !== textValue(current.fp)) return false;
    const duration = dayDifference(entry.end, entry.start);
    const end = Date.parse(textValue(entry.end));
    if (duration === null || !Number.isFinite(end)) return false;
    const age = Math.round((currentEnd - end) / 86_400_000);
    return age >= 330 && age <= 400 && Math.abs(duration - currentDuration) <= 35;
  }).at(-1) || null;
}

function ttmFromAnnualAndQuarter(annuals: SecEntry[], quarters: SecEntry[]): [number | null, number | null] {
  const latestAnnual = annuals.at(-1);
  const latestAnnualValue = entryValue(latestAnnual);
  if (!latestAnnual || latestAnnualValue === null) return [null, null];
  const newer = quarters.filter(entry => textValue(entry.end) > textValue(latestAnnual.end));
  if (!newer.length) return [latestAnnualValue, null];
  const priors = newer.map(entry => sameQuarter(quarters, textValue(entry.frame), 1));
  if (priors.some(entry => !entry)) return [null, null];
  const currentTtm = latestAnnualValue
    + newer.reduce((sum, entry) => sum + (entryValue(entry) || 0), 0)
    - priors.reduce((sum, entry) => sum + (entryValue(entry) || 0), 0);
  const priorAnnual = annuals.at(-2);
  if (!priorAnnual) return [currentTtm, null];
  const older = newer.map(entry => sameQuarter(quarters, textValue(entry.frame), 2));
  if (older.some(entry => !entry)) return [currentTtm, null];
  const priorTtm = (entryValue(priorAnnual) || 0)
    + priors.reduce((sum, entry) => sum + (entryValue(entry) || 0), 0)
    - older.reduce((sum, entry) => sum + (entryValue(entry) || 0), 0);
  return [currentTtm, priorTtm];
}

function ttmFromAnnualAndInterim(annuals: SecEntry[], interims: SecEntry[], targetEnd: string | null = null): number | null {
  const latestAnnual = annuals.at(-1);
  const annualValue = entryValue(latestAnnual);
  if (!latestAnnual || annualValue === null) return null;
  const newer = interims.filter(entry => textValue(entry.end) > textValue(latestAnnual.end));
  if (!newer.length) return targetEnd && targetEnd !== textValue(latestAnnual.end) ? null : annualValue;
  const latestInterim = targetEnd ? newer.find(entry => textValue(entry.end) === targetEnd) : newer.at(-1);
  const currentValue = entryValue(latestInterim);
  const latestEnd = latestInterim ? Date.parse(textValue(latestInterim.end)) : NaN;
  const latestDuration = latestInterim ? dayDifference(latestInterim.end, latestInterim.start) : null;
  if (!latestInterim || currentValue === null || !Number.isFinite(latestEnd) || latestDuration === null) return null;
  const prior = interims.filter(entry => {
    if (entry === latestInterim || textValue(entry.fp) !== textValue(latestInterim.fp)) return false;
    const end = Date.parse(textValue(entry.end));
    const duration = dayDifference(entry.end, entry.start);
    if (!Number.isFinite(end) || duration === null) return false;
    const age = Math.round((latestEnd - end) / 86_400_000);
    return age >= 330 && age <= 400 && Math.abs(duration - latestDuration) <= 35;
  }).at(-1);
  const priorValue = entryValue(prior);
  return priorValue === null ? null : annualValue + currentValue - priorValue;
}

function latestInstantMetric(payload: JsonObject, tags: string[], asOf: string | null = null): JsonObject | null {
  const [entries, tag] = preferredEntries(payload, 'us-gaap', tags, 'USD');
  const instants = instantFacts(entries);
  const latest = asOf ? instants.findLast(entry => textValue(entry.end) === asOf) : instants.at(-1);
  return latest ? { value: entryValue(latest), tag, end: latest.end, filed: latest.filed } : null;
}

function recordValue(record: JsonObject | null | undefined): number | null {
  return record ? finite(record.value) : null;
}

function completeSum(values: Array<number | null>): number | null {
  return values.length && values.every(value => value !== null) ? values.reduce<number>((sum, value) => sum + (value || 0), 0) : null;
}

export function buildSecFundamentals(symbol: string, ticker: SecTicker, payload: JsonObject): JsonObject {
  const [revenueEntries, revenueTag] = preferredEntries(payload, 'us-gaap', ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'], 'USD');
  const [epsEntries, epsTag] = preferredEntries(payload, 'us-gaap', ['EarningsPerShareDiluted'], 'USD/shares');
  const sharesEntries = factEntries(payload, 'dei', ['EntityCommonStockSharesOutstanding'], 'shares');
  const revenueInterims = interimFacts(revenueEntries);
  const epsQuarters = quarterlyFacts(epsEntries);
  const epsAnnuals = annualFacts(epsEntries);
  let latestRevenue = revenueInterims.at(-1) || null;
  let priorRevenue = latestRevenue ? priorComparableInterim(revenueInterims, latestRevenue) : null;
  let revenueGrowthBasis: string | null = latestRevenue ? 'YTD' : null;
  const revenueAnnuals = annualFacts(revenueEntries);
  if (!latestRevenue && revenueAnnuals.length >= 2) {
    latestRevenue = revenueAnnuals.at(-1) || null;
    priorRevenue = revenueAnnuals.at(-2) || null;
    revenueGrowthBasis = 'FY';
  }
  const revenueValue = entryValue(latestRevenue);
  const priorRevenueValue = entryValue(priorRevenue);
  const revenueGrowth = revenueValue !== null && priorRevenueValue !== null && priorRevenueValue !== 0
    ? (revenueValue / priorRevenueValue - 1) * 100 : null;
  const [trailingEps, priorTrailingEps] = ttmFromAnnualAndQuarter(epsAnnuals, epsQuarters);
  const epsGrowth = trailingEps !== null && priorTrailingEps !== null && priorTrailingEps !== 0
    ? (trailingEps / priorTrailingEps - 1) * 100 : null;
  const latestShares = sharesEntries.toSorted((left, right) => `${textValue(right.end)}|${textValue(right.filed)}`.localeCompare(`${textValue(left.end)}|${textValue(left.filed)}`))[0] || null;

  const incomeConcepts: Record<string, string[]> = {
    grossProfit: ['GrossProfit'], operatingIncome: ['OperatingIncomeLoss'], netIncome: ['NetIncomeLoss'],
  };
  const incomeData: Record<string, { entries: SecEntry[]; annuals: SecEntry[]; ttm: number | null }> = {};
  const concepts: Record<string, string | null> = { revenue: revenueTag, dilutedEps: epsTag };
  for (const [key, tags] of Object.entries(incomeConcepts)) {
    const [entries, tag] = preferredEntries(payload, 'us-gaap', tags, 'USD');
    const annuals = annualFacts(entries);
    incomeData[key] = { entries, annuals, ttm: ttmFromAnnualAndInterim(annuals, interimFacts(entries)) };
    concepts[key] = tag;
  }
  const latestRevenueAnnualEnd = revenueAnnuals.length ? textValue(revenueAnnuals.at(-1)?.end) : '';
  const newerRevenueInterims = revenueInterims.filter(entry => latestRevenueAnnualEnd && textValue(entry.end) > latestRevenueAnnualEnd);
  const ttmPeriodEnd = newerRevenueInterims.length ? textValue(newerRevenueInterims.at(-1)?.end) : latestRevenueAnnualEnd || null;
  const trailingRevenue = ttmFromAnnualAndInterim(revenueAnnuals, revenueInterims, ttmPeriodEnd);
  for (const data of Object.values(incomeData)) data.ttm = ttmPeriodEnd ? ttmFromAnnualAndInterim(data.annuals, interimFacts(data.entries), ttmPeriodEnd) : null;

  const cashFlowConcepts: Record<string, string[]> = {
    operatingCashFlow: ['NetCashProvidedByUsedInOperatingActivities'],
    capitalExpenditures: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'],
  };
  const cashFlowData: Record<string, { annuals: SecEntry[]; ttm: number | null }> = {};
  for (const [key, tags] of Object.entries(cashFlowConcepts)) {
    const [entries, tag] = preferredEntries(payload, 'us-gaap', tags, 'USD');
    const annuals = annualFacts(entries);
    cashFlowData[key] = { annuals, ttm: ttmPeriodEnd ? ttmFromAnnualAndInterim(annuals, interimFacts(entries), ttmPeriodEnd) : null };
    concepts[key] = tag;
  }
  const operatingCashFlow = cashFlowData.operatingCashFlow.ttm;
  const rawCapex = cashFlowData.capitalExpenditures.ttm;
  const capitalExpenditures = rawCapex !== null && rawCapex >= 0 ? rawCapex : null;
  const freeCashFlow = operatingCashFlow !== null && capitalExpenditures !== null ? operatingCashFlow - capitalExpenditures : null;

  const balanceConcepts: Record<string, string[]> = {
    cashAndEquivalents: ['CashAndCashEquivalentsAtCarryingValue'],
    shortTermInvestments: ['ShortTermInvestments', 'MarketableSecuritiesCurrent'],
    currentAssets: ['AssetsCurrent'], currentLiabilities: ['LiabilitiesCurrent'], totalAssets: ['Assets'],
    totalLiabilities: ['Liabilities'], equity: ['StockholdersEquity'], shortTermBorrowings: ['ShortTermBorrowings'],
    longTermDebtCurrent: ['LongTermDebtCurrent'], longTermDebtNoncurrent: ['LongTermDebtNoncurrent'],
  };
  const anchorAssets = latestInstantMetric(payload, balanceConcepts.totalAssets);
  const balanceAsOf = anchorAssets ? textValue(anchorAssets.end) : null;
  const balanceRecords: Record<string, JsonObject | null> = {};
  for (const [key, tags] of Object.entries(balanceConcepts)) {
    const record = latestInstantMetric(payload, tags, balanceAsOf);
    balanceRecords[key] = record;
    concepts[key] = record ? textValue(record.tag) || null : null;
  }
  const cash = recordValue(balanceRecords.cashAndEquivalents);
  const investments = recordValue(balanceRecords.shortTermInvestments);
  const debtValues = [recordValue(balanceRecords.shortTermBorrowings), recordValue(balanceRecords.longTermDebtCurrent), recordValue(balanceRecords.longTermDebtNoncurrent)];
  const totalDebt = completeSum(debtValues);
  const totalCash = cash !== null ? cash + (investments || 0) : null;

  const annualMaps: Record<string, Map<string, SecEntry>> = {};
  for (const key of ['netIncome', 'grossProfit', 'operatingIncome']) annualMaps[key] = new Map(incomeData[key].annuals.map(entry => [textValue(entry.end), entry]));
  for (const key of ['operatingCashFlow', 'capitalExpenditures']) annualMaps[key] = new Map(cashFlowData[key].annuals.map(entry => [textValue(entry.end), entry]));
  const annualSeries = revenueAnnuals.slice(-5).map(revenueEntry => {
    const periodEnd = textValue(revenueEntry.end);
    const cfo = entryValue(annualMaps.operatingCashFlow.get(periodEnd));
    const rawAnnualCapex = entryValue(annualMaps.capitalExpenditures.get(periodEnd));
    const capex = rawAnnualCapex !== null && rawAnnualCapex >= 0 ? rawAnnualCapex : null;
    return {
      periodEnd: periodEnd || null, filedAt: revenueEntry.filed,
      revenue: rounded(entryValue(revenueEntry), 0), grossProfit: rounded(entryValue(annualMaps.grossProfit.get(periodEnd)), 0),
      operatingIncome: rounded(entryValue(annualMaps.operatingIncome.get(periodEnd)), 0), netIncome: rounded(entryValue(annualMaps.netIncome.get(periodEnd)), 0),
      operatingCashFlow: rounded(cfo, 0), capitalExpenditures: rounded(capex, 0),
      freeCashFlow: cfo !== null && capex !== null ? rounded(cfo - capex, 0) : null,
    };
  });
  const warnings: string[] = [];
  const notes: string[] = [];
  if (!latestRevenue || !priorRevenue) warnings.push('SEC kaydında karşılaştırılabilir yıllık/YTD ciro dönemi bulunamadı.');
  if (trailingEps === null) warnings.push('SEC kaydından son on iki aylık seyreltilmiş EPS üretilemedi.');
  if (!latestShares) warnings.push('SEC kaydında güncel dolaşımdaki pay adedi bulunamadı.');
  if (trailingRevenue === null || incomeData.netIncome.ttm === null) warnings.push('Derin temel analiz için bazı TTM gelir tablosu kalemleri üretilemedi.');
  if (operatingCashFlow === null || capitalExpenditures === null) warnings.push('SEC kaydından karşılaştırılabilir TTM serbest nakit akışı üretilemedi.');
  if (rawCapex !== null && rawCapex < 0) warnings.push('Capex etiketi beklenmeyen işaretle raporlandığı için serbest nakit akışı hesaplanmadı.');
  if (totalDebt === null) warnings.push('Aynı tarihli borç bileşenleri eksik olduğu için toplam borç ve net nakit hesaplanmadı.');
  if (concepts.capitalExpenditures === 'PaymentsToAcquireProductiveAssets') notes.push("Capex, şirketin güncel standart 'üretken varlık alımları' etiketiyle temsil edildi.");
  const filedDates = [latestRevenue, latestShares, epsAnnuals.at(-1)].filter(Boolean).map(entry => textValue(entry?.filed)).filter(Boolean);
  return {
    schemaVersion: 3,
    symbol,
    identity: { name: textValue(payload.entityName) || ticker.name || symbol, exchange: ticker.exchange, currency: 'USD', cik: ticker.cik },
    fundamentals: {
      sharesOutstanding: rounded(entryValue(latestShares), 0), sharesAsOf: latestShares?.end || null,
      revenueQuarter: rounded(revenueValue, 0), revenuePriorYearQuarter: rounded(priorRevenueValue, 0),
      revenueGrowthYoYPct: rounded(revenueGrowth, 2), revenuePeriodEnd: latestRevenue?.end || null,
      revenueGrowthBasis, trailingEps: rounded(trailingEps, 4), epsGrowthYoYPct: rounded(epsGrowth, 2),
      reportingFiledAt: filedDates.length ? filedDates.toSorted().at(-1) : null,
      ttm: {
        revenue: rounded(trailingRevenue, 0), grossProfit: rounded(incomeData.grossProfit.ttm, 0),
        operatingIncome: rounded(incomeData.operatingIncome.ttm, 0), netIncome: rounded(incomeData.netIncome.ttm, 0),
        dilutedEps: rounded(trailingEps, 4), operatingCashFlow: rounded(operatingCashFlow, 0),
        capitalExpenditures: rounded(capitalExpenditures, 0), freeCashFlow: rounded(freeCashFlow, 0),
      },
      balanceSheet: {
        asOf: balanceAsOf, cashAndEquivalents: rounded(cash, 0), shortTermInvestments: rounded(investments, 0), totalCash: rounded(totalCash, 0),
        currentAssets: rounded(recordValue(balanceRecords.currentAssets), 0), currentLiabilities: rounded(recordValue(balanceRecords.currentLiabilities), 0),
        totalAssets: rounded(recordValue(balanceRecords.totalAssets), 0), totalLiabilities: rounded(recordValue(balanceRecords.totalLiabilities), 0),
        equity: rounded(recordValue(balanceRecords.equity), 0), shortTermBorrowings: rounded(debtValues[0], 0),
        longTermDebtCurrent: rounded(debtValues[1], 0), longTermDebtNoncurrent: rounded(debtValues[2], 0),
        totalDebt: rounded(totalDebt, 0), debtComponentsComplete: totalDebt !== null,
      },
      ttmPeriod: { end: ttmPeriodEnd, basis: newerRevenueInterims.length ? 'FY_PLUS_CURRENT_YTD_MINUS_PRIOR_YTD' : 'LATEST_FY' },
      annualSeries,
      concepts,
    },
    source: { id: 'sec_edgar', label: 'SEC EDGAR', official: true, asOf: new Date().toISOString(), contactConfigured: true },
    warnings,
    notes,
  };
}

export async function fetchSecFundamentals(symbol: string, contactEmail: string): Promise<JsonObject> {
  const normalized = symbol.trim().toUpperCase().replace('.', '-');
  if (!/^[A-Z][A-Z0-9-]{0,9}$/.test(normalized) || normalized.endsWith('-IS')) throw new Error('SEC temel analizi yalnızca ABD hisseleri için kullanılabilir.');
  const cacheKey = normalized;
  const cached = factsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return { ...cached.value, cached: true };
  const ticker = await fetchTicker(normalized, contactEmail);
  const cik = String(ticker.cik).padStart(10, '0');
  const payload = await secJson(`${SEC_FACTS_URL}${cik}.json`, contactEmail);
  const value = buildSecFundamentals(normalized, ticker, payload);
  factsCache.set(cacheKey, { expiresAt: Date.now() + 21_600_000, value });
  return { ...value, cached: false };
}

export function validSecContactEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim().toLowerCase());
}
