"use strict";

const STORAGE_KEY = "yatirim-defterim-v1";
const STORAGE_BACKUP_KEY = `${STORAGE_KEY}:backup`;
const STORAGE_RECOVERY_KEY = `${STORAGE_KEY}:recovery`;
const CLOUD_META_KEY = `${STORAGE_KEY}:cloud-sync`;
const OFFLINE_TRANSACTION_QUEUE_KEY = `${STORAGE_KEY}:offline-transactions`;
const UNDO_STORAGE_KEY = `${STORAGE_KEY}:undo`;
const SIDEBAR_COLLAPSED_KEY = `${STORAGE_KEY}:sidebar-collapsed`;
const AUTO_CALENDAR_CACHE_KEY = `${STORAGE_KEY}:automatic-calendar-v2`;
const STATE_SCHEMA_VERSION = 5;
const APP_VERSION = "14.16";
const DEFAULT_FX = 38.5;
const Core = globalThis.PortfolioCore;
if (!Core) throw new Error("Portföy hesap motoru yüklenemedi.");
const ExpenseCore = globalThis.ExpenseCore;
if (!ExpenseCore) throw new Error("Harcama takip motoru yüklenemedi.");
const OfflineQueue = globalThis.PortfolioOfflineQueue;
if (!OfflineQueue) throw new Error("Çevrimdışı işlem kuyruğu yüklenemedi.");
const transactionOutbox = OfflineQueue.createOutbox({
  storage: localStorage,
  key: OFFLINE_TRANSACTION_QUEUE_KEY
});
const startupWarnings = [];

const sampleState = {
  schemaVersion: STATE_SCHEMA_VERSION,
  settings: { baseCurrency: "TRY", fxUsdTry: DEFAULT_FX, refreshInterval: 30000, includeCash: false },
  isDemo: true,
  onboardingCompleted: true,
  prices: {
    "THYAO.IS": { price: 306.75, changePct: -0.72, currency: "TRY", updatedAt: null, delayed: true, source: "sample" },
    "ASTOR.IS": { price: 106.4, changePct: 2.18, currency: "TRY", updatedAt: null, delayed: true, source: "sample" },
    NVDA: { price: 175.38, changePct: 1.22, currency: "USD", updatedAt: null, delayed: true, source: "sample" },
    VOO: { price: 603.21, changePct: 0.38, currency: "USD", updatedAt: null, delayed: true, source: "sample" }
  },
  transactions: [
    { id: "t1", demo: true, type: "DEPOSIT", date: "2026-01-05", market: "NAKİT", currency: "TRY", symbol: "", name: "BIST hesabına para yatırma", quantity: 1, price: 130000, fee: 0 },
    { id: "t2", demo: true, type: "IPO_BUY", date: "2026-02-12", market: "BIST", currency: "TRY", symbol: "ASTOR.IS", name: "Örnek BIST halka arzı", quantity: 350, price: 72.5, fee: 0 },
    { id: "t3", demo: true, type: "BUY", date: "2026-03-04", market: "BIST", currency: "TRY", symbol: "THYAO.IS", name: "Türk Hava Yolları", quantity: 140, price: 288.4, fee: 9.9 },
    { id: "t4", demo: true, type: "DEPOSIT", date: "2026-03-20", market: "NAKİT", currency: "USD", symbol: "", name: "ABD hesabına para yatırma", quantity: 1, price: 1500, fee: 0 },
    { id: "t5", demo: true, type: "BUY", date: "2026-04-02", market: "ABD", currency: "USD", symbol: "NVDA", name: "NVIDIA", quantity: 4, price: 152.1, fee: 1 },
    { id: "t6", demo: true, type: "BUY", date: "2026-05-08", market: "ABD", currency: "USD", symbol: "VOO", name: "Vanguard S&P 500 ETF", quantity: 1.4, price: 572.3, fee: 0 }
  ],
  watchlist: [],
  expenses: [],
  calendarEvents: [],
  stockTheses: [],
  investmentBudget: { monthlyIncome: 0, expectedCardPayment: 0, fixedObligations: 0, cashBalance: 0, bufferMonths: 3, safetyMarginPct: 10, updatedAt: 0 },
  closedPositions: [],
  journal: [
    { id: "j1", demo: true, date: "2026-05-08", title: "Uzun vadeli birikim çerçevesi", body: "ABD tarafında düzenli alım yapacağım. Acil nakit ihtiyacı dışında tüm portföyü kapatmak yerine kısmi satış yapacağım." }
  ],
  history: [],
  dailySnapshots: []
};

function createEmptyState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    settings: { ...sampleState.settings },
    isDemo: false,
    onboardingCompleted: false,
    prices: {},
    transactions: [],
    watchlist: [],
    expenses: [],
    calendarEvents: [],
    stockTheses: [],
    investmentBudget: { monthlyIncome: 0, expectedCardPayment: 0, fixedObligations: 0, cashBalance: 0, bufferMonths: 3, safetyMarginPct: 10, updatedAt: 0 },
    closedPositions: [],
    journal: [],
    history: [],
    dailySnapshots: [],
    technicalAlerts: []
  };
}

let state = loadState();
let currentEditingTxId = null;
let currentEditingClosedId = null;
const expandedClosedPositionGroups = new Set();
let refreshTimer;
let toastTimer;
let pendingUndo = null;
let pendingCloudConflict = null;
let onboardingReady = false;
let deferredPwaPrompt = null;
let parsedImportData = [];
let editingThesisId = null;
const portfolioChartView = { range: "all", mode: "value", rendered: null, activeIndex: -1 };
const profitChartView = { mode: "totalPnl", rendered: null, activeIndex: -1 };
const expenseView = { month: "", filter: "all", importing: false };
const calendarView = { month: today().slice(0, 7), selectedDate: today(), autoFocusedKey: "" };
const automaticCalendarView = { events: [], loading: false, error: "", warnings: [], updatedAt: null, symbolKey: "", trackedSymbols: 0, coverage: null };
const performanceMarketHistory = {};
const performanceHistoryPeriods = {};
const performanceHistoryLoadedOn = {};
const performanceHistoryLoad = { key: "", loading: false, errors: [], completed: 0, total: 0 };
let currentPortfolioUser = null;
const technicalView = { symbol: null, period: "6mo", points: [], loading: false, error: "", indicators: { sma20: true, sma50: true, sma200: true, channel: true }, overlays: { stopBalanced: true, stopConservative: false, stopAggressive: false, res1: true, res2: false, sup1: true, sup2: false }, aiResult: null, aiLoading: false, aiError: "" };
const technicalHistoryCache = new Map();
const ETF_MARKET_ITEMS = Object.freeze([
  { symbol: "SPY", name: "S&P 500" },
  { symbol: "QQQ", name: "Nasdaq 100" },
  { symbol: "SMH", name: "Yarı İletken" }
]);
const etfMarketView = { loading: false, items: {}, errors: [], loadedAt: 0, requestId: 0 };
const TREND_CHECK_STRATEGIES = {
  short: { label: "Kısa vade", period: "6mo", lookback: 10, atrPeriod: 10, atrMultiplier: 2.2 },
  swing: { label: "Swing", period: "1y", lookback: 22, atrPeriod: 14, atrMultiplier: 3 },
  position: { label: "Pozisyon", period: "2y", lookback: 50, atrPeriod: 14, atrMultiplier: 3.5 }
};
const trendCheckView = { loading: false, error: "", report: null, requestId: 0 };
const stockDetailView = { symbol: null, history: [], fundamentals: null, loading: false, errors: [], requestId: 0, returnPage: "portfolio" };
const AI_KEY_STORAGE = "yatirim-defterim-ai-key";
const AI_SETTINGS_KEY = "yatirim-defterim-ai-settings";
let aiSecretStatus = { hasGeminiKey: false, loaded: false };
let aiModelsLoading = false;
let runtimeHealth = { server: "checking", serverVersion: null, cloud: false, storage: null, storageOk: null, checkedAt: null };
let marketHealth = { lastSuccessfulAt: null, cache: { status: "unknown", ageSeconds: 0 }, sources: {} };
const cloudSync = {
  available: false,
  enabled: false,
  applying: false,
  syncing: false,
  dirty: false,
  revision: 0,
  lastSyncedJson: "",
  pushTimer: null,
  pollTimer: null,
  phase: "checking",
  detail: "Bulut bağlantısı denetleniyor"
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const SERVICE_COPY = {
  price: "Fiyat servisine şu anda ulaşılamıyor.",
  sec: "Finansal veri servisine şu anda ulaşılamıyor.",
  gemini: "Yapay zekâ servisine şu anda ulaşılamıyor.",
  telegram: "Telegram bağlantısına şu anda ulaşılamıyor.",
  cloud: "Bulut eşitleme servisine şu anda ulaşılamıyor.",
  system: "Uygulama servisine şu anda ulaşılamıyor."
};

function serviceMessage(service, { hasCached = false } = {}) {
  const primary = SERVICE_COPY[service] || "İstenen servise şu anda ulaşılamıyor.";
  return `${primary}${hasCached ? " Son başarılı veri gösteriliyor." : ""} Yeniden deneyin veya bağlantı durumunu kontrol edin.`;
}

function serviceError(service, options = {}) {
  const error = new Error(serviceMessage(service, options));
  error.userFacing = true;
  error.service = service;
  return error;
}

function friendlyError(service, error, options = {}) {
  return error?.userFacing ? error.message : serviceMessage(service, options);
}

async function readJsonResponse(response, service, options = {}) {
  const contentType = String(response?.headers?.get?.("content-type") || "application/json").toLowerCase();
  if (!contentType.includes("json")) throw serviceError(service, options);
  try {
    return await response.json();
  } catch (_) {
    throw serviceError(service, options);
  }
}

function showServiceError(service, { hasCached = false, retry = null } = {}) {
  showToast(serviceMessage(service, { hasCached }), {
    undo: false,
    duration: 7000,
    actionLabel: retry ? "Yeniden dene" : "",
    action: retry
  });
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function migrateState(value) {
  const loaded = value && typeof value === "object" ? value : createEmptyState();
  loaded.schemaVersion = STATE_SCHEMA_VERSION;
  loaded.settings = { ...sampleState.settings, ...(loaded.settings || {}) };
  loaded.settings.baseCurrency = loaded.settings.baseCurrency === "USD" ? "USD" : "TRY";
  loaded.settings.fxUsdTry = Core.parseNumber(loaded.settings.fxUsdTry) > 0
    ? Core.parseNumber(loaded.settings.fxUsdTry)
    : DEFAULT_FX;
  loaded.settings.refreshInterval = [30000, 60000, 300000].includes(Number(loaded.settings.refreshInterval))
    ? Number(loaded.settings.refreshInterval)
    : 30000;
  // Nakit hareketleri dış akış hesabında korunur; portföy değeri yalnızca
  // yatırım pozisyonlarını temsil eder.
  loaded.settings.includeCash = false;
  loaded.settings.theme = loaded.settings.theme === "light" ? "light" : "dark";
  loaded.prices = loaded.prices && typeof loaded.prices === "object" ? loaded.prices : {};
  const watchlistSymbols = new Set();
  loaded.watchlist = (Array.isArray(loaded.watchlist) ? loaded.watchlist : [])
    .map((item, index) => {
      const raw = item && typeof item === "object" ? item : { symbol: item };
      const market = Core.normalizeMarket(raw.market, raw.symbol);
      const symbol = Core.normalizeSymbol(raw.symbol, market);
      return {
        id: String(raw.id || `watch_${index}_${symbol}`),
        symbol,
        market,
        name: String(raw.name || symbol).trim() || symbol,
        addedAt: Number(raw.addedAt) || Date.now()
      };
    })
    .filter(item => {
      if (!item.symbol || !Core.SYMBOL_PATTERN.test(item.symbol) || watchlistSymbols.has(item.symbol)) return false;
      watchlistSymbols.add(item.symbol);
      return true;
    });
  const quarantined = Array.isArray(loaded.quarantinedTransactions) ? loaded.quarantinedTransactions : [];
  loaded.transactions = (Array.isArray(loaded.transactions) ? loaded.transactions : [])
    .map((tx, index) => Core.normalizeTransaction(tx, index))
    .filter(tx => {
      if (Core.isValidDate(tx.date)) return true;
      quarantined.push({ ...tx, quarantineReason: "Geçersiz veya eksik işlem tarihi" });
      return false;
    });
  loaded.quarantinedTransactions = quarantined;
  if (quarantined.length) startupWarnings.push(`${quarantined.length} geçersiz tarihli işlem hesaplamadan ayrıldı; tam yedekte korunuyor.`);
  loaded.closedPositions = Array.isArray(loaded.closedPositions) ? loaded.closedPositions : [];
  loaded.journal = Array.isArray(loaded.journal) ? loaded.journal : [];
  loaded.history = Array.isArray(loaded.history) ? loaded.history : [];
  loaded.dailySnapshots = Array.isArray(loaded.dailySnapshots) ? loaded.dailySnapshots : [];
  loaded.technicalAlerts = Array.isArray(loaded.technicalAlerts) ? loaded.technicalAlerts : [];
  loaded.stockTheses = (Array.isArray(loaded.stockTheses) ? loaded.stockTheses : []).map((item, index) => ({
    id: String(item?.id || `thesis_${index}_${item?.symbol || "unknown"}`),
    symbol: String(item?.symbol || "").trim().toUpperCase().slice(0, 24),
    thesis: String(item?.thesis || "").trim().slice(0, 1200),
    catalysts: String(item?.catalysts || "").trim().slice(0, 800),
    invalidation: String(item?.invalidation || "").trim().slice(0, 800),
    reviewDate: Core.isValidDate(String(item?.reviewDate || "")) ? String(item.reviewDate) : "",
    status: ["pending", "stronger", "same", "broken"].includes(item?.status) ? item.status : "pending",
    reviewNote: String(item?.reviewNote || "").trim().slice(0, 800),
    reviews: (Array.isArray(item?.reviews) ? item.reviews : []).map(review => ({
      date: Core.isValidDate(String(review?.date || "")) ? String(review.date) : today(),
      status: ["stronger", "same", "broken"].includes(review?.status) ? review.status : "same",
      note: String(review?.note || "").trim().slice(0, 800)
    })).slice(-20),
    createdAt: Number(item?.createdAt) || Date.now(),
    updatedAt: Number(item?.updatedAt) || Date.now()
  })).filter(item => item.symbol && item.thesis);
  const rawBudget = loaded.investmentBudget && typeof loaded.investmentBudget === "object" ? loaded.investmentBudget : {};
  loaded.investmentBudget = {
    monthlyIncome: Math.max(0, Core.parseNumber(rawBudget.monthlyIncome)),
    expectedCardPayment: Math.max(0, Core.parseNumber(rawBudget.expectedCardPayment)),
    fixedObligations: Math.max(0, Core.parseNumber(rawBudget.fixedObligations)),
    cashBalance: Math.max(0, Core.parseNumber(rawBudget.cashBalance)),
    bufferMonths: Math.min(12, Math.max(1, Core.parseNumber(rawBudget.bufferMonths) || 3)),
    safetyMarginPct: Math.min(50, Math.max(0, Core.parseNumber(rawBudget.safetyMarginPct) || 10)),
    updatedAt: Number(rawBudget.updatedAt) || 0
  };
  loaded.calendarEvents = (Array.isArray(loaded.calendarEvents) ? loaded.calendarEvents : []).map((event, index) => ({
    id: String(event?.id || `calendar_${index}_${event?.date || "unknown"}`),
    date: Core.isValidDate(String(event?.date || "")) ? String(event.date) : "",
    title: String(event?.title || "Finansal olay").trim().slice(0, 120) || "Finansal olay",
    type: ["earnings", "dividend", "card", "portfolio", "other"].includes(event?.type) ? event.type : "other",
    symbol: String(event?.symbol || "").trim().toUpperCase().slice(0, 24),
    repeat: ["none", "monthly", "yearly"].includes(event?.repeat) ? event.repeat : "none",
    createdAt: Number(event?.createdAt) || Date.now()
  })).filter(event => event.date);
  loaded.expenses = (Array.isArray(loaded.expenses) ? loaded.expenses : []).map((expense, index) => {
    const date = ExpenseCore.normalizeDate(expense?.date);
    const amount = Number(expense?.amount);
    const description = ExpenseCore.cleanDescription(expense?.description || "Kart harcaması");
    return {
      id: String(expense?.id || `expense_${index}_${date || "unknown"}`),
      date,
      description: description || "Kart harcaması",
      amount: Number.isFinite(amount) ? amount : 0,
      currency: ["TRY", "USD", "EUR"].includes(expense?.currency) ? expense.currency : "TRY",
      category: ExpenseCore.cleanDescription(expense?.category) || ExpenseCore.categoryFor(description),
      family: expense?.family === true,
      source: expense?.source === "manual" ? "manual" : "statement",
      statementName: String(expense?.statementName || ""),
      importedAt: Number(expense?.importedAt) || Date.now(),
      fingerprint: String(expense?.fingerprint || ExpenseCore.fingerprint({ ...expense, date, description, amount }))
    };
  }).filter(expense => expense.date && Number.isFinite(expense.amount) && expense.amount !== 0);
  loaded.isDemo = loaded.isDemo === true;
  loaded.onboardingCompleted = loaded.onboardingCompleted === true
    || loaded.isDemo
    || loaded.transactions.length > 0
    || loaded.watchlist.length > 0
    || loaded.expenses.length > 0
    || loaded.calendarEvents.length > 0
    || loaded.stockTheses.length > 0
    || loaded.investmentBudget.monthlyIncome > 0
    || loaded.closedPositions.length > 0
    || loaded.journal.length > 0;
  return loaded;
}
function loadState() {
  let saved = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
    let loaded;
    try {
      loaded = saved ? JSON.parse(saved) : createEmptyState();
    } catch (primaryError) {
      const backup = localStorage.getItem(STORAGE_BACKUP_KEY);
      if (!backup) throw primaryError;
      loaded = JSON.parse(backup);
      try { localStorage.setItem(STORAGE_RECOVERY_KEY, saved); } catch (_) {}
      startupWarnings.push("Ana veri kaydı bozuk olduğu için son sağlam yedek açıldı.");
    }
    loaded = migrateState(loaded);
    document.documentElement?.setAttribute("data-theme", loaded.settings.theme);
    
    Object.values(loaded.prices).forEach(quote => { if (!quote.source) quote.source = "sample"; });

    // Eski örnek deneme verilerini kapanmış pozisyonlardan tamamen temizle
    loaded.closedPositions = loaded.closedPositions.filter(cp => !cp.demo && !["cp1","cp2","cp3"].includes(cp.id));

    // Kullanıcı kendi gerçek işlemlerini veya kapanmış pozisyonlarını girdiyse deneme verilerini de temizle
    const hasRealTx = loaded.transactions.some(tx => !tx.demo && !["t1","t2","t3","t4","t5","t6"].includes(tx.id)) ||
                      loaded.closedPositions.some(cp => !cp.demo && !["cp1","cp2","cp3"].includes(cp.id));
    if (hasRealTx) {
      if (loaded.transactions.some(tx => tx.demo)) {
        loaded.dailySnapshots = loaded.dailySnapshots.map(snapshot => ({ ...snapshot, isDemo: snapshot.isDemo ?? true }));
      }
      loaded.transactions = loaded.transactions.filter(tx => !tx.demo && !["t1","t2","t3","t4","t5","t6"].includes(tx.id));
      loaded.journal = loaded.journal.filter(j => !j.demo && j.id !== "j1");
      if (loaded.isDemo) {
        loaded.dailySnapshots = loaded.dailySnapshots.map(snapshot => ({ ...snapshot, isDemo: true }));
      }
      loaded.isDemo = false;
    }

    return loaded;
  } catch (error) {
    if (saved) {
      try { localStorage.setItem(STORAGE_RECOVERY_KEY, saved); } catch (_) {}
      startupWarnings.push("Yerel kayıt açılamadı; veri kurtarma kopyası korundu ve boş başlangıç verisi gösteriliyor.");
    }
    console.error("Yerel portföy verisi yüklenemedi:", error);
    return migrateState(createEmptyState());
  }
}
function isHostedCloudPage() {
  return location.protocol === "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
}

function queueOfflineTransactionChanges(previousSerialized) {
  if (cloudSync.applying || !isHostedCloudPage()) return 0;
  try {
    const previous = previousSerialized ? JSON.parse(previousSerialized) : null;
    const operations = OfflineQueue.diffTransactions(previous?.transactions, state.transactions);
    if (!operations.length) return 0;
    transactionOutbox.enqueueMany(operations);
    return operations.length;
  } catch (error) {
    console.error("Çevrimdışı işlem kuyruğu güncellenemedi:", error);
    return 0;
  }
}

function saveState({ recordUndo = true } = {}) {
  try {
    state.schemaVersion = STATE_SCHEMA_VERSION;
    const serialized = JSON.stringify(state);
    const previous = localStorage.getItem(STORAGE_KEY);
    if (previous && previous !== serialized) localStorage.setItem(STORAGE_BACKUP_KEY, previous);
    if (recordUndo && !cloudSync.applying && previous && previous !== serialized) {
      pendingUndo = { previous, after: serialized, createdAt: Date.now(), expiresAt: Date.now() + 12000 };
      try { sessionStorage.setItem(UNDO_STORAGE_KEY, JSON.stringify(pendingUndo)); } catch (_) {}
      const undoCandidate = pendingUndo;
      setTimeout(() => {
        if (pendingUndo === undoCandidate && !$("#toast")?.classList.contains("visible")) showToast("Değişiklik kaydedildi.");
      }, 0);
    }
    const queuedTransactions = previous !== serialized ? queueOfflineTransactionChanges(previous) : 0;
    localStorage.setItem(STORAGE_KEY, serialized);
    if (queuedTransactions > 0) {
      cloudSync.dirty = true;
      cloudSync.phase = navigator.onLine === false ? "error" : "syncing";
      cloudSync.detail = `${transactionOutbox.count()} işlem değişikliği gönderilmek üzere bu cihazda korunuyor`;
      persistCloudSyncMeta();
      updateCloudSyncUi();
    }
    if (!cloudSync.applying && cloudSync.enabled) {
      const cloudSerialized = JSON.stringify(cloudStatePayload());
      if (hasUnsyncedCloudChanges(cloudSerialized)) {
        cloudSync.dirty = true;
        cloudSync.phase = "syncing";
        cloudSync.detail = "Değişiklikler buluta kaydedilmeyi bekliyor";
        persistCloudSyncMeta();
        updateCloudSyncUi();
        scheduleCloudStatePush();
      } else if (cloudSync.dirty) {
        // Fiyatlar ve endeksler cihazda tutulur. Yalnızca bu geçici alanlar
        // değiştiyse bulut kaydını kirli bırakıp yeni sürümleri engelleme.
        cloudSync.dirty = false;
        persistCloudSyncMeta();
      }
    }
    return true;
  } catch (error) {
    console.error("Yerel portföy verisi kaydedilemedi:", error);
    if (typeof showToast === "function") showToast("Veri kaydedilemedi. Tarayıcı depolama alanını kontrol edin.");
    return false;
  }
}

function cloudStatePayload() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    settings: state.settings,
    isDemo: state.isDemo === true,
    onboardingCompleted: state.onboardingCompleted === true,
    transactions: state.transactions || [],
    watchlist: state.watchlist || [],
    expenses: state.expenses || [],
    calendarEvents: state.calendarEvents || [],
    stockTheses: state.stockTheses || [],
    investmentBudget: state.investmentBudget || {},
    closedPositions: state.closedPositions || [],
    journal: state.journal || [],
    dailySnapshots: state.dailySnapshots || [],
    history: state.history || [],
    technicalAlerts: state.technicalAlerts || []
  };
}

function comparableCloudStateJson(serialized) {
  const payload = typeof serialized === "string" ? JSON.parse(serialized) : serialized;
  const settings = { ...(payload?.settings || {}) };
  // Kur bilgisi fiyat yenilemesiyle cihaz bazında değişebilir. Portföy
  // kayıtlarında değişiklik olmadığı halde eşitlemeyi kirli saymamalı.
  delete settings.fxUsdTry;
  const dailySnapshots = (payload?.dailySnapshots || []).map(snapshot => {
    const { capturedAt: _capturedAt, ...stableSnapshot } = snapshot || {};
    return stableSnapshot;
  });
  const { history: _derivedHistory, ...stablePayload } = payload || {};
  return JSON.stringify({ ...stablePayload, settings, dailySnapshots });
}

function userManagedCloudStateJson(value) {
  const payload = typeof value === "string" ? JSON.parse(value) : (value || {});
  const settings = { ...(payload.settings || {}) };
  delete settings.fxUsdTry;
  return JSON.stringify({
    schemaVersion: payload.schemaVersion,
    settings,
    isDemo: payload.isDemo === true,
    onboardingCompleted: payload.onboardingCompleted === true,
    transactions: payload.transactions || [],
    watchlist: payload.watchlist || [],
    expenses: payload.expenses || [],
    calendarEvents: payload.calendarEvents || [],
    stockTheses: payload.stockTheses || [],
    investmentBudget: payload.investmentBudget || {},
    closedPositions: payload.closedPositions || [],
    journal: payload.journal || [],
    technicalAlerts: payload.technicalAlerts || []
  });
}

function hasUnsyncedCloudChanges(serialized = JSON.stringify(cloudStatePayload())) {
  if (!cloudSync.lastSyncedJson) return true;
  try {
    return comparableCloudStateJson(serialized) !== comparableCloudStateJson(cloudSync.lastSyncedJson);
  } catch (_) {
    return serialized !== cloudSync.lastSyncedJson;
  }
}

function hasMeaningfulCloudState(payload = cloudStatePayload()) {
  return (payload.transactions || []).some(tx => tx && tx.demo !== true)
    || (payload.watchlist || []).length > 0
    || (payload.expenses || []).length > 0
    || (payload.calendarEvents || []).length > 0
    || (payload.stockTheses || []).length > 0
    || Number(payload.investmentBudget?.monthlyIncome) > 0
    || (payload.closedPositions || []).some(position => position && position.demo !== true)
    || (payload.journal || []).some(entry => entry && entry.demo !== true)
    || (payload.technicalAlerts || []).length > 0;
}

function persistCloudSyncMeta() {
  try {
    localStorage.setItem(CLOUD_META_KEY, JSON.stringify({
      revision: cloudSync.revision,
      lastSyncedJson: cloudSync.lastSyncedJson,
      dirty: cloudSync.dirty === true
    }));
  } catch (_) { /* Yerel kurtarma meta verisi eşitlemeyi engellemez. */ }
}

function restoreCloudSyncMeta() {
  try {
    const saved = JSON.parse(localStorage.getItem(CLOUD_META_KEY) || "null");
    if (!saved || typeof saved !== "object") return;
    cloudSync.revision = Number.isInteger(Number(saved.revision)) ? Math.max(0, Number(saved.revision)) : 0;
    cloudSync.lastSyncedJson = typeof saved.lastSyncedJson === "string" ? saved.lastSyncedJson : "";
    cloudSync.dirty = saved.dirty === true;
  } catch (_) { /* Bozuk meta verisi güvenle yok sayılır. */ }
}

function updateCloudSyncUi() {
  const chip = $("#cloudSyncStatus");
  const caption = $("#storageScopeCaption");
  const historyButton = $("#cloudHistoryButton");
  const pendingCount = transactionOutbox.count();
  if (caption) caption.textContent = cloudSync.available ? "Kişisel · Cihazlarda eşitlenir" : "Kişisel · Bu bilgisayarda";
  if (historyButton) historyButton.hidden = !cloudSync.available;
  updateOfflineQueueUi();
  if (!chip) return;
  chip.hidden = !cloudSync.available && pendingCount === 0;
  chip.className = `status-chip ${cloudSync.phase === "synced" ? "live" : ["error", "conflict"].includes(cloudSync.phase) ? "warn" : "neutral"}`;
  chip.textContent = pendingCount > 0
    ? cloudSync.syncing
      ? `${pendingCount} gönderiliyor…`
      : `${pendingCount} bekliyor`
    : cloudSync.phase === "synced"
    ? "Eşitlendi"
    : cloudSync.phase === "syncing"
      ? "Eşitleniyor…"
      : cloudSync.phase === "conflict"
        ? "Çakışma"
      : cloudSync.phase === "error"
        ? "Çevrimdışı"
        : "Bulut hazırlanıyor";
  chip.title = cloudSync.detail;
}

function updateOfflineQueueUi() {
  const banner = $("#offlineQueueBanner");
  if (!banner) return;
  const count = transactionOutbox.count();
  banner.hidden = count === 0;
  if (!count) return;

  const offline = navigator.onLine === false || cloudSync.phase === "error";
  const title = $("#offlineQueueTitle");
  const detail = $("#offlineQueueDetail");
  const retry = $("#offlineQueueRetryButton");
  banner.classList.toggle("offline", offline);
  if (title) title.textContent = cloudSync.syncing
    ? `${count} işlem değişikliği gönderiliyor…`
    : `${count} işlem değişikliği gönderilecek`;
  if (detail) detail.textContent = offline
    ? "İşlemler bu cihazda kalıcı olarak saklandı; bağlantı gelince sırayla buluta gönderilecek."
    : "Bekleyen işlemler oluşturulma sırasıyla buluta aktarılıyor.";
  if (retry) retry.hidden = offline || cloudSync.syncing;
}

function cloudStateSummary(value = {}) {
  return {
    transactions: Array.isArray(value.transactions) ? value.transactions.length : 0,
    watchlist: Array.isArray(value.watchlist) ? value.watchlist.length : 0,
    expenses: Array.isArray(value.expenses) ? value.expenses.length : 0,
    calendarEvents: Array.isArray(value.calendarEvents) ? value.calendarEvents.length : 0,
    stockTheses: Array.isArray(value.stockTheses) ? value.stockTheses.length : 0,
    closedPositions: Array.isArray(value.closedPositions) ? value.closedPositions.length : 0,
    journal: Array.isArray(value.journal) ? value.journal.length : 0
  };
}

function summaryMarkup(value, label) {
  const summary = cloudStateSummary(value);
  return `<strong>${escapeHtml(label)}</strong><span>${summary.transactions} işlem · ${summary.expenses} harcama · ${summary.calendarEvents} takvim olayı · ${summary.stockTheses} tez · ${summary.watchlist} takip · ${summary.closedPositions} kapanmış · ${summary.journal} not</span>`;
}

function openCloudConflict(localState, cloudState, revision) {
  if (userManagedCloudStateJson(localState) === userManagedCloudStateJson(cloudState)) {
    cloudSync.dirty = false;
    applyCloudState(cloudState, revision);
    showToast("Cihazlardaki otomatik fiyat ve geçmiş farkları uzlaştırıldı.", { undo: false });
    return;
  }
  pendingCloudConflict = { localState: clone(localState), cloudState: clone(cloudState), revision: Number(revision) || 0 };
  cloudSync.phase = "conflict";
  cloudSync.detail = `Yerel değişikliklerle bulut sürümü ${pendingCloudConflict.revision} karşılaştırılmayı bekliyor`;
  updateCloudSyncUi();
  const localSummary = $("#localConflictSummary");
  const remoteSummary = $("#cloudConflictSummary");
  if (localSummary) localSummary.innerHTML = summaryMarkup(localState, "Bu cihazdaki değişiklik");
  if (remoteSummary) remoteSummary.innerHTML = summaryMarkup(cloudState, `Bulut sürümü ${pendingCloudConflict.revision}`);
  const differences = $("#cloudConflictDifferences");
  if (differences) {
    const local = cloudStateSummary(localState);
    const remote = cloudStateSummary(cloudState);
    differences.innerHTML = Object.keys(local).map(key => {
      const labels = { transactions: "İşlemler", expenses: "Harcamalar", calendarEvents: "Takvim olayları", stockTheses: "Hisse tezleri", watchlist: "Takip listesi", closedPositions: "Kapanmış pozisyonlar", journal: "Günlük notları" };
      return `<li><span>${labels[key]}</span><strong>${local[key]} yerel / ${remote[key]} bulut</strong></li>`;
    }).join("");
  }
  const dialog = $("#cloudConflictDialog");
  if (dialog && !dialog.open) dialog.showModal();
}

function mergeArrayById(remoteItems, localItems, fallbackPrefix) {
  const merged = new Map();
  [...(remoteItems || []), ...(localItems || [])].forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const key = String(item.id || item.date || item.symbol || `${fallbackPrefix}-${index}`);
    merged.set(key, item);
  });
  return [...merged.values()];
}

function mergeConflictStates(remoteState, localState) {
  return migrateState({
    ...remoteState,
    settings: { ...(remoteState.settings || {}), ...(localState.settings || {}) },
    onboardingCompleted: true,
    isDemo: false,
    transactions: mergeArrayById(remoteState.transactions, localState.transactions, "tx"),
    watchlist: mergeArrayById(remoteState.watchlist, localState.watchlist, "watch"),
    expenses: mergeArrayById(remoteState.expenses, localState.expenses, "expense"),
    calendarEvents: mergeArrayById(remoteState.calendarEvents, localState.calendarEvents, "calendar"),
    stockTheses: mergeArrayById(remoteState.stockTheses, localState.stockTheses, "thesis"),
    investmentBudget: { ...(remoteState.investmentBudget || {}), ...(localState.investmentBudget || {}) },
    closedPositions: mergeArrayById(remoteState.closedPositions, localState.closedPositions, "closed"),
    journal: mergeArrayById(remoteState.journal, localState.journal, "journal"),
    dailySnapshots: mergeArrayById(remoteState.dailySnapshots, localState.dailySnapshots, "snapshot"),
    technicalAlerts: mergeArrayById(remoteState.technicalAlerts, localState.technicalAlerts, "alert"),
    prices: { ...(state.prices || {}) }
  });
}

async function resolveCloudConflict(choice) {
  if (!pendingCloudConflict) return;
  const conflict = pendingCloudConflict;
  pendingCloudConflict = null;
  $("#cloudConflictDialog")?.close();
  if (choice === "cloud") {
    try { localStorage.setItem(STORAGE_RECOVERY_KEY, JSON.stringify(conflict.localState)); } catch (_) {}
    applyCloudState(conflict.cloudState, conflict.revision);
    showToast("Bulut sürümü kullanıldı; önceki yerel durum kurtarma kopyasında saklandı.", { undo: false });
    return;
  }

  state = choice === "merge"
    ? mergeConflictStates(conflict.cloudState, conflict.localState)
    : migrateState({ ...state, ...conflict.localState, prices: state.prices || {} });
  cloudSync.revision = conflict.revision;
  cloudSync.lastSyncedJson = JSON.stringify(conflict.cloudState);
  cloudSync.dirty = true;
  saveState({ recordUndo: true });
  persistCloudSyncMeta();
  render();
  showToast(choice === "merge" ? "Kayıtlar birleştirildi ve yeni bulut sürümü hazırlanıyor." : "Bu cihazdaki değişiklik korunuyor ve buluta kaydediliyor.");
  await pushCloudState(JSON.stringify(cloudStatePayload()));
}

function setCloudImportGuideVisible(visible) {
  const guide = $("#cloudImportGuide");
  if (guide) guide.hidden = !visible;
}

function applyCloudState(remoteState, revision) {
  if (!remoteState || typeof remoteState !== "object") return;
  cloudSync.applying = true;
  try {
    const transient = { prices: state.prices || {}, benchmarks: state.benchmarks || {} };
    state = migrateState({ ...state, ...remoteState, ...transient });
    state.schemaVersion = STATE_SCHEMA_VERSION;
    const serializedLocal = JSON.stringify(state);
    const previous = localStorage.getItem(STORAGE_KEY);
    if (previous && previous !== serializedLocal) localStorage.setItem(STORAGE_BACKUP_KEY, previous);
    localStorage.setItem(STORAGE_KEY, serializedLocal);
    cloudSync.revision = Number(revision) || 0;
    cloudSync.lastSyncedJson = JSON.stringify(cloudStatePayload());
    cloudSync.dirty = false;
    persistCloudSyncMeta();
    render();
    renderClosedPositions();
    scheduleRefresh();
  } finally {
    cloudSync.applying = false;
  }
}

async function fetchCloudState({ notify = false } = {}) {
  const response = await fetch("/api/sync-state", { cache: "no-store" });
  if (response.status === 404) return null;
  const payload = await readJsonResponse(response, "cloud");
    if (!response.ok) throw serviceError("cloud");
  cloudSync.available = true;
  cloudSync.enabled = true;
  if (payload.exists && Number(payload.revision) > cloudSync.revision && !cloudSync.syncing && !cloudSync.dirty && transactionOutbox.count() === 0) {
    applyCloudState(payload.state, payload.revision);
    if (notify) showToast("Diğer cihazdaki değişiklikler alındı.");
    void refreshQuotes({ quiet: true });
  }
  if (cloudSync.dirty || transactionOutbox.count() > 0) {
    cloudSync.phase = "syncing";
    cloudSync.detail = "Yerel değişiklikler bulutla karşılaştırılıyor";
  } else if (!cloudSync.syncing) {
    cloudSync.phase = "synced";
    cloudSync.detail = payload.exists
      ? `Bulut kaydı güncel · sürüm ${payload.revision}`
      : "Bulut hesabı hazır · masaüstü yedeğini bir kez içe aktarın";
  }
  updateCloudSyncUi();
  if (payload.exists) setCloudImportGuideVisible(false);
  return payload;
}

function sectionJson(payload, key) {
  const value = payload?.[key];
  if (key === "settings") {
    const settings = { ...(value || {}) };
    delete settings.fxUsdTry;
    return JSON.stringify(settings);
  }
  return JSON.stringify(value);
}

function reconcileStateAfterOfflineFlush(remoteState, baselineSerialized) {
  if (!remoteState || typeof remoteState !== "object") return;
  const localState = cloudStatePayload();
  let baselineState = null;
  try { baselineState = baselineSerialized ? JSON.parse(baselineSerialized) : null; } catch (_) {}
  const merged = { ...remoteState };
  if (baselineState) {
    ["settings", "isDemo", "onboardingCompleted", "watchlist", "closedPositions", "journal", "dailySnapshots", "history", "technicalAlerts"].forEach(key => {
      if (sectionJson(localState, key) !== sectionJson(baselineState, key)) merged[key] = localState[key];
    });
  }

  cloudSync.applying = true;
  try {
    const transient = { prices: state.prices || {}, benchmarks: state.benchmarks || {} };
    state = migrateState({ ...state, ...merged, ...transient });
    const serializedLocal = JSON.stringify(state);
    const previous = localStorage.getItem(STORAGE_KEY);
    if (previous && previous !== serializedLocal) localStorage.setItem(STORAGE_BACKUP_KEY, previous);
    localStorage.setItem(STORAGE_KEY, serializedLocal);
    render();
    renderClosedPositions();
    scheduleRefresh();
  } finally {
    cloudSync.applying = false;
  }
}

async function flushOfflineTransactionOutbox() {
  let processed = 0;
  let remoteState = null;
  while (transactionOutbox.count() > 0) {
    const entry = transactionOutbox.peek();
    if (!entry) break;
    cloudSync.detail = `${transactionOutbox.count()} bekleyen işlem değişikliği sırayla gönderiliyor`;
    updateCloudSyncUi();
    const requestPayload = { operationId: entry.id, operation: entry.operation };
    if (cloudSync.revision === 0) requestPayload.fallbackState = cloudStatePayload();
    const response = await fetch("/api/offline-transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": entry.id },
      body: JSON.stringify(requestPayload)
    });
    const payload = await readJsonResponse(response, "cloud");
    if (!response.ok || !payload.state) throw serviceError("cloud", { hasCached: true });
    if (!transactionOutbox.acknowledge(entry.id)) throw new Error("İşlem kuyruğunun sırası değişti.");
    cloudSync.revision = Number(payload.revision) || cloudSync.revision;
    remoteState = payload.state;
    processed += 1;
    persistCloudSyncMeta();
    updateCloudSyncUi();
  }
  return { processed, remoteState };
}

async function pushCloudState(_serialized = JSON.stringify(cloudStatePayload())) {
  if (!cloudSync.enabled || cloudSync.applying || cloudSync.syncing) return;
  let serialized = JSON.stringify(cloudStatePayload());
  if (transactionOutbox.count() === 0 && (!hasUnsyncedCloudChanges(serialized)
    || (cloudSync.revision === 0 && !hasMeaningfulCloudState(JSON.parse(serialized))))) {
    cloudSync.dirty = false;
    cloudSync.phase = "synced";
    cloudSync.detail = cloudSync.revision > 0
      ? `Bulut kaydı güncel · sürüm ${cloudSync.revision}`
      : "Bulut hesabı hazır";
    persistCloudSyncMeta();
    updateCloudSyncUi();
    return;
  }
  cloudSync.syncing = true;
  cloudSync.phase = "syncing";
  cloudSync.detail = "Değişiklikler buluta kaydediliyor";
  updateCloudSyncUi();
  let failed = false;
  let conflicted = false;
  try {
    const baselineBeforeOutbox = cloudSync.lastSyncedJson;
    const flushed = await flushOfflineTransactionOutbox();
    if (flushed.remoteState) {
      reconcileStateAfterOfflineFlush(flushed.remoteState, baselineBeforeOutbox);
      cloudSync.lastSyncedJson = JSON.stringify(flushed.remoteState);
      persistCloudSyncMeta();
      serialized = JSON.stringify(cloudStatePayload());
    }

    if (!hasUnsyncedCloudChanges(serialized)
      || (cloudSync.revision === 0 && !hasMeaningfulCloudState(JSON.parse(serialized)))) {
      cloudSync.dirty = false;
      persistCloudSyncMeta();
      cloudSync.phase = "synced";
      cloudSync.detail = flushed.processed > 0
        ? `${flushed.processed} bekleyen değişiklik gönderildi · sürüm ${cloudSync.revision}`
        : cloudSync.revision > 0 ? `Bulut kaydı güncel · sürüm ${cloudSync.revision}` : "Bulut hesabı hazır";
      if (flushed.processed > 0) showToast(`${flushed.processed} bekleyen işlem değişikliği buluta gönderildi.`, { undo: false });
      return;
    }

    const response = await fetch("/api/sync-state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseRevision: cloudSync.revision, state: JSON.parse(serialized) })
    });
    const payload = await readJsonResponse(response, "cloud");
    if (response.status === 409 && payload.state) {
      openCloudConflict(JSON.parse(serialized), payload.state, payload.revision);
      conflicted = true;
      return;
    }
    if (!response.ok) throw serviceError("cloud");
    cloudSync.revision = Number(payload.revision) || cloudSync.revision;
    cloudSync.lastSyncedJson = serialized;
    cloudSync.dirty = hasUnsyncedCloudChanges(JSON.stringify(cloudStatePayload())) || transactionOutbox.count() > 0;
    persistCloudSyncMeta();
    cloudSync.phase = cloudSync.dirty ? "syncing" : "synced";
    cloudSync.detail = cloudSync.dirty
      ? "Yeni değişiklikler gönderilmeyi bekliyor"
      : `Tüm cihazlar güncel · sürüm ${cloudSync.revision}`;
    setCloudImportGuideVisible(false);
  } catch (error) {
    failed = true;
    cloudSync.dirty = true;
    cloudSync.phase = "error";
    cloudSync.detail = friendlyError("cloud", error, { hasCached: true });
    clearTimeout(cloudSync.pushTimer);
    cloudSync.pushTimer = setTimeout(() => void pushCloudState(), 10000);
  } finally {
    cloudSync.syncing = false;
    updateCloudSyncUi();
    if (!failed && !conflicted && (cloudSync.dirty || transactionOutbox.count() > 0)) scheduleCloudStatePush();
  }
}

async function openCloudHistory() {
  const dialog = $("#cloudHistoryDialog");
  const list = $("#cloudHistoryList");
  if (!dialog || !list) return;
  list.innerHTML = `<p class="empty-state">Sürüm geçmişi yükleniyor…</p>`;
  dialog.showModal();
  try {
    const response = await fetch("/api/sync-history", { cache: "no-store" });
    const payload = await readJsonResponse(response, "cloud");
    if (!response.ok) throw serviceError("cloud");
    list.innerHTML = payload.versions?.length ? payload.versions.map(version => `
      <article class="history-version-card">
        <div><strong>Sürüm ${version.revision}</strong><span>${new Date(version.updatedAt).toLocaleString("tr-TR")} · ${version.transactions} işlem · ${version.watchlist} takip</span></div>
        <button class="button secondary small" type="button" data-restore-cloud-revision="${version.revision}">Bu sürüme dön</button>
      </article>`).join("") : `<p class="empty-state">Henüz geri dönülebilecek bir bulut sürümü yok.</p>`;
  } catch (error) {
    list.innerHTML = `<div class="service-error-state"><strong>Bulut geçmişi alınamadı</strong><p>${escapeHtml(friendlyError("cloud", error))}</p><button class="button secondary small" type="button" data-retry-service="cloud-history">Yeniden dene</button></div>`;
  }
}

async function restoreCloudHistoryVersion(revision) {
  if (!confirm(`Bulut sürümü ${revision} yeni bir sürüm olarak geri yüklensin mi? Mevcut durum geçmişte kalmaya devam eder.`)) return;
  try {
    const response = await fetch(`/api/sync-history?revision=${encodeURIComponent(revision)}`, { cache: "no-store" });
    const payload = await readJsonResponse(response, "cloud");
    if (!response.ok) throw serviceError("cloud");
    const previous = JSON.stringify(state);
    state = migrateState({ ...state, ...payload.state, prices: state.prices || {} });
    pendingUndo = { previous, after: JSON.stringify(state), createdAt: Date.now(), expiresAt: Date.now() + 12000 };
    saveState({ recordUndo: false });
    $("#cloudHistoryDialog")?.close();
    render();
    showToast(`Sürüm ${revision} geri yüklendi; yeni bulut sürümü kaydediliyor.`);
  } catch (error) {
    showServiceError("cloud", { retry: () => void restoreCloudHistoryVersion(revision) });
  }
}

function scheduleCloudStatePush() {
  if (!cloudSync.enabled || cloudSync.applying) return;
  clearTimeout(cloudSync.pushTimer);
  cloudSync.pushTimer = setTimeout(() => void pushCloudState(), 700);
}

async function initializeCloudSync() {
  restoreCloudSyncMeta();
  if (cloudSync.dirty && transactionOutbox.count() === 0 && !hasUnsyncedCloudChanges()) {
    // v13.3 ve öncesinde fiyat yenilemeleri bu bayrağı yanlışlıkla açık
    // bırakabiliyordu. Eski cihazları otomatik olarak kilitten çıkar.
    cloudSync.dirty = false;
    persistCloudSyncMeta();
  }
  updateCloudSyncUi();
  try {
    const payload = await fetchCloudState();
    if (!payload) return;
    if (payload.exists && (cloudSync.dirty || transactionOutbox.count() > 0)) {
      void pushCloudState();
    } else if (payload.exists && Number(payload.revision) > cloudSync.revision) {
      applyCloudState(payload.state, payload.revision);
    } else {
      cloudSync.revision = 0;
      cloudSync.lastSyncedJson = "";
      if (hasMeaningfulCloudState()) {
        cloudSync.dirty = true;
        cloudSync.detail = "Bulut boş · bu cihazdaki portföy güvenle aktarılıyor";
        persistCloudSyncMeta();
        setCloudImportGuideVisible(false);
        updateCloudSyncUi();
        await pushCloudState();
      } else {
        cloudSync.detail = "Bulut hesabı hazır · ilk işlemini ekleyebilir veya JSON yedeğini içe aktarabilirsin";
        updateCloudSyncUi();
        setCloudImportGuideVisible(true);
      }
    }
    clearInterval(cloudSync.pollTimer);
    cloudSync.pollTimer = setInterval(() => void fetchCloudState({ notify: true }).catch(error => {
      cloudSync.phase = "error";
      cloudSync.detail = friendlyError("cloud", error, { hasCached: true });
      updateCloudSyncUi();
    }), 12000);
  } catch (_) {
    const hostedCloudPage = isHostedCloudPage();
    cloudSync.available = hostedCloudPage;
    cloudSync.enabled = hostedCloudPage;
    cloudSync.phase = hostedCloudPage ? "error" : cloudSync.phase;
    cloudSync.detail = hostedCloudPage ? serviceMessage("cloud", { hasCached: true }) : cloudSync.detail;
    if (hostedCloudPage) {
      clearInterval(cloudSync.pollTimer);
      cloudSync.pollTimer = setInterval(() => void initializeCloudSync(), 12000);
    }
    updateCloudSyncUi();
  }
}
function number(value) { return Core.parseNumber(value); }
function today() { return Core.localDateISO(); }
function uid(prefix) { return Core.createId(prefix); }
function calendarMonthsAgo(count, reference = new Date()) {
  const result = new Date(reference);
  const originalDay = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() - count);
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(originalDay, lastDay));
  return result;
}
function calendarYearsAgo(count, reference = new Date()) {
  const result = new Date(reference);
  const originalMonth = result.getMonth();
  result.setFullYear(result.getFullYear() - count, originalMonth, 1);
  const lastDay = new Date(result.getFullYear(), originalMonth + 1, 0).getDate();
  result.setDate(Math.min(reference.getDate(), lastDay));
  return result;
}
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;" }[c])); }

// TradingView supplies logo IDs with live quotes. These cover the sample data
// before the first price refresh completes.
const sampleLogoIds = {
  "THYAO.IS": "turkish-airlines",
  "ASTOR.IS": "astor-enerji",
  "NVDA": "nvidia",
  "VOO": "vanguard",
  "GARAN.IS": "garanti-bankasi",
  "AKBNK.IS": "akbank",
  "ISCTR.IS": "isbankasi",
  "YKBNK.IS": "yapi-kredi-bankasi",
  "EREGL.IS": "eregli-demir-celik",
  "KCHOL.IS": "koc-holding",
  "SAHOL.IS": "sabanci-holding",
  "BIMAS.IS": "bim",
  "ASELS.IS": "aselsan",
  "TUPRS.IS": "tupras",
  "SISE.IS": "sise-cam",
  "TCELL.IS": "turkcell",
  "TTKOM.IS": "turk-telekom",
  "SASA.IS": "sasa-polyester",
  "HEKTS.IS": "hektas",
  "PETKM.IS": "petkim",
  "PGSUS.IS": "pegasus",
  "FROTO.IS": "ford-otosan",
  "TOASO.IS": "tofas",
  "ENKAI.IS": "enka-inSaat",
  "GUBRF.IS": "gubre-fabrikalari",
  "VESTL.IS": "vestel",
  "ALARK.IS": "alarko-holding",
  "KOZAL.IS": "koza-altin",
  "KOZAA.IS": "koza-anadolu",
  "IPEKE.IS": "ipek-dogal-enerji",
  "SOKM.IS": "sok-marketler",
  "MGROS.IS": "migros",
  "ULKER.IS": "ulker-biskuvi",
  "DOAS.IS": "dogus-otomotiv",
  "EKGYO.IS": "emlak-konut",
  "ODAS.IS": "odas-elektrik",
  "GESAN.IS": "girisim-elektrik",
  "KONTR.IS": "kontrolmatik",
  "SMRTG.IS": "smart-gunes-enerjisi",
  "EUPWR.IS": "europower-enerji",
  "MIATK.IS": "mia-teknoloji",
  "REEDR.IS": "reeder-teknoloji",
  "ALFAS.IS": "alfa-solar",
  "TABGD.IS": "tab-gida",
  "CWENE.IS": "cw-enerji",
  "KLSER.IS": "kaleseramik",
  "AAPL": "apple",
  "MSFT": "microsoft",
  "AMZN": "amazon",
  "GOOGL": "google",
  "META": "meta",
  "TSLA": "tesla",
  "AMD": "advanced-micro-devices",
  "NFLX": "netflix",
  "COIN": "coinbase",
  "DIS": "disney",
  "INTC": "intel"
};

const customDomains = {
  "QUICK": "quicksigorta.com",
  "SSAAT": "saatvesaat.com.tr",
  "MASFN": "masfen.com.tr",
  "SARAE": "sara-enerji.com",
  "GOLDA": "golda.com.tr",
  "ISVEA": "isvea.com.tr",
  "ORZAX": "orzax.com.tr",
  "BETAE": "betaenerji.com.tr",
  "SOHOE": "sohocompany.com.tr",
  "EKDMR": "ekinciler.com"
};

function companyLogo(symbol, quote, name = "") {
  const cleanSym = (symbol || "").trim().toUpperCase();
  const baseSym = cleanSym.replace(".IS", "");

  const logoId = quote?.logoid || 
                 sampleLogoIds[cleanSym] || 
                 sampleLogoIds[`${cleanSym}.IS`] || 
                 sampleLogoIds[baseSym];
  
  const initial = escapeHtml((cleanSym || name || "?").charAt(0));
  const fallbackSpan = `<span class="symbol-logo-fallback" hidden aria-hidden="true">${initial}</span>`;

  let primarySrc = "";
  if (logoId) {
    primarySrc = (logoId.startsWith("http://") || logoId.startsWith("https://"))
      ? logoId
      : `https://s3-symbol-logo.tradingview.com/${encodeURIComponent(logoId)}--big.svg`;
  } else {
    primarySrc = `https://s3-symbol-logo.tradingview.com/${baseSym.toLowerCase()}--big.svg`;
  }

  const customDomain = customDomains[baseSym] || `${baseSym.toLowerCase()}.com.tr`;
  const secondarySrc = `https://icon.horse/icon/${customDomain}`;
  const tertiarySrc = `https://www.google.com/s2/favicons?domain=${customDomain}&sz=128`;

  return `<span class="symbol-logo" role="img" aria-label="${escapeHtml(name || symbol)}">
    <img src="${primarySrc}" alt="" data-step="1" onerror="
      if (this.dataset.step === '1') {
        this.dataset.step = '2';
        this.src = '${secondarySrc}';
      } else if (this.dataset.step === '2') {
        this.dataset.step = '3';
        this.src = '${tertiarySrc}';
      } else {
        this.hidden = true;
        if (this.nextElementSibling) this.nextElementSibling.hidden = false;
      }
    ">
    ${fallbackSpan}
  </span>`;
}

function getSymbolCurrency(symbol) {
  if (!symbol) return "USD";
  const upper = String(symbol).trim().toUpperCase();
  // BIST hisseleri (.IS uzantılı) istisnasız TRY
  if (upper.endsWith(".IS")) return "TRY";
  // ABD ve tüm yabancı hisseler (MU, NVDA, AAPL, VOO, MSFT vb.) istisnasız USD
  return "USD";
}

function formatMoney(value, currency = state.settings.baseCurrency, options = {}) {
  const safe = Number.isFinite(value) ? value : 0;
  return new Intl.NumberFormat("tr-TR", { style: "currency", currency, maximumFractionDigits: options.maximumFractionDigits ?? (Math.abs(safe) < 100 ? 2 : 0), minimumFractionDigits: options.minimumFractionDigits ?? 0 }).format(safe);
}
function formatNumber(value, digits = 2) { return new Intl.NumberFormat("tr-TR", { maximumFractionDigits: digits }).format(value); }
function signedMoney(value) { return `${value >= 0 ? "+" : "−"}${formatMoney(Math.abs(value))}`; }
function signedPercent(value) { return `${value >= 0 ? "+" : "−"}${formatNumber(Math.abs(value), 2)}%`; }
function baseValue(value, currency) {
  const fx = number(state.settings.fxUsdTry) || DEFAULT_FX;
  if (currency === state.settings.baseCurrency) return value;
  return state.settings.baseCurrency === "TRY" ? value * fx : value / fx;
}
function transactionLabel(type) { return ({ BUY: "Alış", SELL: "Satış", IPO_BUY: "Halka arz alımı", DEPOSIT: "Para yatırma", WITHDRAWAL: "Para çekme", DIVIDEND: "Temettü" })[type] || type; }
function typeClass(value) { return value >= 0 ? "positive" : "negative"; }

function calculatePortfolio() {
  return Core.calculatePortfolio(state);
}

function render() {
  const data = calculatePortfolio();
  recordDailySnapshot(data);
  renderHeader();
  renderSystemHealth(data);
  renderDashboard(data);
  renderPortfolio(data);
  renderDecisionCenter(data);
  renderTrendCheck(data);
  renderWatchlist(data);
  renderTransactions();
  renderExpenses();
  renderFinancialCalendar();
  renderSettings();
  renderClosedPositions();
  updateExperiencePrompts();
  if (stockDetailView.symbol) renderStockDetail();
  if (stockDetailView.symbol && $("#fundamentalAnalysisPage")?.classList.contains("active")) renderFundamentalAnalysis();
}

function renderHeader() {
  updateDashboardGreeting();
  const now = new Intl.DateTimeFormat("tr-TR", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(new Date());
  $("#marketTime").textContent = now;
  const hasQuotes = Object.keys(state.prices).length > 0;
  const liveQuote = Object.values(state.prices).find(quote => quote.source && quote.source !== "sample");
  const status = $("#quoteStatus");
  const fxDisplay = $("#fxRateDisplay");
  const marketSuccessTime = marketHealth.lastSuccessfulAt ? Date.parse(marketHealth.lastSuccessfulAt) : NaN;
  const lastUpdatedAt = Number.isFinite(marketSuccessTime) ? marketSuccessTime : liveQuote?.updatedAt;
  const lastUpdated = lastUpdatedAt ? new Date(lastUpdatedAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }) : "";
  const cacheStatus = marketHealth.cache?.status || "unknown";
  const stale = cacheStatus === "stale" || cacheStatus === "partial-stale";
  const degraded = Object.values(marketHealth.sources || {}).some(source => source?.status && source.status !== "healthy");
  status.textContent = state.isDemo
    ? "Örnek fiyatlar · canlı değil"
    : liveQuote
      ? `${stale ? "Son başarılı fiyat" : "Son fiyat"} · ${lastUpdated}${stale ? " · önbellek" : degraded ? " · yedek kaynak aktif" : ""}`
      : hasQuotes ? "Kayıtlı fiyatlar gösteriliyor" : "Fiyat verisi bekleniyor";
  status.className = "status-chip warn";
  if (liveQuote && !state.isDemo && !stale) status.className = "status-chip live";
  if (fxDisplay && state.settings.fxUsdTry) fxDisplay.textContent = `USD/TRY: ${formatNumber(state.settings.fxUsdTry, 4)}`;
}

function renderMarketHealth() {
  const rows = [
    ["tradingview", "#marketTradingViewRow", "#marketTradingViewStatus", "#marketTradingViewDetail"],
    ["yahoo_finance", "#marketYahooRow", "#marketYahooStatus", "#marketYahooDetail"],
  ];
  const statusLabels = { healthy: "Sağlıklı", degraded: "Kısmi", unavailable: "Ulaşılamıyor" };
  rows.forEach(([key, rowSelector, statusSelector, detailSelector]) => {
    const health = marketHealth.sources?.[key];
    const row = $(rowSelector);
    if (row) row.className = `market-provider-row${health?.status ? ` ${health.status}` : ""}`;
    const statusElement = $(statusSelector);
    if (statusElement) statusElement.textContent = health ? (statusLabels[health.status] || "Bekleniyor") : "Bekleniyor";
    const detailElement = $(detailSelector);
    if (detailElement) {
      if (!health) detailElement.textContent = "İlk fiyat yenilemesi bekleniyor";
      else {
        const successTime = health.lastSuccessAt && Number.isFinite(Date.parse(health.lastSuccessAt))
          ? new Date(health.lastSuccessAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })
          : "henüz yok";
        detailElement.textContent = `${health.successfulSymbols}/${health.requestedSymbols} sembol · son başarı ${successTime} · ${health.latencyMs} ms`;
      }
    }
  });
  const badge = $("#marketHealthBadge");
  const sourceValues = Object.values(marketHealth.sources || {});
  const unavailable = sourceValues.length > 0 && sourceValues.every(source => source.status === "unavailable");
  const degraded = sourceValues.some(source => source.status !== "healthy");
  const stale = ["stale", "partial-stale"].includes(marketHealth.cache?.status);
  if (badge) {
    badge.className = `status-badge ${unavailable ? "inactive" : stale || degraded ? "warning" : "active"}`;
    badge.textContent = unavailable ? "Önbellek" : stale || degraded ? "Yedekli" : sourceValues.length ? "Sağlıklı" : "Bekleniyor";
  }
  const lastSuccess = $("#marketLastSuccessfulAt");
  if (lastSuccess) {
    const timestamp = marketHealth.lastSuccessfulAt && Number.isFinite(Date.parse(marketHealth.lastSuccessfulAt))
      ? new Date(marketHealth.lastSuccessfulAt).toLocaleString("tr-TR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      : "";
    const cacheLabels = { live: "canlı yanıt", fresh: "taze önbellek", "partial-stale": "kısmi son başarılı kayıt", stale: "son başarılı kayıt" };
    lastSuccess.textContent = timestamp
      ? `Son başarılı fiyat alımı: ${timestamp} · ${cacheLabels[marketHealth.cache?.status] || "durum bilinmiyor"}`
      : "Henüz başarılı fiyat alımı yok";
  }
}

function setHealthItem(itemSelector, titleSelector, detailSelector, level, title, detail) {
  const item = $(itemSelector);
  if (item) item.className = `foundation-item ${level}`;
  const titleElement = $(titleSelector);
  const detailElement = $(detailSelector);
  if (titleElement) titleElement.textContent = title;
  if (detailElement) detailElement.textContent = detail;
}

function setDiagnosticCard(valueSelector, detailSelector, level, value, detail) {
  const valueElement = $(valueSelector);
  const detailElement = $(detailSelector);
  if (valueElement) {
    valueElement.textContent = value;
    valueElement.closest("article")?.classList.remove("ok", "warn", "error");
    if (level) valueElement.closest("article")?.classList.add(level);
  }
  if (detailElement) detailElement.textContent = detail;
}

function formatStorageSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024 * 1024) return `${formatNumber(bytes / 1024, 1)} KB`;
  return `${formatNumber(bytes / (1024 * 1024), 1)} MB`;
}

function renderSystemHealth(data = calculatePortfolio()) {
  const holdings = Array.isArray(data.holdings) ? data.holdings : [];
  const integrityErrors = Array.isArray(data.integrityErrors) ? data.integrityErrors : [];
  const quarantinedCount = Array.isArray(state.quarantinedTransactions) ? state.quarantinedTransactions.length : 0;
  const coveredHoldings = holdings.filter(holding => Number(state.prices?.[holding.symbol]?.price) > 0);
  const quoteTimes = coveredHoldings
    .map(holding => Number(state.prices?.[holding.symbol]?.updatedAt))
    .filter(Number.isFinite);
  const latestQuoteAt = quoteTimes.length ? Math.max(...quoteTimes) : null;
  const latestQuoteText = latestQuoteAt
    ? new Date(latestQuoteAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })
    : "zaman bilgisi yok";
  let backupReady = false;
  try { backupReady = Boolean(localStorage.getItem(STORAGE_BACKUP_KEY)); } catch (_) { backupReady = false; }
  const snapshotCount = Core.selectPerformanceSnapshots(state).snapshots.length;
  const monthlyDaysRemaining = Math.max(0, 30 - snapshotCount);
  const ledgerLevel = integrityErrors.length || quarantinedCount ? "error" : "ok";
  const quoteLevel = state.isDemo ? "warn" : (!holdings.length || coveredHoldings.length === holdings.length ? "ok" : "warn");
  const backupLevel = backupReady ? "ok" : "warn";
  const historyLevel = snapshotCount >= 30 ? "ok" : "warn";

  setHealthItem(
    "#ledgerHealthItem", "#ledgerHealthTitle", "#ledgerHealthDetail", ledgerLevel,
    integrityErrors.length || quarantinedCount ? "Kayıt kontrolü gerekli" : "İşlem defteri tutarlı",
    integrityErrors.length
      ? `${integrityErrors.length} kural ihlali bulundu`
      : quarantinedCount
        ? `${quarantinedCount} kayıt hesaplamadan ayrıldı`
        : `${state.transactions.length} işlem · kural ihlali yok`
  );
  setHealthItem(
    "#quoteHealthItem", "#quoteHealthTitle", "#quoteHealthDetail", quoteLevel,
    state.isDemo ? "Örnek fiyatlar" : (holdings.length ? `${coveredHoldings.length}/${holdings.length} fiyat mevcut` : "Pozisyon bulunmuyor"),
    state.isDemo ? "Canlı veri değildir · yenileyerek doğrula" : (holdings.length ? `Son fiyat kaydı · ${latestQuoteText}` : "İlk işlemle birlikte izlenecek")
  );
  setHealthItem(
    "#backupHealthItem", "#backupHealthTitle", "#backupHealthDetail", backupLevel,
    backupReady ? "Otomatik yedek hazır" : "İlk yedek bekleniyor",
    backupReady ? "Önceki sağlam kayıt korunuyor" : "İlk veri değişikliğinde oluşacak"
  );
  setHealthItem(
    "#historyHealthItem", "#historyHealthTitle", "#historyHealthDetail", historyLevel,
    snapshotCount >= 30 ? "Aylık analiz hazır" : `${snapshotCount} günlük kayıt`,
    monthlyDaysRemaining ? `Aylık analiz için ${monthlyDaysRemaining} gün daha` : "Dönem getirileri hesaplanabilir"
  );

  const hasLedgerProblem = integrityErrors.length > 0 || quarantinedCount > 0;
  const serverOffline = runtimeHealth.server === "offline";
  const overallClass = hasLedgerProblem ? "warn" : serverOffline ? "warn" : runtimeHealth.server === "checking" ? "neutral" : "live";
  const overallLabel = hasLedgerProblem ? "Kontrol gerekli" : serverOffline ? "Sunucu çevrimdışı" : runtimeHealth.server === "checking" ? "Kontrol ediliyor" : "Temel sağlam";
  const foundationTitle = $("#foundationTitle");
  if (foundationTitle) foundationTitle.textContent = hasLedgerProblem
    ? "İşlem defteri kontrol gerektiriyor"
    : serverOffline
      ? "Portföy açık · fiyat sunucusu çevrimdışı"
      : "Portföy altyapısı sağlam";
  [$("#foundationStatusBadge"), $("#settingsHealthBadge")].forEach(badge => {
    if (!badge) return;
    badge.className = `status-chip ${overallClass}`;
    badge.textContent = overallLabel;
  });

  const localStatus = $("#localSystemStatus");
  const localStatusText = $("#localSystemStatusText");
  if (localStatus) localStatus.className = `local-status ${serverOffline ? "error" : runtimeHealth.server === "checking" ? "warn" : ""}`.trim();
  if (localStatusText) localStatusText.textContent = serverOffline
    ? (runtimeHealth.cloud ? "Bulut hizmetine ulaşılamıyor" : "Yerel sunucuya ulaşılamıyor")
    : runtimeHealth.server === "checking"
      ? (runtimeHealth.cloud ? "Bulut bağlantısı doğrulanıyor" : "Yerel sistem doğrulanıyor")
      : (runtimeHealth.cloud ? "Özel bulut bağlantısı aktif" : "Yerel sistem aktif");
  const appVersion = $("#appVersion");
  if (appVersion) appVersion.textContent = `v${APP_VERSION}`;

  const serverLevel = serverOffline ? "error" : runtimeHealth.server === "checking" ? "warn" : "ok";
  setDiagnosticCard(
    "#systemServerValue", "#systemServerDetail", serverLevel,
    serverOffline ? "Bağlantı yok" : runtimeHealth.server === "checking" ? "Doğrulanıyor" : "Çalışıyor",
    runtimeHealth.serverVersion
      ? runtimeHealth.cloud
        ? `Bulut sürümü v${runtimeHealth.serverVersion} · cihazlar arası erişim`
        : `Sunucu v${runtimeHealth.serverVersion} · yalnızca 127.0.0.1`
      : runtimeHealth.cloud ? "Bulut bağlantısı denetleniyor" : "Yerel bağlantı denetleniyor"
  );
  setDiagnosticCard(
    "#systemLedgerValue", "#systemLedgerDetail", ledgerLevel,
    hasLedgerProblem ? "Kontrol gerekli" : "Tutarlı",
    `${state.transactions.length} işlem · veri şeması v${STATE_SCHEMA_VERSION}`
  );
  setDiagnosticCard(
    "#systemBackupValue", "#systemBackupDetail", backupLevel,
    backupReady ? "Hazır" : "Bekleniyor",
    backupReady ? "Son sağlam yerel kayıt korunuyor" : "İlk değişiklikte otomatik oluşur"
  );
  const storageLevel = runtimeHealth.storageOk === false ? "error" : runtimeHealth.storageOk === null ? "warn" : "ok";
  const storageUsage = runtimeHealth.storage?.usage;
  const storageQuota = runtimeHealth.storage?.quota;
  setDiagnosticCard(
    "#systemStorageValue", "#systemStorageDetail", storageLevel,
    runtimeHealth.storageOk === false ? "Kullanılamıyor" : runtimeHealth.storageOk === null ? "Doğrulanıyor" : "Erişilebilir",
    Number.isFinite(storageUsage) && Number.isFinite(storageQuota)
      ? `${formatStorageSize(storageUsage)} / ${formatStorageSize(storageQuota)} kullanılıyor`
      : "Tarayıcı yerel deposu"
  );
  const checkedAt = $("#systemHealthCheckedAt");
  if (checkedAt) checkedAt.textContent = runtimeHealth.checkedAt
    ? `Son denetim · ${runtimeHealth.checkedAt.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
    : "Denetim sürüyor";
}

async function loadRuntimeHealth({ notify = false } = {}) {
  const button = $("#runHealthCheckButton");
  if (button) { button.disabled = true; button.textContent = "↻ Denetleniyor…"; }
  runtimeHealth.server = "checking";
  renderSystemHealth(calculatePortfolio());
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const payload = await readJsonResponse(response, "system");
    if (!response.ok || payload?.ok !== true) throw new Error("Yerel sunucu sağlıklı yanıt vermedi.");
    runtimeHealth.server = "online";
    runtimeHealth.serverVersion = payload.version || null;
    runtimeHealth.cloud = payload.cloudSync === true || payload.provider === "cloud";
    document.body.dataset.cloudMode = runtimeHealth.cloud ? "true" : "false";
  } catch (_) {
    runtimeHealth.server = "offline";
    runtimeHealth.serverVersion = null;
  }
  try {
    const probeKey = `${STORAGE_KEY}:health-probe`;
    localStorage.setItem(probeKey, "1");
    localStorage.removeItem(probeKey);
    runtimeHealth.storageOk = true;
    runtimeHealth.storage = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
  } catch (_) {
    runtimeHealth.storageOk = false;
    runtimeHealth.storage = null;
  }
  runtimeHealth.checkedAt = new Date();
  renderSystemHealth(calculatePortfolio());
  if (button) { button.disabled = false; button.textContent = "↻ Durumu yeniden denetle"; }
  if (notify) showToast(runtimeHealth.server === "online"
    ? "Sistem ve veri durumu yeniden denetlendi."
    : runtimeHealth.cloud
      ? "Buluta ulaşılamadı; bağlantı gelince değişiklikler yeniden eşitlenecek."
      : "Yerel sunucuya ulaşılamadı; kayıtlar tarayıcıda açık kalır.");
}

function renderDailyBrief(data) {
  const target = $("#dailyBriefList");
  if (!target) return;
  const items = [];
  const movements = (data?.holdings || []).map(holding => {
    const changePct = Number(holding.quote?.changePct);
    return {
      symbol: holding.symbol,
      changePct,
      impact: Number.isFinite(changePct) ? baseValue(holding.value, holding.currency) * changePct / 100 : null
    };
  }).filter(item => Number.isFinite(item.changePct)).sort((left, right) => Math.abs(right.impact) - Math.abs(left.impact));

  if (movements.length) {
    const leader = movements[0];
    items.push({
      kind: "market",
      tone: typeClass(leader.changePct),
      icon: leader.changePct >= 0 ? "↗" : "↘",
      label: "Piyasa etkisi",
      title: `${leader.symbol.replace(/\.IS$/i, "")} bugünkü hareketi sürüklüyor`,
      detail: `${signedPercent(leader.changePct)} · portföye yaklaşık ${signedMoney(leader.impact)} etki`
    });
  }

  const expenses = Array.isArray(state.expenses) ? state.expenses : [];
  const inferred = inferredExpenseStatementMonths(expenses);
  const months = [...new Set(expenses.map(expense => expenseReportingMonth(expense, inferred)).filter(Boolean))].sort();
  const latestMonth = months.at(-1);
  if (latestMonth) {
    const expenseSignals = analyzeExpenseAnomalies(expenses, latestMonth, inferred).items;
    if (expenseSignals.length) {
      const signal = expenseSignals[0];
      items.push({ kind: "expense", tone: signal.tone, icon: "!", label: "Harcama sinyali", title: signal.title, detail: signal.detail, page: "expenses" });
    }
  }

  const thesisAlert = getThesisAlerts()[0];
  const budget = calculateInvestmentBudget();
  if (thesisAlert) {
    items.push({ kind: "thesis", tone: thesisAlert.tone, icon: "◎", label: "Tez kontrolü", title: thesisAlert.title, detail: thesisAlert.detail, page: "decision" });
  } else if (budget.configured) {
    items.push({
      kind: "budget",
      tone: budget.recommended > 0 ? "positive" : "warn",
      icon: "₺",
      label: "Yatırım bütçesi",
      title: budget.recommended > 0 ? `Bu ay için ${formatMoney(budget.recommended, "TRY", { maximumFractionDigits: 0 })}` : "Bu ay nakit tamponu öncelikli",
      detail: budget.recommended > 0 ? "Nakit akışı ve güvenlik payı sonrası üst sınır" : "Gelir, ödemeler ve tampon hedefi yatırım payı bırakmıyor",
      page: "decision"
    });
  }

  const nextEvent = upcomingCalendarItems(90)[0];
  if (nextEvent) {
    const days = Math.round((new Date(`${nextEvent.date}T12:00:00`) - new Date(`${today()}T12:00:00`)) / 86400000);
    items.push({
      kind: "calendar",
      tone: days <= 3 ? "warn" : "neutral",
      icon: "□",
      label: days === 0 ? "Bugün" : days === 1 ? "Yarın" : `${days} gün sonra`,
      title: nextEvent.title,
      detail: `${formatCalendarDate(nextEvent.date)}${nextEvent.symbol ? ` · ${nextEvent.symbol}` : ""}`,
      page: "calendar"
    });
  }

  if (!items.length) {
    target.innerHTML = `<div class="daily-brief-empty"><span>✓</span><div><strong>Şimdilik önemli bir değişiklik yok.</strong><p>Yeni fiyat, ekstre veya takvim olayı geldiğinde burada öne çıkarılacak.</p></div></div>`;
    return;
  }
  target.innerHTML = items.slice(0, 3).map(item => `<button class="daily-brief-item ${item.tone}" type="button" ${item.page ? `data-brief-page="${item.page}"` : "disabled"}>
    <span class="daily-brief-icon" aria-hidden="true">${item.icon}</span>
    <span class="daily-brief-copy"><small>${escapeHtml(item.label)}</small><strong>${escapeHtml(item.title)}</strong><em>${escapeHtml(item.detail)}</em></span>
    ${item.page ? `<span class="daily-brief-arrow" aria-hidden="true">→</span>` : ""}
  </button>`).join("");
}

function renderDashboard(data) {
  if (typeof renderDashboard._showingAlternateCurrency !== "boolean") renderDashboard._showingAlternateCurrency = false;
  const totalValueElement = $("#totalValue");
  if (totalValueElement) {
    const fx = number(state.settings.fxUsdTry) || DEFAULT_FX;
    const alternateCurrency = state.settings.baseCurrency === "TRY" ? "USD" : "TRY";
    const alternateValue = state.settings.baseCurrency === "TRY" ? data.totalValue / fx : data.totalValue * fx;
    const showingAlternate = renderDashboard._showingAlternateCurrency;
    totalValueElement.textContent = showingAlternate
      ? formatMoney(alternateValue, alternateCurrency)
      : formatMoney(data.totalValue, state.settings.baseCurrency);
    totalValueElement.dataset.currency = showingAlternate ? alternateCurrency : state.settings.baseCurrency;
    totalValueElement.title = showingAlternate
      ? `${state.settings.baseCurrency} değerine dön`
      : `${alternateCurrency} karşılığını göster`;
    totalValueElement.setAttribute("aria-label", `Toplam portföy değeri ${totalValueElement.textContent}. ${totalValueElement.title}.`);
  }
  $("#totalContext").textContent = `${data.holdings.length} açık pozisyon · ${state.settings.baseCurrency} temel para birimi`;
  setMetric("#dayChange", data.dayChange, signedMoney(data.dayChange));
  setMetric("#dayChangePct", data.dayChangePct, signedPercent(data.dayChangePct));
  
  setMetric("#totalPnl", data.holdingsPnl, signedMoney(data.holdingsPnl));
  const holdingsPnlPct = data.totalCost ? data.holdingsPnl / data.totalCost * 100 : 0;
  setMetric("#totalPnlPct", holdingsPnlPct, signedPercent(holdingsPnlPct));
  
  const totalPnl = data.potentialTotalPnl;
  setMetric("#totalKarZarar", totalPnl, signedMoney(totalPnl));
  const totalPnlDetail = $("#totalKarZararSub");
  if (totalPnlDetail) {
    totalPnlDetail.textContent = `Açık: ${signedMoney(data.holdingsPnl)} · Kapalı: ${signedMoney(data.totalClosedPnl)}`;
    totalPnlDetail.className = `trend-text ${typeClass(totalPnl)}`;
  }
  renderHoldingRows("#portfolioTable", data.holdings, false);
  $("#portfolioSummary").textContent = data.holdings.length ? `En büyük pozisyon: ${data.holdings[0].symbol} · ${formatNumber(baseValue(data.holdings[0].value, data.holdings[0].currency) / Math.max(data.totalValue, 1) * 100, 1)}%` : "İşlem ekleyerek portföyünü oluştur.";
  renderExecutiveReport(data);
  renderAllocation(data);
  renderChart(data);
  renderBenchmark(data);
  renderEtfMarketPanel();
  void loadEtfMarketOverview();
  $("#insightList").innerHTML = getInsights(data).map(item => `<li>${item}</li>`).join("");
  renderDailyBrief(data);
}

function calculateEtfSeries(points) {
  const periods = [10, 21, 50, 200];
  const clean = (Array.isArray(points) ? points : [])
    .filter(point => Number.isFinite(Number(point?.t)) && Number.isFinite(Number(point?.c)) && Number(point.c) > 0)
    .map(point => ({ t: Number(point.t), c: Number(point.c) }))
    .sort((left, right) => left.t - right.t);
  const rolling = Object.fromEntries(periods.map(period => [period, 0]));
  return clean.map((point, index) => {
    const row = { ...point };
    periods.forEach(period => {
      rolling[period] += point.c;
      if (index >= period) rolling[period] -= clean[index - period].c;
      row[`sma${period}`] = index >= period - 1 ? rolling[period] / period : null;
    });
    return row;
  });
}

function etfChartPath(points, field, xFor, yFor) {
  let path = "";
  let drawing = false;
  points.forEach((point, index) => {
    const rawValue = point[field];
    const value = Number(rawValue);
    if (rawValue === null || rawValue === undefined || !Number.isFinite(value)) { drawing = false; return; }
    path += `${drawing ? "L" : "M"}${xFor(index).toFixed(1)},${yFor(value).toFixed(1)}`;
    drawing = true;
  });
  return path;
}

function formatEtfDate(timestamp) {
  return new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short" }).format(new Date(timestamp * 1000));
}

function describeEtfTrend(item, last, dailyChangePct) {
  const averages = [last.sma10, last.sma21, last.sma50, last.sma200];
  const hasAll = averages.every(Number.isFinite);
  const aboveAll = hasAll && averages.every(value => last.c > value);
  const belowAll = hasAll && averages.every(value => last.c < value);
  const bullStack = hasAll && last.sma10 > last.sma21 && last.sma21 > last.sma50 && last.sma50 > last.sma200;
  const bearStack = hasAll && last.sma10 < last.sma21 && last.sma21 < last.sma50 && last.sma50 < last.sma200;
  const distance200 = Number.isFinite(last.sma200) && last.sma200 !== 0 ? (last.c / last.sma200 - 1) * 100 : null;
  const momentum = !Number.isFinite(dailyChangePct) ? "Günlük momentum hesaplanamadı."
    : Math.abs(dailyChangePct) < .15 ? `Kısa vadeli momentum yatay (günlük ${signedPercent(dailyChangePct)}).`
    : `Günlük momentum ${dailyChangePct > 0 ? "pozitif" : "negatif"} (${signedPercent(dailyChangePct)}).`;
  if (aboveAll && bullStack) return `${item.symbol} ${formatNumber(last.c, 2)}; fiyat tüm ortalamaların üzerinde ve 10G > 21G > 50G > 200G boğa dizilimi korunuyor. ${momentum}`;
  if (aboveAll) return `${item.symbol} ${formatNumber(last.c, 2)}; fiyat bütün hareketli ortalamaların üzerinde. 200G ortalamaya uzaklık ${performancePercent(distance200)}. ${momentum}`;
  if (belowAll && bearStack) return `${item.symbol} ${formatNumber(last.c, 2)}; fiyat tüm ortalamaların altında ve ayı dizilimi belirgin. ${momentum}`;
  if (belowAll) return `${item.symbol} ${formatNumber(last.c, 2)}; fiyat bütün hareketli ortalamaların altında. 200G ortalamaya uzaklık ${performancePercent(distance200)}. ${momentum}`;
  return `${item.symbol} ${formatNumber(last.c, 2)}; fiyat hareketli ortalamaların arasında, trend geçiş bölgesinde. 200G ortalamaya uzaklık ${performancePercent(distance200)}. ${momentum}`;
}

function renderEtfChart(item, sourcePoints) {
  const series = calculateEtfSeries(sourcePoints);
  const points = series.slice(-60);
  const last = points.at(-1);
  if (!last) return "";
  const previous = points.at(-2);
  const dailyChangePct = previous?.c ? (last.c / previous.c - 1) * 100 : null;
  const fields = ["c", "sma10", "sma21", "sma50", "sma200"];
  const values = points.flatMap(point => fields
    .map(field => point[field])
    .filter(value => value !== null && value !== undefined && Number.isFinite(Number(value)))
    .map(Number));
  const rawMin = Math.min(...values), rawMax = Math.max(...values);
  const padding = Math.max((rawMax - rawMin) * .12, rawMax * .008, .5);
  const min = rawMin - padding, max = rawMax + padding;
  const width = 1000, height = 250, left = 58, right = 22, top = 24, bottom = 35;
  const xFor = index => left + index / Math.max(points.length - 1, 1) * (width - left - right);
  const yFor = value => top + (max - value) / Math.max(max - min, 1) * (height - top - bottom);
  const grid = [0, .5, 1].map(ratio => {
    const value = max - ratio * (max - min), y = yFor(value);
    return `<line class="etf-chart-grid" x1="${left}" x2="${width-right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text class="etf-chart-axis" x="${left-9}" y="${(y+4).toFixed(1)}" text-anchor="end">${escapeHtml(formatNumber(value, 0))}</text>`;
  }).join("");
  const paths = fields.map(field => `<path class="etf-chart-line ${field}" d="${etfChartPath(points, field, xFor, yFor)}"/>`).join("");
  const legend = [
    ["c", "Fiyat", last.c], ["sma10", "10G", last.sma10], ["sma21", "21G", last.sma21],
    ["sma50", "50G", last.sma50], ["sma200", "200G", last.sma200]
  ].map(([field, label, value]) => `<span><i class="${field}"></i>${label}${Number.isFinite(value) ? ` (${formatNumber(value, 2)})` : ""}</span>`).join("");
  const tone = typeClass(dailyChangePct);
  const updated = formatEtfDate(last.t);
  return `<article class="etf-card">
    <div class="etf-card-title">
      <div><strong>${item.symbol} <span>— ${escapeHtml(item.name)}</span></strong><small>${formatNumber(last.c, 2)} · <em class="${tone}">${performancePercent(dailyChangePct)}</em></small></div>
      <button class="text-button" type="button" data-etf-open="${item.symbol}" aria-label="${item.symbol} detay analizini aç">Detay analiz →</button>
    </div>
    <div class="etf-chart-legend">${legend}</div>
    <div class="etf-chart-wrap"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${item.symbol} fiyat ve 10, 21, 50, 200 günlük hareketli ortalama grafiği">${grid}${paths}<circle class="etf-latest-dot" cx="${xFor(points.length-1)}" cy="${yFor(last.c)}" r="4.5"/><text class="etf-chart-axis" x="${left}" y="${height-7}">${formatEtfDate(points[0].t)}</text><text class="etf-chart-axis" x="${xFor(Math.floor((points.length-1)/2))}" y="${height-7}" text-anchor="middle">${formatEtfDate(points[Math.floor((points.length-1)/2)].t)}</text><text class="etf-chart-axis" x="${width-right}" y="${height-7}" text-anchor="end">${updated}</text></svg></div>
    <p class="etf-reading"><strong>Okuma:</strong> ${escapeHtml(describeEtfTrend(item, last, dailyChangePct))}</p>
    <p class="etf-source">Yahoo Finance · ${updated} · son ${points.length} seans · SMA'lar tarayıcıda hesaplandı</p>
  </article>`;
}

function renderEtfMarketPanel() {
  const target = $("#etfMarketGrid"), status = $("#etfMarketStatus"), button = $("#refreshEtfMarketButton");
  if (!target || !status) return;
  if (button) { button.disabled = etfMarketView.loading; button.textContent = etfMarketView.loading ? "↻ ETF verileri alınıyor…" : "↻ ETF verilerini yenile"; }
  const cards = ETF_MARKET_ITEMS.map(item => {
    const points = etfMarketView.items[item.symbol];
    return Array.isArray(points) && points.length ? renderEtfChart(item, points) : "";
  }).filter(Boolean);
  if (cards.length) target.innerHTML = cards.join("");
  else if (etfMarketView.loading) target.innerHTML = ETF_MARKET_ITEMS.map(item => `<article class="etf-card etf-card-loading"><div></div><span>${item.symbol} verisi hazırlanıyor…</span></article>`).join("");
  else target.innerHTML = `<div class="service-error-state"><strong>ETF verisi henüz yüklenmedi</strong><p>Yenileyerek tekrar deneyebilirsin.</p></div>`;
  const loadedLabel = etfMarketView.loadedAt ? new Date(etfMarketView.loadedAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }) : "";
  status.textContent = etfMarketView.loading ? "SPY, QQQ ve SMH tarihsel fiyatları alınıyor…"
    : etfMarketView.errors.length ? `${etfMarketView.errors.join(", ")} verisi alınamadı; diğer ETF kartları güncel. Yenileyerek tekrar deneyebilirsin.`
    : loadedLabel ? `3 ETF güncel · ${loadedLabel}` : "";
  status.className = `etf-market-status${etfMarketView.errors.length ? " error" : ""}`;
}

async function loadEtfMarketOverview(force = false) {
  if (etfMarketView.loading) return;
  if (!force && ETF_MARKET_ITEMS.every(item => Array.isArray(etfMarketView.items[item.symbol])) && Date.now() - etfMarketView.loadedAt < 15 * 60 * 1000) return;
  const requestId = ++etfMarketView.requestId;
  etfMarketView.loading = true;
  etfMarketView.errors = [];
  if (force) ETF_MARKET_ITEMS.forEach(item => technicalHistoryCache.delete(`${item.symbol}|1y`));
  renderEtfMarketPanel();
  const results = await Promise.allSettled(ETF_MARKET_ITEMS.map(async item => ({ item, points: await getTechnicalHistory(item.symbol, "1y") })));
  if (requestId !== etfMarketView.requestId) return;
  results.forEach((result, index) => {
    const item = ETF_MARKET_ITEMS[index];
    if (result.status === "fulfilled") etfMarketView.items[item.symbol] = result.value.points;
    else etfMarketView.errors.push(item.symbol);
  });
  etfMarketView.loading = false;
  if (Object.keys(etfMarketView.items).length) etfMarketView.loadedAt = Date.now();
  renderEtfMarketPanel();
}

let benchmarkPeriod = "1d";
let allocationMode = "assetClass";

function recordDailySnapshot(data) {
  if ((!state.transactions.length && !state.closedPositions.length) || data.integrityErrors.length) return;
  if (state.transactions.some(tx => tx.date > today())) return;
  if (state.closedPositions.some(position => position.sellDate > today())) return;
  if (!state.isDemo && data.holdings.some(holding => !holding.quote.updatedAt
    || Core.localDateISO(new Date(holding.quote.updatedAt)) !== today()
    || holding.quote.fallbackPrice || ["sample", "transaction_cost"].includes(holding.quote.source))) return;
  if (!state.dailySnapshots) state.dailySnapshots = [];
  const todayStr = today();
  const snapshot = {
    date: todayStr,
    value: Math.round(data.holdingsValue * 100) / 100,
    holdingsKey: Core.holdingsKey(data.holdings),
    netFlows: Math.round(Core.cumulativeExternalFlow(state.transactions, state.settings, todayStr) * 100) / 100,
    baseCurrency: state.settings.baseCurrency,
    includeCash: false,
    fxUsdTry: state.settings.fxUsdTry,
    isDemo: state.isDemo === true,
    unrealizedPnl: data.holdingsPnl,
    realizedPnl: data.totalClosedPnl,
    totalPnl: data.potentialTotalPnl
  };
  const existing = state.dailySnapshots.find(s => s.date === todayStr
    && s.baseCurrency === snapshot.baseCurrency && (s.isDemo === true) === snapshot.isDemo && s.includeCash !== true);
  if (existing && Object.entries(snapshot).every(([key, value]) => existing[key] === value)) return;
  snapshot.capturedAt = Date.now();
  if (existing) {
    Object.assign(existing, snapshot);
  } else {
    state.dailySnapshots.push(snapshot);
  }
  if (state.dailySnapshots.length > 1100) {
    state.dailySnapshots = state.dailySnapshots.slice(-1095);
  }
  state.dailySnapshots.sort((a, b) => a.date.localeCompare(b.date));
  state.history = state.dailySnapshots.map(s => s.value);
  saveState({ recordUndo: false });
}

function getUserPeriodReturn(period, data) {
  if (period === "1d") return data.dayChangePct;

  const now = new Date();
  let targetDate;
  if (period === "1m") {
    targetDate = calendarMonthsAgo(1, now);
  } else if (period === "3m") {
    targetDate = calendarMonthsAgo(3, now);
  } else if (period === "6m") {
    targetDate = calendarMonthsAgo(6, now);
  } else if (period === "ytd") {
    targetDate = new Date(now.getFullYear(), 0, 1);
  } else if (period === "1y") {
    targetDate = calendarYearsAgo(1, now);
  } else {
    return null;
  }

  return Core.calculatePeriodReturn({
    snapshots: portfolioPerformanceSnapshots(),
    currentValue: data.totalValue,
    transactions: state.transactions,
    settings: state.settings,
    targetDate: Core.localDateISO(targetDate)
  });
}

function renderBenchmark(data) {
  const target = $("#benchmarkGrid");
  if (!target) return;

  const benchmarks = state.benchmarks || {};

  const periodNames = {
    "1d": "1 Günlük",
    "1m": "1 Aylık",
    "3m": "3 Aylık",
    "6m": "6 Aylık",
    "ytd": "Yılbaşından Bu Yana (YTD)",
    "1y": "1 Yıllık"
  };

  const userReturn = getUserPeriodReturn(benchmarkPeriod, data);
  const hasUserReturn = Number.isFinite(userReturn);

  const subTitle = $("#benchmarkSubtitle");
  if (subTitle) {
    subTitle.textContent = `Portföyünüzün ${periodNames[benchmarkPeriod] || benchmarkPeriod} getirisi ile BIST 100 ve S&P 500 kıyaslaması.`;
  }

  const items = [
    { key: "XU100", title: "BIST 100", benchmark: benchmarks.XU100 },
    { key: "SP500", title: "S&P 500", benchmark: benchmarks.SP500 }
  ];

  target.innerHTML = items.map(item => {
    const bm = item.benchmark || {};
    const rawReturn = (bm.periods && bm.periods[benchmarkPeriod] !== undefined)
      ? Number(bm.periods[benchmarkPeriod])
      : Number(bm.changePct);
    const hasBenchmark = Number.isFinite(Number(bm.price)) && Number(bm.price) > 0 && Number.isFinite(rawReturn);
    const bmReturn = hasBenchmark ? rawReturn : null;

    const diff = hasUserReturn && hasBenchmark ? userReturn - bmReturn : null;
    const isWin = diff !== null && diff >= 0;
    const statusText = !hasBenchmark
      ? "Endeks verisi alınamadı"
      : !hasUserReturn
      ? "Yeterli portföy geçmişi yok"
      : isWin
      ? `Önde · ${item.title}'ü ${signedPercent(diff)} geçtiniz.`
      : `Geride · ${item.title}'ün ${formatNumber(Math.abs(diff), 2)}% gerisindesiniz`;
    const statusClass = !hasBenchmark || !hasUserReturn ? "neutral" : isWin ? "win" : "loss";

    const maxAbs = Math.max(hasUserReturn ? Math.abs(userReturn) : 0, hasBenchmark ? Math.abs(bmReturn) : 0, 1);
    const userBarWidth = hasUserReturn ? Math.min(100, Math.max(8, (Math.abs(userReturn) / maxAbs) * 100)) : 0;
    const bmBarWidth = hasBenchmark ? Math.min(100, Math.max(8, (Math.abs(bmReturn) / maxAbs) * 100)) : 0;

    const bmPriceFormatted = !hasBenchmark
      ? "Veri bekleniyor"
      : item.key === "XU100"
      ? `${formatNumber(bm.price, 0)} Puan`
      : formatMoney(bm.price, "USD");

    return `
      <article class="benchmark-card">
        <div class="benchmark-card-header">
          <div>
            <div class="benchmark-name">${escapeHtml(item.title)}</div>
            <div class="benchmark-value">Endeks: ${bmPriceFormatted}${hasBenchmark ? ` · ${periodNames[benchmarkPeriod] || ""}: ${signedPercent(bmReturn)}` : ""}</div>
          </div>
          <div class="benchmark-status-badge ${statusClass}">${escapeHtml(statusText)}</div>
        </div>
        <div class="benchmark-comparison-bars">
          <div class="benchmark-bar-row">
            <span>Portföyüm</span>
            <div class="benchmark-bar-track">
              <div class="benchmark-bar-fill user" style="width: ${userBarWidth}%"></div>
            </div>
            <strong class="number ${hasUserReturn ? typeClass(userReturn) : ""}">${hasUserReturn ? signedPercent(userReturn) : "—"}</strong>
          </div>
          <div class="benchmark-bar-row">
            <span>${escapeHtml(item.title)}</span>
            <div class="benchmark-bar-track">
              <div class="benchmark-bar-fill index" style="width: ${bmBarWidth}%"></div>
            </div>
            <strong class="number ${hasBenchmark ? typeClass(bmReturn) : ""}">${hasBenchmark ? signedPercent(bmReturn) : "—"}</strong>
          </div>
        </div>
      </article>
    `;
  }).join("");

  renderBenchmarkChart(data);
}

function renderBenchmarkChart(data) {
  const svg = $("#benchmarkChart");
  if (!svg) return;

  const benchmarks = state.benchmarks || {};
  const xu100Full = benchmarks.XU100?.chart || [];
  const sp500Full = benchmarks.SP500?.chart || [];

  if (!xu100Full.length && !sp500Full.length) {
    svg.innerHTML = `<text class="chart-label" x="50%" y="50%" text-anchor="middle">Endeks grafik verisi yükleniyor...</text>`;
    return;
  }

  const periodDays = { "1d": 2, "1m": 25, "3m": 70, "6m": 130, "ytd": 200, "1y": 260 };
  const dayCount = periodDays[benchmarkPeriod] || 260;

  function sliceAndNormalize(fullData) {
    if (!fullData || !fullData.length) return [];
    const sliced = fullData.slice(-dayCount);
    if (!sliced.length) return [];
    const baseClose = sliced[0].c;
    if (!baseClose) return [];
    return sliced.map(p => ((p.c / baseClose) - 1.0) * 100.0);
  }

  const xuPoints = sliceAndNormalize(xu100Full);
  const spPoints = sliceAndNormalize(sp500Full);

  const userReturn = getUserPeriodReturn(benchmarkPeriod, data);
  let userPoints = [];
  const rawSnapshots = portfolioPerformanceSnapshots();

  if (rawSnapshots.length >= 2) {
    const now = new Date();
    let targetDate;
    if (benchmarkPeriod === "1d") { targetDate = new Date(now); targetDate.setDate(targetDate.getDate() - 1); }
    else if (benchmarkPeriod === "1m") { targetDate = calendarMonthsAgo(1, now); }
    else if (benchmarkPeriod === "3m") { targetDate = calendarMonthsAgo(3, now); }
    else if (benchmarkPeriod === "6m") { targetDate = calendarMonthsAgo(6, now); }
    else if (benchmarkPeriod === "ytd") { targetDate = new Date(now.getFullYear(), 0, 1); }
    else if (benchmarkPeriod === "1y") { targetDate = calendarYearsAgo(1, now); }
    else { targetDate = calendarYearsAgo(1, now); }

    const targetStr = Core.localDateISO(targetDate);
    let startIdx = 0;
    for (let i = 0; i < rawSnapshots.length; i++) {
      if (rawSnapshots[i].date <= targetStr) startIdx = i;
      else break;
    }
    const relevantSnapshots = rawSnapshots.slice(startIdx);
    if (relevantSnapshots.length >= 2 && relevantSnapshots[0].value) {
      const startingValue = relevantSnapshots[0].value;
      const startingFlow = Number.isFinite(Number(relevantSnapshots[0].netFlows))
        ? Number(relevantSnapshots[0].netFlows)
        : Core.cumulativeExternalFlow(state.transactions, state.settings, relevantSnapshots[0].date);
      const pts = relevantSnapshots.map(s => {
        const flow = Number.isFinite(Number(s.netFlows))
          ? Number(s.netFlows)
          : Core.cumulativeExternalFlow(state.transactions, state.settings, s.date);
        return ((s.value - (flow - startingFlow)) / startingValue - 1.0) * 100.0;
      });
      const maxPt = Math.max(...pts.map(Math.abs));
      if (maxPt < 150) {
        userPoints = pts;
      }
    }
  }

  if (!userPoints.length && Number.isFinite(userReturn)) {
    userPoints = [0, userReturn];
  }

  const allVals = [...userPoints, ...xuPoints, ...spPoints].filter(Number.isFinite);
  if (!allVals.length) return;
  let minVal = Math.min(...allVals) - 1;
  let maxVal = Math.max(...allVals) + 1;
  if (minVal > 0) minVal = 0;
  const range = Math.max(maxVal - minVal, 1);

  const width = 540, height = 180, left = 45, right = 15, top = 20, bottom = 25;

  function toPath(values) {
    if (!values.length) return "";
    return values.map((v, i) => {
      const x = left + (i / (values.length - 1)) * (width - left - right);
      const y = top + ((maxVal - v) / range) * (height - top - bottom);
      return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  }

  const zeroY = top + ((maxVal - 0) / range) * (height - top - bottom);
  const zeroInView = zeroY >= top && zeroY <= height - bottom;

  const gridLines = [];
  let step = Math.ceil(range / 4);
  if (step > 50) step = Math.ceil(step / 50) * 50;
  else if (step > 20) step = 20;
  else if (step > 10) step = 10;
  else if (step > 5) step = 5;
  else step = Math.max(1, Math.ceil(step));

  const gridStart = Math.floor(minVal / step) * step;
  for (let v = gridStart; v <= maxVal; v += step) {
    const gy = top + ((maxVal - v) / range) * (height - top - bottom);
    if (gy >= top - 2 && gy <= height - bottom + 2) {
      gridLines.push(`<line class="chart-grid" x1="${left}" x2="${width - right}" y1="${gy.toFixed(1)}" y2="${gy.toFixed(1)}" stroke="#1e2436" stroke-dasharray="3 3"/>`);
      gridLines.push(`<text class="chart-label" x="${left - 4}" y="${(gy + 3).toFixed(1)}" text-anchor="end">${v > 0 ? "+" : ""}${v.toFixed(0)}%</text>`);
    }
  }

  const periodLabels = { "1d": "1 Gün", "1m": "1 Ay", "3m": "3 Ay", "6m": "6 Ay", "ytd": "YTD", "1y": "1 Yıl" };

  svg.innerHTML = `
    ${gridLines.join("")}
    ${zeroInView ? `<line class="chart-grid" x1="${left}" x2="${width - right}" y1="${zeroY.toFixed(1)}" y2="${zeroY.toFixed(1)}" stroke="#3a4260" stroke-width="1"/>` : ""}
    ${xuPoints.length ? `<path class="bchart-line-xu100" d="${toPath(xuPoints)}"/>` : ""}
    ${spPoints.length ? `<path class="bchart-line-sp500" d="${toPath(spPoints)}"/>` : ""}
    ${userPoints.length ? `<path class="bchart-line-user" d="${toPath(userPoints)}"/>` : ""}
    <text class="chart-label" x="${left}" y="${height - 4}">${periodLabels[benchmarkPeriod] || benchmarkPeriod} performans karşılaştırması</text>
  `;
}

function setMetric(selector, value, text) {
  const el = $(selector);
  if (!el) return;
  el.textContent = text;
  el.className = typeClass(value);
}

function renderHoldingRows(selector, holdings, full) {
  const target = $(selector);
  if (!holdings.length) { target.innerHTML = `<tr><td colspan="${full ? 8 : 6}" class="empty-state">Henüz açık pozisyon yok. İlk alış işlemini ekleyebilirsin.</td></tr>`; return; }
  target.innerHTML = holdings.map(h => {
    const logo = companyLogo(h.symbol, h.quote, h.name);
    const tickerPending = Boolean(h.tickerPending);
    const displaySymbol = tickerPending ? "KOD BEKLENİYOR" : h.symbol;
    const rowAttributes = tickerPending
      ? `class="holding-row ticker-pending" aria-label="${escapeHtml(h.name)} işlem kodu bekleniyor"`
      : `class="holding-row" data-holding-symbol="${escapeHtml(h.symbol)}" tabindex="0" role="button" aria-label="${escapeHtml(h.symbol)} ${h.symbol.endsWith(".IS") ? "teknik analizini aç" : "hisse detayını aç"}"`;
    const actionMenu = `<details class="row-actions-menu"><summary class="button small secondary" aria-label="${escapeHtml(h.symbol)} diğer işlemleri">•••</summary><div class="row-actions-popover"><button class="menu-action danger-text" type="button" onclick="deleteHoldingPosition('${escapeHtml(h.symbol)}', event)">Pozisyonu sil</button></div></details>`;
    const actionBtns = tickerPending ? `
      <button class="button small secondary" type="button" onclick="editHoldingPosition('${escapeHtml(h.symbol)}', event)">Kodu düzenle</button>${actionMenu}
    ` : `
      <button class="button small primary" type="button" onclick="quickSellHoldingPosition('${escapeHtml(h.symbol)}', event)" title="${escapeHtml(h.symbol)} pozisyonunu sat">Sat</button>
      <button class="button small secondary" type="button" onclick="editHoldingPosition('${escapeHtml(h.symbol)}', event)" title="${escapeHtml(h.symbol)} pozisyonunu düzenle">Düzenle</button>${actionMenu}
    `;
    const quoteMeta = `<div class="quote-meta">${escapeHtml(describeQuoteContext(h.quote || {}))}</div>`;
    const priceCell = `<div class="holding-values">${formatMoney(h.price, h.currency, { maximumFractionDigits: 2 })}${quoteMeta}</div>`;
    const profitCell = `<div class="holding-values">${signedMoney(baseValue(h.pnl, h.currency))}<div class="security-name ${typeClass(h.pnl)}">${signedPercent(h.pnlPct)}</div></div>`;
    return full ? `
    <tr ${rowAttributes}><td data-label="Varlık"><div class="symbol-wrapper">${logo}<div><strong>${escapeHtml(displaySymbol)}</strong><div class="security-name">${escapeHtml(h.name)}${tickerPending ? " · BIST kodu açıklanması bekleniyor" : ""}</div></div></div></td><td data-label="Piyasa"><span class="market-badge">${escapeHtml(h.market)}</span></td><td data-label="Adet" class="number">${formatNumber(h.quantity, 9)}</td><td data-label="Ort. maliyet" class="number">${formatMoney(h.avgCost, h.currency, { maximumFractionDigits: 2 })}</td><td data-label="Son fiyat" class="number">${priceCell}</td><td data-label="Piyasa değeri" class="number">${formatMoney(h.value, h.currency)}</td><td data-label="K/Z" class="number ${typeClass(h.pnl)}">${profitCell}</td><td data-label="İşlem" class="card-actions">${actionBtns}</td></tr>` : `
    <tr ${rowAttributes}><td data-label="Varlık"><div class="symbol-wrapper">${logo}<div><strong>${escapeHtml(displaySymbol)}</strong><span class="market-badge">${escapeHtml(h.market)}</span><div class="security-name">${escapeHtml(h.name)}${tickerPending ? " · Kod bekleniyor" : ""}</div></div></div></td><td data-label="Adet" class="number">${formatNumber(h.quantity, 9)}</td><td data-label="Son fiyat" class="number">${priceCell}</td><td data-label="Değer" class="number">${formatMoney(baseValue(h.value, h.currency))}</td><td data-label="K/Z" class="number ${typeClass(h.pnl)}">${profitCell}</td><td data-label="İşlem" class="card-actions">${actionBtns}</td></tr>`;
  }).join("");
}

window.quickSellHoldingPosition = function(symbol, event) {
  if (event) event.stopPropagation();
  const holdings = calculatePortfolio().holdings;
  const upper = symbol.toUpperCase();
  const holding = holdings.find(h => h.symbol.toUpperCase() === upper);

  openTransaction("SELL");
  $("#transactionSymbol").value = upper;
  $("#transactionMarket").value = upper.endsWith(".IS") ? "BIST" : "ABD";
  $("#transactionCurrency").value = upper.endsWith(".IS") ? "TRY" : "USD";

  if (holding) {
    if ($("#transactionName")) $("#transactionName").value = holding.name || upper;
    $("#transactionQuantity").value = holding.quantity;
    $("#transactionPrice").value = holding.price || holding.avgCost || "";
    const priceToUse = holding.price || holding.avgCost;
    if (priceToUse && holding.quantity) {
      $("#transactionTotal").value = (holding.quantity * priceToUse).toFixed(2).replace(/\.?0+$/, "");
    }
  }
};

window.editHoldingPosition = function(symbol, event) {
  if (event) event.stopPropagation();
  const upper = symbol.toUpperCase();
  const txs = state.transactions.filter(t => t.symbol && t.symbol.toUpperCase() === upper);
  if (!txs.length) {
    showToast(`${symbol} için kayıtlı işlem bulunamadı.`);
    return;
  }
  if (txs.length === 1) {
    openTransaction("BUY", txs[0].id);
  } else {
    openPositionTxSelectorModal(symbol, txs);
  }
};

window.openPositionTxSelectorModal = function(symbol, txs) {
  const dlg = document.getElementById("positionTxDialog");
  const listEl = document.getElementById("positionTxList");
  if (!dlg || !listEl) return;

  document.getElementById("positionTxDialogTitle").textContent = `${symbol} Pozisyon İşlemleri`;
  listEl.innerHTML = txs.map(tx => `
    <tr>
      <td>${tx.date}</td>
      <td>${transactionLabel(tx.type)}</td>
      <td class="number">${formatNumber(tx.quantity, 4)}</td>
      <td class="number">${formatMoney(tx.price, tx.currency)}</td>
      <td class="number">${formatMoney(tx.quantity * tx.price, tx.currency)}</td>
      <td>
        <button class="button small secondary" type="button" onclick="openTransaction('BUY', '${tx.id}')">Düzenle</button>
        <details class="row-actions-menu"><summary class="button small secondary" aria-label="İşlemin diğer eylemleri">•••</summary><div class="row-actions-popover"><button class="menu-action danger-text" type="button" onclick="deleteTransaction('${tx.id}')">İşlemi sil</button></div></details>
      </td>
    </tr>
  `).join("");

  dlg.showModal();
};

window.deleteHoldingPosition = function(symbol, event) {
  if (event) event.stopPropagation();
  const upper = symbol.toUpperCase();
  if (!confirm(`${symbol} pozisyonunu ve bu hisseye ait tüm işlemleri silmek istediğinize emin misiniz?`)) return;

  state.transactions = state.transactions.filter(tx => (tx.symbol || "").toUpperCase() !== upper);
  delete state.prices[symbol];
  delete state.prices[upper];
  saveState();
  render();
  showToast(`${symbol} pozisyonu silindi.`);
};

function openPortfolioDangerDialog() {
  const data = calculatePortfolio();
  if (!data.holdings.length) { showToast("Silinecek açık pozisyon bulunmuyor.", { undo: false }); return; }
  const affectedTransactions = state.transactions.filter(tx => Boolean(tx.symbol)).length;
  const summary = $("#dangerDeleteSummary");
  if (summary) summary.innerHTML = `<strong>${data.holdings.length} açık pozisyon silinecek</strong><span>${affectedTransactions} işlem kaydı · yaklaşık ${formatMoney(data.holdingsValue)} piyasa değeri</span>`;
  $("#dangerActionsDialog")?.showModal();
}

window.clearAllHoldings = function() {
  state.transactions = state.transactions.filter(tx => !tx.symbol);
  state.history = [];
  saveState();
  render();
  $("#dangerActionsDialog")?.close();
  showToast("Tüm açık pozisyonlar temizlendi. Kendi portföyünüzü ekleyebilirsiniz.");
};

function renderPortfolio(data) {
  renderHoldingRows("#portfolioFullTable", data.holdings, true);
  $("#portfolioPageMeta").textContent = `${data.holdings.length} açık pozisyon`;
}

function isOnWatchlist(symbol) {
  const normalized = String(symbol || "").trim().toUpperCase();
  return state.watchlist.some(item => item.symbol === normalized);
}

function addWatchlistSymbol(symbol, name = "", market = "") {
  const normalizedMarket = Core.normalizeMarket(market, symbol);
  const normalizedSymbol = Core.normalizeSymbol(symbol, normalizedMarket);
  if (!normalizedSymbol || !Core.SYMBOL_PATTERN.test(normalizedSymbol)) {
    showToast("Geçerli bir hisse kodu gir. Örn. THYAO veya NVDA.");
    return false;
  }
  if (calculatePortfolio().holdings.some(holding => holding.symbol === normalizedSymbol)) {
    showToast(`${normalizedSymbol} zaten portföyünde.`);
    return false;
  }
  if (isOnWatchlist(normalizedSymbol)) {
    showToast(`${normalizedSymbol} zaten takip listesinde.`);
    return false;
  }
  state.watchlist.push({
    id: uid("watch"),
    symbol: normalizedSymbol,
    market: normalizedMarket,
    name: String(name || normalizedSymbol).trim() || normalizedSymbol,
    addedAt: Date.now()
  });
  if (!saveState()) {
    state.watchlist = state.watchlist.filter(item => item.symbol !== normalizedSymbol);
    return false;
  }
  render();
  showToast(`${normalizedSymbol} takip listesine eklendi.`);
  void refreshQuotes({ quiet: true });
  return true;
}

function removeWatchlistSymbol(symbol) {
  const normalized = String(symbol || "").trim().toUpperCase();
  const previous = state.watchlist;
  state.watchlist = previous.filter(item => item.symbol !== normalized);
  if (state.watchlist.length === previous.length) return false;
  if (!saveState()) { state.watchlist = previous; return false; }
  render();
  showToast(`${normalized} takip listesinden çıkarıldı.`);
  return true;
}

function saveWatchlistItem(event) {
  event.preventDefault();
  const market = $("#watchlistMarket").value;
  const symbol = $("#watchlistSymbol").value;
  const name = $("#watchlistName").value;
  if (addWatchlistSymbol(symbol, name, market)) event.currentTarget.reset();
}

function renderWatchlist(data = calculatePortfolio()) {
  const target = $("#watchlistTable");
  if (!target) return;
  const holdingSymbols = new Set(data.holdings.map(holding => holding.symbol));
  $("#watchlistPageMeta").textContent = `${state.watchlist.length} izlenen hisse`;
  if (!state.watchlist.length) {
    target.innerHTML = `<tr><td colspan="6" class="empty-state">Takip listen boş. Portföyünde olmayan bir BIST veya ABD hissesini yukarıdan ekleyebilirsin.</td></tr>`;
    return;
  }
  target.innerHTML = state.watchlist.map(item => {
    const quote = state.prices[item.symbol] || {};
    const price = Number(quote.price);
    const change = Number(quote.changePct);
    const hasPrice = Number.isFinite(price) && price > 0;
    const hasChange = Number.isFinite(change);
    const currency = quote.currency || (item.market === "BIST" ? "TRY" : "USD");
    const inPortfolio = holdingSymbols.has(item.symbol);
    return `
      <tr class="watchlist-row" data-watchlist-symbol="${escapeHtml(item.symbol)}" tabindex="0" role="button" aria-label="${escapeHtml(item.symbol)} analizini aç">
        <td><div class="symbol-wrapper">${companyLogo(item.symbol, quote, item.name)}<div><strong>${escapeHtml(item.symbol)}</strong><span class="market-badge">${escapeHtml(item.market)}</span><div class="security-name">${escapeHtml(item.name)}</div></div></div></td>
        <td class="number">${hasPrice ? formatMoney(price, currency, { maximumFractionDigits: 2 }) : "—"}</td>
        <td class="number ${hasChange ? typeClass(change) : ""}">${hasChange ? signedPercent(change) : "—"}</td>
        <td>${inPortfolio ? `<span class="status-chip live">Portföyünde</span>` : `<span class="status-chip neutral">Yalnızca takipte</span>`}</td>
        <td><span class="security-name">${hasPrice ? escapeHtml(describeQuoteContext(quote)) : "Fiyat bekleniyor"}</span></td>
        <td class="watchlist-actions"><button class="button small secondary" type="button" data-watchlist-open="${escapeHtml(item.symbol)}">Analizi aç</button><button class="button small danger" type="button" data-watchlist-remove="${escapeHtml(item.symbol)}">Çıkar</button></td>
      </tr>`;
  }).join("");
}

function toggleStockDetailWatchlist() {
  const symbol = stockDetailView.symbol;
  if (!symbol) return;
  if (isOnWatchlist(symbol)) removeWatchlistSymbol(symbol);
  else addWatchlistSymbol(symbol, stockDetailView.fundamentals?.identity?.name || symbol, "ABD");
  renderStockDetail();
}

function simpleMovingAverage(values, length) {
  const sma = new Array(values.length).fill(null);
  let sum = 0, count = 0;
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(values[i])) { sum += values[i]; count++; }
    if (i >= length && Number.isFinite(values[i - length])) { sum -= values[i - length]; count--; }
    if (count === length) sma[i] = sum / length;
  }
  return sma;
}

function exponentialMovingAverage(values, length) {
  const ema = new Array(values.length).fill(null);
  let sum = 0, count = 0, firstValid = -1;
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(values[i])) { sum += values[i]; count++; if (firstValid === -1) firstValid = i; }
    if (count === length) { ema[i] = sum / length; break; }
  }
  if (count < length) return ema;
  const k = 2 / (length + 1);
  for (let i = firstValid + length; i < values.length; i++) {
    if (Number.isFinite(values[i])) {
      ema[i] = (values[i] - ema[i - 1]) * k + ema[i - 1];
    } else {
      ema[i] = ema[i - 1];
    }
  }
  return ema;
}

function calculateRsi(values, length = 14) {
  const rsi = new Array(values.length).fill(null);
  if (values.length <= length) return rsi;
  let gains = 0, losses = 0;
  for (let i = 1; i <= length; i++) {
    const change = values[i] - values[i - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  let averageGain = gains / length;
  let averageLoss = losses / length;
  rsi[length] = averageLoss === 0 ? 100 : 100 - (100 / (1 + averageGain / averageLoss));
  for (let i = length + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    averageGain = ((averageGain * (length - 1)) + Math.max(change, 0)) / length;
    averageLoss = ((averageLoss * (length - 1)) + Math.max(-change, 0)) / length;
    rsi[i] = averageLoss === 0 ? 100 : 100 - (100 / (1 + averageGain / averageLoss));
  }
  return rsi;
}

function latestFinite(values) {
  for (let i = values.length - 1; i >= 0; i--) if (Number.isFinite(values[i])) return values[i];
  return null;
}

function latestCross(fast, slow) {
  let previous = null;
  let cross = null;
  for (let i = 0; i < fast.length; i++) {
    if (!Number.isFinite(fast[i]) || !Number.isFinite(slow[i])) continue;
    const current = fast[i] - slow[i];
    if (previous !== null && ((previous < 0 && current >= 0) || (previous > 0 && current <= 0))) {
      cross = current >= 0 ? "up" : "down";
    }
    previous = current;
  }
  return cross;
}

function getTechnicalMetrics(points) {
  const closes  = points.map(p => Number(p.c));
  const highs   = points.map(p => Number(p.h) || Number(p.c));
  const lows    = points.map(p => Number(p.l) || Number(p.c));
  const volumes = points.map(p => Number(p.v) || 0);
  const sma20Array = simpleMovingAverage(closes, 20);
  const sma50Array = simpleMovingAverage(closes, 50);
  const sma200Array = simpleMovingAverage(closes, 200);
  const rsiArray = calculateRsi(closes);
  
  const ema12 = exponentialMovingAverage(closes, 12);
  const ema26 = exponentialMovingAverage(closes, 26);
  const macdLine = closes.map((_, i) => (Number.isFinite(ema12[i]) && Number.isFinite(ema26[i])) ? ema12[i] - ema26[i] : null);
  const macdSignal = exponentialMovingAverage(macdLine, 9);
  const macdHist = macdLine.map((_, i) => (Number.isFinite(macdLine[i]) && Number.isFinite(macdSignal[i])) ? macdLine[i] - macdSignal[i] : null);

  const price = closes.at(-1) || 0;
  const values = { sma20: latestFinite(sma20Array), sma50: latestFinite(sma50Array), sma200: latestFinite(sma200Array), rsi: latestFinite(rsiArray) };
  const priceChannel = Core.analyzeTrendChannel(closes, { lookback: 60, minPoints: 20 });
  let trend = "Nötr";
  if (values.sma20 && values.sma50 && price > values.sma20 && values.sma20 > values.sma50) trend = "Yükseliş eğilimi";
  if (values.sma20 && values.sma50 && price < values.sma20 && values.sma20 < values.sma50) trend = "Düşüş eğilimi";
  return { closes, highs, lows, volumes, sma20Array, sma50Array, sma200Array, rsiArray, macdLine, macdSignal, macdHist, priceChannel, price, ...values, trend, cross: latestCross(sma20Array, sma50Array) };
}

function buildTrendCheckReport(symbol, market, strategyKey, cost, points) {
  const config = TREND_CHECK_STRATEGIES[strategyKey] || TREND_CHECK_STRATEGIES.swing;
  const cleanPoints = points.filter(point => Number.isFinite(Number(point?.c)) && Number(point.c) > 0);
  if (cleanPoints.length < 55) throw new Error("Trend raporu için en az 55 işlem günü gerekiyor.");

  const metrics = getTechnicalMetrics(cleanPoints);
  const price = Number(metrics.price);
  const rawAtr = calcATR(metrics.highs, metrics.lows, metrics.closes, config.atrPeriod);
  const atr = Number.isFinite(rawAtr) && rawAtr > 0 ? rawAtr : price * 0.02;
  const lookbackHigh = Math.max(...metrics.highs.slice(-config.lookback));
  const rawReference = lookbackHigh - (atr * config.atrMultiplier);
  const reference = Number.isFinite(rawReference) && rawReference > 0 ? rawReference : Math.max(price - (atr * config.atrMultiplier), price * 0.5);
  const distancePct = ((price - reference) / price) * 100;
  const costPnlPct = Number.isFinite(cost) && cost > 0 ? ((reference - cost) / cost) * 100 : null;
  const momentumBase = metrics.closes.at(-21);
  const momentum20 = Number.isFinite(momentumBase) && momentumBase > 0 ? ((price - momentumBase) / momentumBase) * 100 : null;
  const macdMomentum = latestFinite(metrics.macdHist);

  let rawScore = 0;
  if (Number.isFinite(metrics.sma20) && price > metrics.sma20) rawScore += 2;
  if (Number.isFinite(metrics.sma20) && Number.isFinite(metrics.sma50) && metrics.sma20 > metrics.sma50) rawScore += 2;
  if (Number.isFinite(metrics.sma50) && price > metrics.sma50) rawScore += 1;
  if (distancePct > 0) rawScore += 1;
  if (Number.isFinite(momentum20) && momentum20 > 0) rawScore += 1;
  if (Number.isFinite(metrics.rsi) && metrics.rsi >= 45 && metrics.rsi <= 70) rawScore += 1;
  else if (Number.isFinite(metrics.rsi) && metrics.rsi >= 35 && metrics.rsi <= 80) rawScore += 0.5;
  if (Number.isFinite(macdMomentum) && macdMomentum > 0) rawScore += 1;
  if (Number.isFinite(metrics.sma200) ? price > metrics.sma200 : metrics.priceChannel?.direction === "up") rawScore += 1;
  const score = Math.max(0, Math.min(10, Math.round(rawScore)));

  let tone = "watch";
  let headline = "Savunma çizgisine yakın — temkinli bölge";
  if (price < reference) { tone = "danger"; headline = "Savunma çizgisi kırıldı — risk arttı"; }
  else if (score >= 8 && distancePct >= 5) { tone = "strong"; headline = "Trend güçlü — hareket alanı var"; }
  else if (score >= 6 && distancePct >= 2) { tone = "steady"; headline = "Trend korunuyor — çizgiyi izle"; }

  const volatilityPct = (atr / price) * 100;
  const volatilityLabel = volatilityPct < 1.5 ? "Sakin" : volatilityPct < 3 ? "Normal" : "Yüksek";
  const integrityLabel = score >= 8 ? "Güçlü" : score >= 6 ? "Dengeli" : score >= 4 ? "Zayıflıyor" : "Zayıf";
  const recentHigh = Math.max(...metrics.highs.slice(-Math.max(20, config.lookback)));
  const rangeLow = Math.min(reference, price) - atr;
  const rangeHigh = Math.max(recentHigh, reference, price) + atr;
  const rangeSpan = Math.max(rangeHigh - rangeLow, 0.0001);
  const marker = value => Math.max(2, Math.min(98, ((value - rangeLow) / rangeSpan) * 100));
  const lastTimestamp = Number(cleanPoints.at(-1)?.t);
  const dataDate = Number.isFinite(lastTimestamp)
    ? new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long", year: "numeric" }).format(new Date(lastTimestamp * 1000))
    : "Son işlem günü";

  const relation = distancePct >= 0 ? "üzerinde" : "altında";
  const summary = `Fiyat, Chandelier savunma çizgisinin %${formatNumber(Math.abs(distancePct), 2)} ${relation}. Trend skoru ${score}/10; ${distancePct < 0 ? "çizgi yeniden aşılana kadar risk görünümü baskın." : score >= 7 ? "ana teknik yapı halen destekleyici." : "çizgiye yaklaşırken oynaklık yakından izlenmeli."}`;

  return {
    symbol, market, currency: market === "BIST" ? "TRY" : "USD", strategy: config.label,
    price, reference, distancePct, costPnlPct, score, tone, headline, atr, volatilityPct,
    volatilityLabel, integrityLabel, momentum20, rsi: metrics.rsi, sma20: metrics.sma20,
    sma50: metrics.sma50, recentHigh, dataDate, summary,
    markers: { reference: marker(reference), price: marker(price), high: marker(recentHigh) }
  };
}

function renderTrendCheck(data = calculatePortfolio()) {
  const quickTarget = $("#trendCheckQuickSymbols");
  if (quickTarget) {
    const candidates = [
      ...(data?.holdings || []).map(item => ({ symbol: item.symbol, market: item.market, cost: item.avgCost })),
      ...(state.watchlist || []).map(item => ({ symbol: item.symbol, market: item.market, cost: null }))
    ];
    const seen = new Set();
    const quickSymbols = candidates.filter(item => item.symbol && !seen.has(item.symbol) && seen.add(item.symbol)).slice(0, 8);
    quickTarget.hidden = quickSymbols.length === 0;
    quickTarget.innerHTML = quickSymbols.length ? `<span>Hızlı seçim</span>${quickSymbols.map(item => `<button type="button" data-trend-symbol="${escapeHtml(item.symbol)}" data-trend-market="${escapeHtml(item.market || Core.normalizeMarket("", item.symbol))}" data-trend-cost="${Number.isFinite(item.cost) ? item.cost : ""}">${escapeHtml(item.symbol.replace(/\.IS$/i, ""))}</button>`).join("")}` : "";
  }

  const target = $("#trendCheckResult");
  const submit = $("#trendCheckSubmit");
  if (!target) return;
  if (submit) { submit.disabled = trendCheckView.loading; submit.textContent = trendCheckView.loading ? "Hesaplanıyor…" : "Raporu üret"; }
  if (trendCheckView.loading) {
    target.innerHTML = `<div class="trend-check-empty is-loading"><span class="trend-check-loader" aria-hidden="true"></span><strong>Fiyat geçmişi inceleniyor…</strong><p>Trend, oynaklık ve Chandelier savunma çizgisi hesaplanıyor.</p></div>`;
    return;
  }
  if (trendCheckView.error) {
    target.innerHTML = `<div class="trend-check-empty is-error"><span aria-hidden="true">!</span><strong>Rapor oluşturulamadı</strong><p>${escapeHtml(trendCheckView.error)}</p><button class="button secondary" type="button" data-trend-retry>Tekrar dene</button></div>`;
    return;
  }
  const report = trendCheckView.report;
  if (!report) return;
  const distanceDirection = report.distancePct >= 0 ? "Çizgiye kadar düşüş payı" : "Savunma çizgisinin altında";
  const costTone = report.costPnlPct === null ? "" : typeClass(report.costPnlPct);
  const metricMoney = value => formatMoney(value, report.currency, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  target.innerHTML = `
    <article class="trend-report tone-${report.tone}">
      <header class="trend-report-header">
        <div class="trend-score" style="--trend-score:${report.score * 36}deg"><strong>${report.score}</strong><span>/ 10<br>trend skoru</span></div>
        <div class="trend-report-title"><p>${escapeHtml(report.symbol)} · ${escapeHtml(report.strategy)} · ${escapeHtml(report.dataDate)}</p><h2>${escapeHtml(report.headline)}</h2><div class="trend-report-chips"><span>Trend: ${escapeHtml(report.integrityLabel)}</span><span>Oynaklık: ${escapeHtml(report.volatilityLabel)}</span><span>Referans: Chandelier</span></div></div>
      </header>

      <div class="trend-metric-grid">
        <div><span>Fiyat</span><strong>${metricMoney(report.price)}</strong><small>Son kapanış / güncel fiyat</small></div>
        <div><span>Savunma referansı</span><strong>${metricMoney(report.reference)}</strong><small>Chandelier çizgisi</small></div>
        <div><span>Uzaklık</span><strong class="${typeClass(report.distancePct)}">${signedPercent(report.distancePct)}</strong><small>${distanceDirection}</small></div>
        <div><span>Bu çizgide K/Z</span><strong class="${costTone}">${report.costPnlPct === null ? "—" : signedPercent(report.costPnlPct)}</strong><small>${report.costPnlPct === null ? "Maliyet girilmedi" : "Girdiğin maliyete göre"}</small></div>
        <div><span>ATR oynaklığı</span><strong>%${formatNumber(report.volatilityPct, 2)}</strong><small>${escapeHtml(report.volatilityLabel)} günlük hareket</small></div>
        <div><span>20 günlük momentum</span><strong class="${Number.isFinite(report.momentum20) ? typeClass(report.momentum20) : ""}">${Number.isFinite(report.momentum20) ? signedPercent(report.momentum20) : "—"}</strong><small>Kısa dönem fiyat değişimi</small></div>
      </div>

      <div class="trend-range" aria-label="Fiyat ve savunma çizgisi haritası">
        <div class="trend-range-track"><i class="reference" style="left:${report.markers.reference}%"></i><i class="current" style="left:${report.markers.price}%"></i><i class="high" style="left:${report.markers.high}%"></i></div>
        <div class="trend-range-labels"><span><b>${metricMoney(report.reference)}</b>Savunma</span><span style="left:${report.markers.price}%"><b>${metricMoney(report.price)}</b>Şu an</span><span><b>${metricMoney(report.recentHigh)}</b>Yakın zirve</span></div>
      </div>

      <div class="trend-evidence"><span><small>SMA 20</small><strong>${Number.isFinite(report.sma20) ? metricMoney(report.sma20) : "—"}</strong></span><span><small>SMA 50</small><strong>${Number.isFinite(report.sma50) ? metricMoney(report.sma50) : "—"}</strong></span><span><small>RSI 14</small><strong>${Number.isFinite(report.rsi) ? formatNumber(report.rsi, 1) : "—"}</strong></span></div>
      <p class="trend-conclusion"><span aria-hidden="true">●</span><strong>Sonuç:</strong> ${escapeHtml(report.summary)}</p>
    </article>`;
}

async function runTrendCheck() {
  const rawSymbol = $("#trendCheckSymbol")?.value || "";
  const market = $("#trendCheckMarket")?.value || "ABD";
  const strategy = $("#trendCheckStrategy")?.value || "swing";
  const rawCost = number($("#trendCheckCost")?.value);
  const cost = Number.isFinite(rawCost) && rawCost > 0 ? rawCost : null;
  const symbol = Core.normalizeSymbol(rawSymbol, market);
  if (!symbol || !Core.SYMBOL_PATTERN.test(symbol)) {
    trendCheckView.error = "Geçerli bir hisse kodu gir. Örn. NVDA veya THYAO.";
    trendCheckView.report = null;
    renderTrendCheck();
    return;
  }
  const requestId = ++trendCheckView.requestId;
  trendCheckView.loading = true;
  trendCheckView.error = "";
  trendCheckView.report = null;
  renderTrendCheck();
  try {
    const config = TREND_CHECK_STRATEGIES[strategy] || TREND_CHECK_STRATEGIES.swing;
    const points = await getTechnicalHistory(symbol, config.period);
    if (requestId !== trendCheckView.requestId) return;
    trendCheckView.report = buildTrendCheckReport(symbol, market, strategy, cost, points);
  } catch (error) {
    if (requestId !== trendCheckView.requestId) return;
    trendCheckView.error = error?.message || "Fiyat geçmişi alınamadı. Bağlantıyı kontrol edip tekrar dene.";
  } finally {
    if (requestId === trendCheckView.requestId) {
      trendCheckView.loading = false;
      renderTrendCheck();
    }
  }
}

const THESIS_STATUS_META = {
  pending: { label: "Değerlendirme bekliyor", tone: "neutral" },
  stronger: { label: "Tez güçlendi", tone: "positive" },
  same: { label: "Tez değişmedi", tone: "neutral" },
  broken: { label: "Tez bozuldu", tone: "danger" }
};

function decisionSymbolKey(symbol) {
  return String(symbol || "").trim().toUpperCase().replace(/\.IS$/, "");
}

function addCalendarDays(dateText, days) {
  const date = new Date(`${dateText || today()}T12:00:00`);
  date.setDate(date.getDate() + days);
  return Core.localDateISO(date);
}

function latestThesisReviewDate(thesis) {
  return (thesis?.reviews || []).map(review => review.date).filter(Core.isValidDate).sort().at(-1) || "";
}

function thesisReviewAlert(thesis) {
  if (!thesis) return null;
  const statusMeta = THESIS_STATUS_META[thesis.status] || THESIS_STATUS_META.pending;
  if (thesis.status === "broken") {
    return { tone: "danger", priority: 0, title: `${decisionSymbolKey(thesis.symbol)} tezi bozuldu`, detail: "Yeni işlemden önce bozulma gerekçesini yeniden değerlendir.", thesis };
  }
  const lastReview = latestThesisReviewDate(thesis);
  const earnings = (state.calendarEvents || [])
    .filter(event => event.type === "earnings" && decisionSymbolKey(event.symbol) === decisionSymbolKey(thesis.symbol) && event.date <= today())
    .sort((left, right) => right.date.localeCompare(left.date))[0];
  if (earnings && (!lastReview || earnings.date > lastReview)) {
    return { tone: "warn", priority: 1, title: `${decisionSymbolKey(thesis.symbol)} bilançosu sonrası tez incelemesi`, detail: `${formatCalendarDate(earnings.date, false)} tarihli bilanço henüz değerlendirilmedi.`, thesis };
  }
  if (thesis.reviewDate && thesis.reviewDate <= today() && (!lastReview || thesis.reviewDate > lastReview)) {
    return { tone: "warn", priority: 2, title: `${decisionSymbolKey(thesis.symbol)} inceleme tarihi geldi`, detail: "Yatırım gerekçesini güncel verilerle kontrol et.", thesis };
  }
  const daysUntilReview = thesis.reviewDate
    ? Math.round((new Date(`${thesis.reviewDate}T12:00:00`) - new Date(`${today()}T12:00:00`)) / 86400000)
    : null;
  if (Number.isFinite(daysUntilReview) && daysUntilReview >= 0 && daysUntilReview <= 7) {
    return { tone: "info", priority: 3, title: `${decisionSymbolKey(thesis.symbol)} incelemesi yaklaşıyor`, detail: daysUntilReview === 0 ? "İnceleme bugün." : `${daysUntilReview} gün sonra yeniden değerlendirilecek.`, thesis };
  }
  return { tone: statusMeta.tone, priority: 9, title: `${decisionSymbolKey(thesis.symbol)} · ${statusMeta.label}`, detail: thesis.reviewDate ? `Sonraki inceleme ${formatCalendarDate(thesis.reviewDate, false)}` : "İnceleme tarihi belirlenmedi.", thesis, passive: true };
}

function getThesisAlerts({ includePassive = false } = {}) {
  return (state.stockTheses || []).map(thesisReviewAlert)
    .filter(alert => alert && (includePassive || !alert.passive))
    .sort((left, right) => left.priority - right.priority || left.thesis.symbol.localeCompare(right.thesis.symbol));
}

function personalExpenseBaseline() {
  const expenses = Array.isArray(state.expenses) ? state.expenses : [];
  const inferred = inferredExpenseStatementMonths(expenses);
  const totals = new Map();
  expenses.filter(expense => !expense.family && expenseAmountInTry(expense) > 0).forEach(expense => {
    const month = expenseReportingMonth(expense, inferred);
    if (month) totals.set(month, (totals.get(month) || 0) + expenseAmountInTry(expense));
  });
  const entries = [...totals.entries()].sort((left, right) => left[0].localeCompare(right[0])).slice(-3);
  const values = entries.map(([, value]) => value);
  return {
    average: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0,
    latest: entries.at(-1)?.[1] || 0,
    monthCount: entries.length
  };
}

function calculateInvestmentBudget() {
  const plan = state.investmentBudget || {};
  const expense = personalExpenseBaseline();
  const monthlyIncome = Math.max(0, number(plan.monthlyIncome));
  const manualCard = Math.max(0, number(plan.expectedCardPayment));
  const expectedCardPayment = manualCard > 0 ? manualCard : expense.latest || expense.average;
  const fixedObligations = Math.max(0, number(plan.fixedObligations));
  const cashBalance = Math.max(0, number(plan.cashBalance));
  const bufferMonths = Math.min(12, Math.max(1, number(plan.bufferMonths) || 3));
  const safetyMarginPct = Math.min(50, Math.max(0, number(plan.safetyMarginPct) || 10));
  const monthlyNeed = expense.average + fixedObligations;
  const targetReserve = monthlyNeed * bufferMonths;
  const reserveGap = Math.max(0, targetReserve - cashBalance);
  const monthlyFreeCash = monthlyIncome - expectedCardPayment - fixedObligations;
  const reserveContribution = Math.min(Math.max(0, monthlyFreeCash), reserveGap > 0 ? reserveGap / 6 : 0);
  const afterReserve = Math.max(0, monthlyFreeCash - reserveContribution);
  const safetyHold = afterReserve * safetyMarginPct / 100;
  const recommended = Math.max(0, afterReserve - safetyHold);
  return {
    configured: monthlyIncome > 0,
    expenseBaseline: expense.average,
    expenseMonthCount: expense.monthCount,
    expectedCardPayment,
    cardSource: manualCard > 0 ? "manual" : expense.monthCount ? "statement" : "missing",
    fixedObligations,
    cashBalance,
    bufferMonths,
    safetyMarginPct,
    monthlyNeed,
    targetReserve,
    reserveGap,
    reserveContribution,
    safetyHold,
    recommended,
    coverageMonths: monthlyNeed > 0 ? cashBalance / monthlyNeed : null,
    monthlyFreeCash
  };
}

function setDecisionInput(selector, value) {
  const input = $(selector);
  if (input) input.value = Number(value) || 0;
}

function renderInvestmentBudget() {
  const result = calculateInvestmentBudget();
  const plan = state.investmentBudget || {};
  const form = $("#investmentBudgetForm");
  if (form && !form.contains(document.activeElement)) {
    setDecisionInput("#budgetMonthlyIncome", plan.monthlyIncome);
    setDecisionInput("#budgetCardPayment", plan.expectedCardPayment);
    setDecisionInput("#budgetFixedObligations", plan.fixedObligations);
    setDecisionInput("#budgetCashBalance", plan.cashBalance);
    setDecisionInput("#budgetBufferMonths", plan.bufferMonths || 3);
    setDecisionInput("#budgetSafetyMargin", plan.safetyMarginPct ?? 10);
  }

  $("#safeInvestmentAmount").textContent = result.configured ? formatMoney(result.recommended, "TRY", { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : "—";
  $("#safeInvestmentCaption").textContent = !result.configured
    ? "Aylık net gelirini girerek hesapla"
    : result.recommended > 0
      ? `Net gelirin yaklaşık %${formatNumber(result.recommended / result.monthlyIncome * 100, 0)}'i`
      : result.reserveGap > 0 ? "Bu ay nakit tamponu öncelikli" : "Aylık ödemeler geliri aşıyor";

  $("#cashBufferCoverage").textContent = Number.isFinite(result.coverageMonths) ? `${formatNumber(result.coverageMonths, 1)} ay` : "—";
  $("#cashBufferCaption").textContent = result.monthlyNeed > 0
    ? `Hedef ${result.bufferMonths} ay · ${formatMoney(result.targetReserve, "TRY", { maximumFractionDigits: 0 })}`
    : "Gider verisi bekleniyor";

  $("#budgetExpenseBaseline").textContent = result.expenseMonthCount ? formatMoney(result.expenseBaseline, "TRY", { maximumFractionDigits: 0 }) : "Veri yok";
  $("#budgetCardUsed").textContent = formatMoney(result.expectedCardPayment, "TRY", { maximumFractionDigits: 0 });
  $("#budgetReserveContribution").textContent = formatMoney(result.reserveContribution, "TRY", { maximumFractionDigits: 0 });
  $("#budgetSafetyHold").textContent = formatMoney(result.safetyHold, "TRY", { maximumFractionDigits: 0 });

  const estimate = $("#budgetCardEstimate");
  if (estimate) estimate.textContent = result.cardSource === "manual"
    ? "Bu ay için yazdığın tutar kullanılıyor."
    : result.cardSource === "statement"
      ? `Son ekstrendeki ${formatMoney(result.expectedCardPayment, "TRY", { maximumFractionDigits: 0 })} kişisel harcama kullanılıyor.`
      : "Ekstre yok; beklenen kart ödemesini elle gir.";

  const badge = $("#budgetStatusBadge");
  if (badge) {
    badge.className = `status-chip ${!result.configured ? "neutral" : result.recommended > 0 ? "live" : "warn"}`;
    badge.textContent = !result.configured ? "Kurulum bekliyor" : result.recommended > 0 ? "Plan hazır" : "Yatırım payı yok";
  }
  return result;
}

function saveInvestmentBudget(event) {
  event.preventDefault();
  const monthlyIncome = Math.max(0, number($("#budgetMonthlyIncome")?.value));
  if (!monthlyIncome) {
    showToast("Aylık net gelirini gir.", { undo: false });
    $("#budgetMonthlyIncome")?.focus();
    return;
  }
  state.investmentBudget = {
    monthlyIncome,
    expectedCardPayment: Math.max(0, number($("#budgetCardPayment")?.value)),
    fixedObligations: Math.max(0, number($("#budgetFixedObligations")?.value)),
    cashBalance: Math.max(0, number($("#budgetCashBalance")?.value)),
    bufferMonths: Math.min(12, Math.max(1, number($("#budgetBufferMonths")?.value) || 3)),
    safetyMarginPct: Math.min(50, Math.max(0, number($("#budgetSafetyMargin")?.value))),
    updatedAt: Date.now()
  };
  saveState();
  renderDecisionCenter(calculatePortfolio());
  renderDailyBrief(calculatePortfolio());
  showToast("Aylık yatırım bütçesi güncellendi.");
}

function resetThesisForm({ keepSymbol = "" } = {}) {
  editingThesisId = null;
  $("#stockThesisForm")?.reset();
  const defaultReviewDate = addCalendarDays(today(), 90);
  if ($("#thesisReviewDate")) $("#thesisReviewDate").value = defaultReviewDate;
  if (keepSymbol && $("#thesisSymbol")) $("#thesisSymbol").value = keepSymbol;
  if ($("#thesisEditorMode")) {
    $("#thesisEditorMode").className = "status-chip neutral";
    $("#thesisEditorMode").textContent = "Yeni tez";
  }
  if ($("#cancelThesisEdit")) $("#cancelThesisEdit").hidden = true;
}

function populateThesisForm(thesis) {
  if (!thesis) return;
  editingThesisId = thesis.id;
  $("#thesisSymbol").value = thesis.symbol;
  $("#thesisText").value = thesis.thesis;
  $("#thesisCatalysts").value = thesis.catalysts || "";
  $("#thesisInvalidation").value = thesis.invalidation || "";
  $("#thesisReviewDate").value = thesis.reviewDate || addCalendarDays(today(), 90);
  $("#thesisStatus").value = thesis.status || "pending";
  $("#thesisReviewNote").value = thesis.reviewNote || "";
  $("#thesisEditorMode").className = "status-chip live";
  $("#thesisEditorMode").textContent = `${decisionSymbolKey(thesis.symbol)} düzenleniyor`;
  $("#cancelThesisEdit").hidden = false;
  $("#stockThesisForm")?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

function saveStockThesis(event) {
  event.preventDefault();
  const symbol = String($("#thesisSymbol")?.value || "").trim().toUpperCase();
  const thesisText = String($("#thesisText")?.value || "").trim();
  const invalidation = String($("#thesisInvalidation")?.value || "").trim();
  const reviewDate = String($("#thesisReviewDate")?.value || "");
  if (!symbol || !thesisText || !invalidation || !Core.isValidDate(reviewDate)) {
    showToast("Hisse, yatırım gerekçesi, tezi bozan koşul ve inceleme tarihi gerekli.", { undo: false });
    return;
  }
  const status = THESIS_STATUS_META[$("#thesisStatus")?.value] ? $("#thesisStatus").value : "pending";
  const reviewNote = String($("#thesisReviewNote")?.value || "").trim().slice(0, 800);
  const existing = (state.stockTheses || []).find(item => item.id === editingThesisId)
    || (!editingThesisId ? (state.stockTheses || []).find(item => item.symbol === symbol) : null);
  const reviews = [...(existing?.reviews || [])];
  const existingAlert = existing ? thesisReviewAlert(existing) : null;
  const reviewDue = existingAlert && [1, 2].includes(existingAlert.priority);
  if (status !== "pending" && (!existing || existing.status !== status || existing.reviewNote !== reviewNote || reviewDue)) {
    reviews.push({ date: today(), status, note: reviewNote });
  }
  const record = {
    id: existing?.id || uid("thesis"),
    symbol,
    thesis: thesisText.slice(0, 1200),
    catalysts: String($("#thesisCatalysts")?.value || "").trim().slice(0, 800),
    invalidation: invalidation.slice(0, 800),
    reviewDate,
    status,
    reviewNote,
    reviews: reviews.slice(-20),
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now()
  };
  state.stockTheses = existing
    ? state.stockTheses.map(item => item.id === existing.id ? record : item)
    : [...(state.stockTheses || []), record];
  saveState();
  resetThesisForm();
  renderDecisionCenter(calculatePortfolio());
  renderDailyBrief(calculatePortfolio());
  showToast(existing ? "Hisse karnesi güncellendi." : "Yatırım tezi kaydedildi.");
}

function deleteStockThesis(id) {
  const thesis = (state.stockTheses || []).find(item => item.id === id);
  if (!thesis || !confirm(`${decisionSymbolKey(thesis.symbol)} yatırım tezini silmek istiyor musun?`)) return;
  state.stockTheses = state.stockTheses.filter(item => item.id !== id);
  if (editingThesisId === id) resetThesisForm();
  saveState();
  renderDecisionCenter(calculatePortfolio());
  renderDailyBrief(calculatePortfolio());
  showToast("Yatırım tezi silindi.");
}

function renderThesisBoard(data) {
  const list = $("#stockThesisList");
  if (!list) return;
  const holdings = new Map((data?.holdings || []).map(holding => [holding.symbol, holding]));
  const theses = [...(state.stockTheses || [])].sort((left, right) => {
    const leftAlert = thesisReviewAlert(left);
    const rightAlert = thesisReviewAlert(right);
    return leftAlert.priority - rightAlert.priority || right.updatedAt - left.updatedAt;
  });
  const due = getThesisAlerts();
  $("#thesisReviewCount").textContent = String(due.length);
  $("#thesisReviewCaption").textContent = theses.length
    ? due.length ? `${due.length} tez inceleme bekliyor` : `${theses.length} tez güncel`
    : "Kayıtlı tez yok";
  $("#thesisTrackedBadge").textContent = `${theses.length} takip`;
  $("#thesisDueBadge").textContent = `${due.length} inceleme`;
  $("#thesisDueBadge").className = `status-chip ${due.length ? "warn" : theses.length ? "live" : "neutral"}`;

  const select = $("#thesisSymbol");
  if (select) {
    const previous = select.value;
    const symbols = [...new Set([...(data?.holdings || []).map(item => item.symbol), ...theses.map(item => item.symbol)])];
    select.innerHTML = '<option value="">Pozisyon seç</option>' + symbols.map(symbol => {
      const holding = holdings.get(symbol);
      return `<option value="${escapeHtml(symbol)}">${escapeHtml(decisionSymbolKey(symbol))}${holding?.name && holding.name !== symbol ? ` · ${escapeHtml(holding.name)}` : ""}</option>`;
    }).join("");
    if (symbols.includes(previous)) select.value = previous;
  }

  if (!theses.length) {
    list.innerHTML = `<div class="thesis-empty"><span>◎</span><div><strong>Henüz yatırım tezi yok.</strong><p>İlk hissen için neden sahip olduğunu ve hangi koşulda fikrinin bozulacağını kaydet.</p></div></div>`;
    return;
  }

  list.innerHTML = theses.map(thesis => {
    const holding = holdings.get(thesis.symbol);
    const status = THESIS_STATUS_META[thesis.status] || THESIS_STATUS_META.pending;
    const alert = thesisReviewAlert(thesis);
    const reviews = [...(thesis.reviews || [])].slice(-3).reverse();
    return `<article class="stock-thesis-card ${status.tone} ${alert.passive ? "" : "needs-review"}">
      <header>
        <div class="thesis-symbol"><span>${escapeHtml(decisionSymbolKey(thesis.symbol).slice(0, 3))}</span><div><strong>${escapeHtml(decisionSymbolKey(thesis.symbol))}</strong><small>${escapeHtml(holding?.name || (holding ? "Açık pozisyon" : "Portföy dışında"))}</small></div></div>
        <span class="thesis-status ${alert.passive ? status.tone : alert.tone}">${escapeHtml(alert.passive ? status.label : alert.title)}</span>
      </header>
      ${!alert.passive ? `<div class="thesis-alert ${alert.tone}"><span>!</span><p>${escapeHtml(alert.detail)}</p></div>` : ""}
      <div class="thesis-copy-grid">
        <div><small>Yatırım gerekçesi</small><p>${escapeHtml(thesis.thesis)}</p></div>
        <div><small>Tezi bozan koşul</small><p>${escapeHtml(thesis.invalidation)}</p></div>
        ${thesis.catalysts ? `<div><small>Güçlendirecek gelişmeler</small><p>${escapeHtml(thesis.catalysts)}</p></div>` : ""}
      </div>
      <div class="thesis-review-strip"><span>Sonraki inceleme <strong>${formatCalendarDate(thesis.reviewDate, false)}</strong></span><span>${reviews.length ? `${reviews.length} değerlendirme kayıtlı` : "Henüz bilanço değerlendirmesi yok"}</span></div>
      ${reviews.length ? `<details class="thesis-history"><summary>Son değerlendirmeler</summary><div>${reviews.map(review => `<p><time>${formatCalendarDate(review.date, false)}</time><strong>${escapeHtml(THESIS_STATUS_META[review.status]?.label || "Değerlendirildi")}</strong><span>${escapeHtml(review.note || "Not eklenmedi.")}</span></p>`).join("")}</div></details>` : ""}
      <footer><button class="button primary small" type="button" data-thesis-edit="${escapeHtml(thesis.id)}">Değerlendir</button><button class="button secondary small" type="button" data-thesis-technical="${escapeHtml(thesis.symbol)}">Teknik görünüm</button><button class="button secondary small" type="button" data-thesis-calendar="${escapeHtml(thesis.symbol)}">Bilanço tarihi ekle</button><button class="text-button danger-text" type="button" data-thesis-delete="${escapeHtml(thesis.id)}">Sil</button></footer>
    </article>`;
  }).join("");
}

function renderDecisionCenter(data = calculatePortfolio()) {
  const budget = renderInvestmentBudget();
  renderThesisBoard(data);
  const reviewCount = getThesisAlerts().length;
  if ($("#thesisReviewCount")) $("#thesisReviewCount").textContent = String(reviewCount);
  if (!editingThesisId && $("#thesisReviewDate") && !$("#thesisReviewDate").value) $("#thesisReviewDate").value = addCalendarDays(today(), 90);
  return budget;
}

const FINANCIAL_EVENT_TYPES = {
  earnings: { label: "Bilanço", icon: "▤" },
  dividend: { label: "Temettü", icon: "₺" },
  card: { label: "Kart ödemesi", icon: "◫" },
  portfolio: { label: "Portföy notu", icon: "◆" },
  other: { label: "Diğer", icon: "•" }
};

function shiftMonthKey(monthKey, delta) {
  const [year, month] = String(monthKey || today().slice(0, 7)).split("-").map(Number);
  const date = new Date(year, month - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function daysInMonthKey(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(year, month, 0).getDate();
}

function formatCalendarDate(date, includeWeekday = true) {
  if (!Core.isValidDate(String(date || ""))) return "—";
  return new Intl.DateTimeFormat("tr-TR", {
    weekday: includeWeekday ? "short" : undefined,
    day: "numeric",
    month: "short",
    year: "numeric"
  }).format(new Date(`${date}T12:00:00`));
}

function calendarOccurrenceDate(event, monthKey) {
  if (!event?.date || !monthKey) return null;
  const originMonth = event.date.slice(0, 7);
  const [targetYear, targetMonth] = monthKey.split("-").map(Number);
  const [originYear, originMonthNumber, originDay] = event.date.split("-").map(Number);
  if (event.repeat === "none") return originMonth === monthKey ? event.date : null;
  if (monthKey < originMonth) return null;
  if (event.repeat === "yearly" && (targetMonth !== originMonthNumber || targetYear < originYear)) return null;
  const day = Math.min(originDay, daysInMonthKey(monthKey));
  return `${monthKey}-${String(day).padStart(2, "0")}`;
}

function financialEventsForMonth(monthKey) {
  const manual = (state.calendarEvents || []).map(event => {
    const date = calendarOccurrenceDate(event, monthKey);
    return date ? {
      ...event,
      date,
      originId: event.id,
      source: "manual",
      typeMeta: FINANCIAL_EVENT_TYPES[event.type] || FINANCIAL_EVENT_TYPES.other
    } : null;
  }).filter(Boolean);
  const dividends = (state.transactions || []).filter(transaction => transaction.type === "DIVIDEND" && transaction.date?.slice(0, 7) === monthKey).map(transaction => ({
    id: `ledger_${transaction.id}`,
    originId: transaction.id,
    source: "ledger",
    date: transaction.date,
    type: "dividend",
    title: transaction.name ? `${transaction.name} temettüsü` : "Temettü ödemesi",
    symbol: transaction.symbol || "",
    repeat: "none",
    typeMeta: FINANCIAL_EVENT_TYPES.dividend
  }));
  const automatic = (automaticCalendarView.events || []).filter(event => event.date?.slice(0, 7) === monthKey).map(event => ({
    ...event,
    originId: event.id,
    repeat: "none",
    typeMeta: FINANCIAL_EVENT_TYPES[event.type] || FINANCIAL_EVENT_TYPES.other
  }));
  return [...manual, ...dividends, ...automatic].sort((left, right) => left.date.localeCompare(right.date) || left.title.localeCompare(right.title, "tr"));
}

function calendarTrackedSymbols() {
  const symbols = [
    ...calculatePortfolio().holdings.filter(holding => Core.normalizeMarket(holding.market, holding.symbol) === "ABD").map(holding => holding.symbol),
    ...(state.watchlist || []).filter(item => Core.normalizeMarket(item.market, item.symbol) === "ABD").map(item => item.symbol)
  ].map(symbol => String(symbol || "").trim().toUpperCase()).filter(symbol => /^[A-Z0-9.^=_-]{1,24}$/.test(symbol));
  return [...new Set(symbols)].sort().slice(0, 30);
}

function loadAutomaticCalendarCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(AUTO_CALENDAR_CACHE_KEY) || "null");
    if (!cached || !Array.isArray(cached.events) || !Number.isFinite(Date.parse(cached.updatedAt))) return;
    automaticCalendarView.events = cached.events.filter(event => event && Core.isValidDate(String(event.date || "")) && event.type === "earnings" && !String(event.symbol || "").toUpperCase().endsWith(".IS"));
    automaticCalendarView.updatedAt = cached.updatedAt;
    automaticCalendarView.symbolKey = String(cached.symbolKey || "");
    automaticCalendarView.trackedSymbols = Number(cached.trackedSymbols) || 0;
    automaticCalendarView.coverage = cached.coverage || null;
    automaticCalendarView.warnings = Array.isArray(cached.warnings) ? cached.warnings : [];
  } catch (_) { /* Corrupt cache is ignored; live data will replace it. */ }
}

function renderAutomaticCalendarStatus() {
  const status = $("#calendarAutoStatus");
  const note = $("#calendarAutoNote");
  const refreshButton = $("[data-calendar-refresh]");
  if (!status || !note) return;
  if (refreshButton) refreshButton.disabled = automaticCalendarView.loading;
  status.className = `calendar-sync-status${automaticCalendarView.loading ? " loading" : automaticCalendarView.error ? " error" : ""}`;
  if (automaticCalendarView.loading) {
    status.textContent = "Şirket takvimi internetten güncelleniyor…";
    note.textContent = `${calendarTrackedSymbols().length} ABD hissesi kontrol ediliyor.`;
    return;
  }
  if (automaticCalendarView.error) {
    status.textContent = automaticCalendarView.error;
    note.textContent = automaticCalendarView.events.length ? "Önceki başarılı takvim ekranda tutuluyor." : "Bağlantı geldiğinde yeniden deneyebilirsin.";
    return;
  }
  if (!calendarTrackedSymbols().length) {
    status.textContent = "Otomatik takip için henüz ABD hissesi yok";
    note.textContent = "Portföye veya takip listesine ABD hissesi eklediğinde bilanço takvimi kendiliğinden oluşur.";
    return;
  }
  const updated = automaticCalendarView.updatedAt
    ? new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(automaticCalendarView.updatedAt))
    : "henüz değil";
  status.textContent = `${automaticCalendarView.events.length} yaklaşan tarih bulundu · ${automaticCalendarView.trackedSymbols || calendarTrackedSymbols().length} ABD hissesi izleniyor`;
  const warningText = String(automaticCalendarView.warnings?.[0] || "");
  const warning = warningText ? ` · ${warningText}` : "";
  const usDays = Number(automaticCalendarView.coverage?.usDays) || 45;
  note.textContent = `Son güncelleme: ${updated}. ABD bilanço tarihleri ${usDays} gün boyunca takip ediliyor${warning}`;
}

function renderCalendarNextEvents() {
  const target = $("#calendarNextEvents");
  if (!target) return;
  const events = (automaticCalendarView.events || []).filter(event => event.date >= today()).slice(0, 3);
  if (automaticCalendarView.loading && !events.length) {
    target.innerHTML = '<div class="calendar-next-empty loading">Yaklaşan şirket tarihleri aranıyor…</div>';
    return;
  }
  if (!events.length) {
    target.innerHTML = `<div class="calendar-next-empty"><strong>Bu aralıkta şirket tarihi bulunamadı.</strong><span>Takip listene yeni hisse eklediğinde burada otomatik görünecek.</span></div>`;
    return;
  }
  target.innerHTML = events.map(event => {
    const meta = FINANCIAL_EVENT_TYPES[event.type] || FINANCIAL_EVENT_TYPES.other;
    return `<button class="calendar-next-card" type="button" data-calendar-open-date="${escapeHtml(event.date)}">
      <span class="calendar-next-icon" aria-hidden="true">${meta.icon}</span>
      <span><small>${escapeHtml(formatCalendarDate(event.date, false))} · ${escapeHtml(event.certaintyLabel || "Otomatik")}</small><strong>${escapeHtml(event.title)}</strong></span>
      <i aria-hidden="true">→</i>
    </button>`;
  }).join("");
}

function focusCalendarOnFirstUpcoming(symbolKey) {
  if (calendarView.autoFocusedKey === symbolKey || calendarView.month !== today().slice(0, 7)) return;
  calendarView.autoFocusedKey = symbolKey;
  const currentMonthHasEvent = automaticCalendarView.events.some(event => event.date?.slice(0, 7) === calendarView.month);
  const firstUpcoming = automaticCalendarView.events.find(event => event.date >= today());
  if (!currentMonthHasEvent && firstUpcoming) {
    calendarView.month = firstUpcoming.date.slice(0, 7);
    calendarView.selectedDate = firstUpcoming.date;
  }
}

async function refreshAutomaticFinancialCalendar({ force = false } = {}) {
  const symbols = calendarTrackedSymbols();
  const symbolKey = symbols.join(",");
  if (!symbols.length) {
    Object.assign(automaticCalendarView, { events: [], loading: false, error: "", warnings: [], updatedAt: null, symbolKey: "", trackedSymbols: 0, coverage: null });
    renderFinancialCalendar();
    return;
  }
  const age = automaticCalendarView.updatedAt ? Date.now() - Date.parse(automaticCalendarView.updatedAt) : Infinity;
  if (!force && automaticCalendarView.symbolKey === symbolKey && age < 6 * 60 * 60 * 1000) {
    focusCalendarOnFirstUpcoming(symbolKey);
    renderFinancialCalendar();
    return;
  }
  if (automaticCalendarView.loading) return;
  automaticCalendarView.loading = true;
  automaticCalendarView.error = "";
  renderAutomaticCalendarStatus();
  try {
    const response = await fetch(`/api/financial-calendar?symbols=${encodeURIComponent(symbolKey)}&days=45`, { cache: "no-store", credentials: "same-origin" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Finansal takvim alınamadı.");
    automaticCalendarView.events = Array.isArray(payload.events) ? payload.events.filter(event => event && Core.isValidDate(String(event.date || ""))) : [];
    automaticCalendarView.warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
    automaticCalendarView.updatedAt = payload.generatedAt || new Date().toISOString();
    automaticCalendarView.symbolKey = symbolKey;
    automaticCalendarView.trackedSymbols = Number(payload.trackedSymbols) || symbols.length;
    automaticCalendarView.coverage = payload.coverage || null;
    focusCalendarOnFirstUpcoming(symbolKey);
    try {
      localStorage.setItem(AUTO_CALENDAR_CACHE_KEY, JSON.stringify({
        events: automaticCalendarView.events,
        warnings: automaticCalendarView.warnings,
        updatedAt: automaticCalendarView.updatedAt,
        symbolKey,
        trackedSymbols: automaticCalendarView.trackedSymbols,
        coverage: automaticCalendarView.coverage
      }));
    } catch (_) {}
  } catch (error) {
    automaticCalendarView.error = error instanceof Error ? error.message : "Finansal takvim alınamadı.";
  } finally {
    automaticCalendarView.loading = false;
    renderFinancialCalendar();
    renderDailyBrief(calculatePortfolio());
  }
}

function upcomingCalendarItems(dayCount = 90) {
  const start = today();
  const endDate = new Date(`${start}T12:00:00`);
  endDate.setDate(endDate.getDate() + dayCount);
  const end = Core.localDateISO(endDate);
  const monthCount = Math.ceil(dayCount / 28) + 1;
  const seen = new Set();
  return Array.from({ length: monthCount }, (_, index) => financialEventsForMonth(shiftMonthKey(start.slice(0, 7), index)))
    .flat()
    .filter(event => event.date >= start && event.date <= end)
    .filter(event => {
      const key = `${event.source}|${event.originId}|${event.date}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.date.localeCompare(right.date) || left.title.localeCompare(right.title, "tr"));
}

function renderFinancialCalendar() {
  const grid = $("#financialCalendarGrid");
  if (!grid) return;
  const monthKey = /^\d{4}-\d{2}$/.test(calendarView.month) ? calendarView.month : today().slice(0, 7);
  calendarView.month = monthKey;
  const [year, month] = monthKey.split("-").map(Number);
  $("#calendarMonthLabel").textContent = new Intl.DateTimeFormat("tr-TR", { month: "long", year: "numeric" }).format(new Date(year, month - 1, 1));
  const firstOffset = (new Date(year, month - 1, 1).getDay() + 6) % 7;
  const cellDates = Array.from({ length: 42 }, (_, index) => Core.localDateISO(new Date(year, month - 1, index - firstOffset + 1)));
  const visibleMonths = [...new Set(cellDates.map(date => date.slice(0, 7)))];
  const eventsByDate = new Map();
  visibleMonths.flatMap(financialEventsForMonth).forEach(event => {
    if (!eventsByDate.has(event.date)) eventsByDate.set(event.date, []);
    eventsByDate.get(event.date).push(event);
  });
  grid.innerHTML = cellDates.map(date => {
    const events = eventsByDate.get(date) || [];
    const outside = date.slice(0, 7) !== monthKey;
    const classes = [outside ? "outside" : "", date === today() ? "today" : "", date === calendarView.selectedDate ? "selected" : ""].filter(Boolean).join(" ");
    const eventText = events.length ? `. ${events.map(event => event.title).join(", ")}` : "";
    return `<button class="calendar-day ${classes}" type="button" role="gridcell" data-calendar-day="${date}" aria-label="${formatCalendarDate(date)}${escapeHtml(eventText)}">
      <time datetime="${date}">${Number(date.slice(-2))}</time>
      <span class="calendar-day-events">${events.slice(0, 3).map(event => `<span class="calendar-event-pill ${event.type}"><i aria-hidden="true">${event.typeMeta.icon}</i>${escapeHtml(event.title)}</span>`).join("")}${events.length > 3 ? `<small>+${events.length - 3} olay</small>` : ""}</span>
    </button>`;
  }).join("");

  const upcoming = upcomingCalendarItems(90);
  const upcomingTarget = $("#calendarUpcomingList");
  const upcomingBadge = $("#calendarUpcomingCount");
  if (upcomingBadge) upcomingBadge.textContent = `${upcoming.length} olay`;
  if (upcomingTarget) {
    upcomingTarget.innerHTML = upcoming.length ? upcoming.map(event => {
      const meta = event.typeMeta || FINANCIAL_EVENT_TYPES.other;
      const date = new Date(`${event.date}T12:00:00`);
      const sourceText = [event.certaintyLabel || (event.repeat !== "none" ? "Tekrarlıyor" : ""), event.sourceLabel].filter(Boolean).join(" · ");
      const contextText = [event.symbol ? decisionSymbolKey(event.symbol) : formatCalendarDate(event.date), event.session].filter(Boolean).join(" · ");
      return `<article class="calendar-upcoming-item ${event.type}">
        <div class="calendar-upcoming-date"><strong>${date.getDate()}</strong><span>${new Intl.DateTimeFormat("tr-TR", { month: "short" }).format(date)}</span></div>
        <div><small>${escapeHtml(meta.label)}${sourceText ? ` · ${escapeHtml(sourceText)}` : ""}</small><strong>${escapeHtml(event.title)}</strong><span>${escapeHtml(contextText)}</span>${event.detail ? `<p>${escapeHtml(event.detail)}</p>` : ""}</div>
        ${event.source === "manual" ? `<button class="icon-button" type="button" data-calendar-delete="${escapeHtml(event.originId)}" aria-label="${escapeHtml(event.title)} olayını sil">×</button>` : '<span class="calendar-auto-badge">Otomatik</span>'}
      </article>`;
    }).join("") : `<div class="calendar-empty"><span>□</span><strong>Yaklaşan olay bulunamadı.</strong><p>Portföy ve takip listesindeki şirketler otomatik kontrol edilir; kişisel tarihleri ayrıca ekleyebilirsin.</p></div>`;
  }
  renderAutomaticCalendarStatus();
  renderCalendarNextEvents();
  const dateInput = $("#calendarEventDate");
  if (dateInput && !dateInput.value) dateInput.value = calendarView.selectedDate || today();
}

function selectCalendarDay(date) {
  if (!Core.isValidDate(date)) return;
  calendarView.selectedDate = date;
  calendarView.month = date.slice(0, 7);
  const input = $("#calendarEventDate");
  if (input) input.value = date;
  renderFinancialCalendar();
}

function shiftFinancialCalendar(delta) {
  calendarView.month = shiftMonthKey(calendarView.month, delta);
  calendarView.selectedDate = `${calendarView.month}-01`;
  renderFinancialCalendar();
}

function saveCalendarEvent(event) {
  event.preventDefault();
  const title = String($("#calendarEventTitle")?.value || "").trim();
  const date = String($("#calendarEventDate")?.value || "");
  if (!title || !Core.isValidDate(date)) {
    showToast("Başlık ve geçerli bir tarih gir.", { undo: false });
    return;
  }
  state.calendarEvents.push({
    id: uid("calendar"),
    title: title.slice(0, 120),
    date,
    type: FINANCIAL_EVENT_TYPES[$("#calendarEventType")?.value] ? $("#calendarEventType").value : "other",
    symbol: String($("#calendarEventSymbol")?.value || "").trim().toUpperCase().slice(0, 24),
    repeat: ["none", "monthly", "yearly"].includes($("#calendarEventRepeat")?.value) ? $("#calendarEventRepeat").value : "none",
    createdAt: Date.now()
  });
  calendarView.month = date.slice(0, 7);
  calendarView.selectedDate = date;
  saveState();
  $("#calendarEventForm")?.reset();
  $("#calendarEventDate").value = date;
  renderFinancialCalendar();
  renderDailyBrief(calculatePortfolio());
  showToast("Finansal olay takvime eklendi.");
}

function deleteCalendarEvent(id) {
  const previous = state.calendarEvents || [];
  state.calendarEvents = previous.filter(event => event.id !== id);
  if (state.calendarEvents.length === previous.length) return;
  saveState();
  renderFinancialCalendar();
  renderDailyBrief(calculatePortfolio());
  showToast("Takvim olayı silindi.");
}

function pointsToPath(values, width, height, left, right, top, bottom, minValue, maxValue) {
  const drawableWidth = width - left - right;
  const drawableHeight = height - top - bottom;
  const span = maxValue - minValue || 1;
  let started = false;
  return values.map((value, index) => {
    if (!Number.isFinite(value)) { started = false; return ""; }
    const x = left + (index / Math.max(values.length - 1, 1)) * drawableWidth;
    const y = top + ((maxValue - value) / span) * drawableHeight;
    const command = started ? "L" : "M";
    started = true;
    return `${command}${x.toFixed(1)},${y.toFixed(1)}`;
  }).filter(Boolean).join(" ");
}

function channelAreaPath(upper, lower, width, height, left, right, top, bottom, minValue, maxValue) {
  const drawableWidth = width - left - right;
  const drawableHeight = height - top - bottom;
  const span = maxValue - minValue || 1;
  const pointFor = (value, index, length) => {
    const x = left + (index / Math.max(length - 1, 1)) * drawableWidth;
    const y = top + ((maxValue - value) / span) * drawableHeight;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  };
  const upperPoints = upper.map((value, index) => Number.isFinite(value) ? pointFor(value, index, upper.length) : null).filter(Boolean);
  const lowerPoints = lower.map((value, index) => Number.isFinite(value) ? pointFor(value, index, lower.length) : null).filter(Boolean).reverse();
  if (upperPoints.length < 2 || lowerPoints.length < 2) return "";
  return `M${upperPoints.join(" L")} L${lowerPoints.join(" L")} Z`;
}

function chartDate(timestamp, includeTime = false) {
  const options = includeTime
    ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }
    : { day: "numeric", month: "short", year: "numeric" };
  return new Intl.DateTimeFormat("tr-TR", options).format(new Date(timestamp * 1000));
}

function renderTechnicalPriceChart(metrics, points, currency) {
  const svg = $("#technicalChart");
  const width = 720, height = 300, left = 52, right = 14, top = 18, bottom = 25;
  const shown = [metrics.closes];
  if (technicalView.indicators.sma20) shown.push(metrics.sma20Array);
  if (technicalView.indicators.sma50) shown.push(metrics.sma50Array);
  if (technicalView.indicators.sma200) shown.push(metrics.sma200Array);
  if (technicalView.indicators.channel && metrics.priceChannel.code !== "insufficient") shown.push(metrics.priceChannel.lower, metrics.priceChannel.upper);
  const values = shown.flat().filter(Number.isFinite);
  if (!values.length) { svg.innerHTML = `<text class="chart-label" x="50%" y="50%" text-anchor="middle">Grafik verisi bulunamadı.</text>`; return; }
  const rawMin = Math.min(...values), rawMax = Math.max(...values);
  const padding = Math.max((rawMax - rawMin) * .08, rawMax * .01, .01);
  const minValue = rawMin - padding, maxValue = rawMax + padding;
  const yFor = value => top + ((maxValue - value) / (maxValue - minValue || 1)) * (height - top - bottom);
  const grid = [0, .25, .5, .75, 1].map(ratio => {
    const value = maxValue - ratio * (maxValue - minValue);
    const y = yFor(value);
    return `<line class="chart-grid" x1="${left}" x2="${width - right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text class="chart-label" x="${left - 5}" y="${(y + 3).toFixed(1)}" text-anchor="end">${escapeHtml(formatMoney(value, currency, { maximumFractionDigits: 2 }))}</text>`;
  }).join("");
  const includeTime = technicalView.period === "1d" || technicalView.period === "1w";
  const channelArea = technicalView.indicators.channel
    ? channelAreaPath(metrics.priceChannel.upper, metrics.priceChannel.lower, width, height, left, right, top, bottom, minValue, maxValue)
    : "";
  const channelPaths = technicalView.indicators.channel && metrics.priceChannel.code !== "insufficient" ? [
    channelArea ? `<path class="technical-channel-area" d="${channelArea}"/>` : "",
    `<path class="technical-channel-boundary" d="${pointsToPath(metrics.priceChannel.upper, width, height, left, right, top, bottom, minValue, maxValue)}"/>`,
    `<path class="technical-channel-middle" d="${pointsToPath(metrics.priceChannel.middle, width, height, left, right, top, bottom, minValue, maxValue)}"/>`,
    `<path class="technical-channel-boundary" d="${pointsToPath(metrics.priceChannel.lower, width, height, left, right, top, bottom, minValue, maxValue)}"/>`
  ].join("") : "";
  const paths = [
    channelPaths,
    `<path class="technical-price-line" d="${pointsToPath(metrics.closes, width, height, left, right, top, bottom, minValue, maxValue)}"/>`,
    technicalView.indicators.sma20 ? `<path class="technical-sma20-line" d="${pointsToPath(metrics.sma20Array, width, height, left, right, top, bottom, minValue, maxValue)}"/>` : "",
    technicalView.indicators.sma50 ? `<path class="technical-sma50-line" d="${pointsToPath(metrics.sma50Array, width, height, left, right, top, bottom, minValue, maxValue)}"/>` : "",
    technicalView.indicators.sma200 ? `<path class="technical-sma200-line" d="${pointsToPath(metrics.sma200Array, width, height, left, right, top, bottom, minValue, maxValue)}"/>` : ""
  ].join("");
  svg.innerHTML = `${grid}${paths}<text class="chart-label" x="${left}" y="${height - 5}">${chartDate(points[0].t, includeTime)}</text><text class="chart-label" x="${width - right}" y="${height - 5}" text-anchor="end">${chartDate(points.at(-1).t, includeTime)}</text><line id="priceCrosshair" class="chart-crosshair" x1="0" x2="0" y1="${top}" y2="${height - bottom}" display="none"/><circle id="priceDot" class="chart-dot" r="4" display="none"/><rect class="interactive-overlay" x="${left}" y="${top}" width="${width - left - right}" height="${height - top - bottom}" fill="none" pointer-events="all" onmousemove="handleChartHover(event, ${left}, ${width - left - right})" onmouseleave="hideCrosshair()"/>`;
}

function renderRsiChart(metrics) {
  const svg = $("#rsiChart");
  const width = 400, height = 160, left = 28, right = 8, top = 11, bottom = 19;
  const yFor = value => top + ((100 - value) / 100) * (height - top - bottom);
  const guides = [70, 50, 30].map(value => `<line class="${value === 50 ? "rsi-midline" : "rsi-guide"}" x1="${left}" x2="${width - right}" y1="${yFor(value)}" y2="${yFor(value)}"/><text class="chart-label" x="${left - 4}" y="${yFor(value) + 3}" text-anchor="end">${value}</text>`).join("");
  const path = pointsToPath(metrics.rsiArray, width, height, left, right, top, bottom, 0, 100);
  svg.innerHTML = `${guides}${path ? `<path class="rsi-line" d="${path}"/>` : `<text class="chart-label" x="50%" y="50%" text-anchor="middle">RSI için yeterli veri yok.</text>`}<line id="rsiCrosshair" class="chart-crosshair" x1="0" x2="0" y1="${top}" y2="${height - bottom}" display="none"/><circle id="rsiDot" class="chart-dot" r="4" display="none"/><rect class="interactive-overlay" x="${left}" y="${top}" width="${width - left - right}" height="${height - top - bottom}" fill="none" pointer-events="all" onmousemove="handleChartHover(event, ${left}, ${width - left - right})" onmouseleave="hideCrosshair()"/>`;
  const rsi = metrics.rsi;
  const rsiClass = rsi === null ? "" : rsi >= 70 ? "negative" : rsi <= 30 ? "positive" : "";
  $("#rsiValue").textContent = rsi === null ? "—" : formatNumber(rsi, 1);
  $("#rsiValue").className = `technical-value ${rsiClass}`;
}

function renderMacdChart(metrics) {
  const container = $("#macdCardContainer");
  const svg = $("#macdChart");
  container.style.display = "block";
  const width = 400, height = 160, left = 28, right = 8, top = 11, bottom = 19;
  if (!metrics.macdLine || !metrics.macdLine.some(Number.isFinite)) {
    svg.innerHTML = `<text class="chart-label" x="50%" y="50%" text-anchor="middle">MACD için yeterli veri yok.</text>`;
    $("#macdValue").textContent = "—";
    return;
  }
  const allValues = [...metrics.macdLine, ...metrics.macdSignal].filter(Number.isFinite);
  const maxAbs = Math.max(...allValues.map(Math.abs));
  const padding = maxAbs * 0.1 || 0.1;
  const maxValue = maxAbs + padding, minValue = -maxValue;
  const yFor = value => top + ((maxValue - value) / (maxValue - minValue)) * (height - top - bottom);
  const zeroY = yFor(0);
  const guides = `<line class="rsi-midline" x1="${left}" x2="${width - right}" y1="${zeroY}" y2="${zeroY}"/><text class="chart-label" x="${left - 4}" y="${zeroY + 3}" text-anchor="end">0</text>`;
  const drawableWidth = width - left - right;
  const histPaths = metrics.macdHist.map((val, index) => {
    if (!Number.isFinite(val)) return "";
    const x = left + (index / Math.max(metrics.macdHist.length - 1, 1)) * drawableWidth;
    const y = yFor(val);
    const h = Math.abs(y - zeroY);
    const classN = val >= 0 ? "macd-hist-up" : "macd-hist-down";
    return `<rect class="${classN}" x="${(x - 1).toFixed(1)}" y="${Math.min(y, zeroY).toFixed(1)}" width="2.5" height="${Math.max(h, 1).toFixed(1)}"/>`;
  }).join("");
  const linePath = pointsToPath(metrics.macdLine, width, height, left, right, top, bottom, minValue, maxValue);
  const signalPath = pointsToPath(metrics.macdSignal, width, height, left, right, top, bottom, minValue, maxValue);
  svg.innerHTML = `${guides}${histPaths}<path class="macd-line" d="${linePath}"/><path class="macd-signal" d="${signalPath}"/><line id="macdCrosshair" class="chart-crosshair" x1="0" x2="0" y1="${top}" y2="${height - bottom}" display="none"/><circle id="macdDot" class="chart-dot" r="4" display="none"/><rect class="interactive-overlay" x="${left}" y="${top}" width="${width - left - right}" height="${height - top - bottom}" fill="none" pointer-events="all" onmousemove="handleChartHover(event, ${left}, ${width - left - right})" onmouseleave="hideCrosshair()"/>`;
  const latestMacd = latestFinite(metrics.macdLine);
  $("#macdValue").textContent = latestMacd !== null ? formatNumber(latestMacd, 2) : "—";
  $("#macdValue").className = `technical-value ${latestMacd >= 0 ? "positive" : "negative"}`;
}

function technicalSummary(metrics, currency = "USD") {
  const l = metrics.closes.length - 1;
  if (l < 0) return "Veri yok";
  
  const c = metrics.closes[l];
  const sma20 = metrics.sma20Array[l];
  const sma50 = metrics.sma50Array[l];
  const sma200 = metrics.sma200Array[l];
  const rsi = metrics.rsiArray[l];
  const macd = metrics.macdLine[l];
  const signal = metrics.macdSignal[l];
  const hist = metrics.macdHist[l];

  let html = `<ul style="list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap:12px; font-size:13px; line-height:1.5;">`;

  // SMA Analizi
  let smaText = "";
  let supports = [];
  let resistances = [];
  if (sma20) (c > sma20 ? supports : resistances).push({ name: "SMA 20 (Kısa Vade)", val: sma20 });
  if (sma50) (c > sma50 ? supports : resistances).push({ name: "SMA 50 (Orta Vade)", val: sma50 });
  if (sma200) (c > sma200 ? supports : resistances).push({ name: "SMA 200 (Ana Trend)", val: sma200 });
  
  supports.sort((a,b) => b.val - a.val);
  resistances.sort((a,b) => a.val - b.val);

  if (sma20 && sma200) {
    if (c > sma20 && c > sma200) smaText = `Fiyat hem kısa vade (SMA 20) hem de uzun vade (SMA 200) ortalamalarının üzerinde. <strong>Güçlü bir Boğa (Yükseliş) trendi</strong> hakim.`;
    else if (c < sma20 && c < sma200) smaText = `Fiyat hem kısa hem uzun vade ortalamalarının altında. <strong>Ayı (Düşüş) trendi</strong> baskın.`;
    else smaText = `Fiyat hareketli ortalamalar arasında dalgalanıyor. Trend yönü kararsız.`;
  } else {
    smaText = `Trend yönünü belirlemek için hareketli ortalamalar izleniyor.`;
  }

  // RSI Analizi
  let rsiText = "";
  if (rsi !== null) {
    if (rsi >= 70) rsiText = `RSI ${rsi.toFixed(1)} seviyesinde. Fiyat <strong>Aşırı Alım (70+)</strong> bölgesinde. Alıcılar yorulmuş olabilir ve olası bir düzeltme yaşanabilir. <em>(Not: Güçlü boğa trendlerinde RSI uzun süre bu bölgede kalabilir, anında satış sinyali değildir.)</em>`;
    else if (rsi <= 30) rsiText = `RSI ${rsi.toFixed(1)} seviyesinde. Fiyat <strong>Aşırı Satım (30-)</strong> bölgesinde. Varlığın çok düştüğü ve tepki alımının (yükseliş) gelebileceği düşünülür.`;
    else rsiText = `RSI ${rsi.toFixed(1)} ile nötr bölgede. Fiyatın aşırı şiştiği veya satıldığı bir durum gözlenmiyor.`;
  }

  // MACD Analizi
  let macdText = "";
  let score = 0; // Puanlama: Yükseliş (+) / Düşüş (-)
  if (macd !== null && signal !== null) {
    const prevMacd = metrics.macdLine[l - 1] || macd;
    const prevSignal = metrics.macdSignal[l - 1] || signal;
    let cross = "";
    if (prevMacd <= prevSignal && macd > signal) { cross = `MACD çizgisi Sinyal çizgisini yukarı kesti <strong>(AL Sinyali)</strong>.`; score += 2; }
    else if (prevMacd >= prevSignal && macd < signal) { cross = `MACD çizgisi Sinyal çizgisini aşağı kesti <strong>(SAT Sinyali)</strong>.`; score -= 2; }
    else if (macd > signal) { cross = `MACD Sinyalin üzerinde (Pozitif eğilim).`; score += 1; }
    else { cross = `MACD Sinyalin altında (Negatif eğilim).`; score -= 1; }
    
    let histText = hist > 0 ? `Histogram sıfırın üzerinde, yükseliş ivmesi güçlü.` : `Histogram sıfırın altında, düşüş ivmesi güçlü.`;
    macdText = `${cross} ${histText}`;
  }

  // Genel Puanlama
  if (c > (sma200 || 0)) score += 1; else score -= 1;
  if (c > (sma20 || 0)) score += 1; else score -= 1;
  if (rsi >= 70) score -= 1;
  if (rsi <= 30) score += 1;

  let conclusion = "";
  if (score >= 2) conclusion = `<strong style="color:#55d694">Yükseliş Beklentisi:</strong> Teknik göstergeler genel olarak pozitif. Trendin yukarı yönlü devam etmesi muhtemel.`;
  else if (score <= -2) conclusion = `<strong style="color:#e66773">Düşüş Beklentisi:</strong> Teknik göstergeler zayıf. Satış baskısı veya düzeltme devam edebilir.`;
  else conclusion = `<strong style="color:#f2c45c">Nötr / Kararsız:</strong> Göstergeler karışık sinyaller veriyor. Yatay seyir izlenebilir.`;

  let supResText = "";
  if (supports.length > 0) supResText += `<br><strong>Destek Noktaları:</strong> ${supports.map(s => `${s.name}: ${s.val.toFixed(2)}`).join(", ")}`;
  if (resistances.length > 0) supResText += `<br><strong>Direnç Noktaları:</strong> ${resistances.map(s => `${s.name}: ${s.val.toFixed(2)}`).join(", ")}`;

  const channel = metrics.priceChannel;
  if (channel.code !== "insufficient") {
    const channelRange = Number.isFinite(channel.latestLower) && Number.isFinite(channel.latestUpper)
      ? `${formatMoney(channel.latestLower, currency, { maximumFractionDigits: 2 })} — ${formatMoney(channel.latestUpper, currency, { maximumFractionDigits: 2 })}`
      : "—";
    html += `<li><strong>Fiyat yapısı:</strong> <span class="${channel.tone}">${escapeHtml(channel.trendLabel)}</span>. ${escapeHtml(channel.channelLabel)}. Son ${channel.sampleSize} veri noktasındaki regresyon uyumu %${formatNumber(channel.fit * 100, 0)}; güncel kanal bandı ${channelRange}.</li>`;
  } else {
    html += `<li><strong>Fiyat yapısı:</strong> Trend ve kanal sınıflandırması için en az 20 fiyat noktası gerekli.</li>`;
  }
  html += `<li><strong>Trend (SMA):</strong> ${smaText}</li>`;
  if (rsiText) html += `<li><strong>Aşırı Alım/Satım (RSI):</strong> ${rsiText}</li>`;
  if (macdText) html += `<li><strong>İvme (MACD):</strong> ${macdText}</li>`;
  html += `<li style="margin-top:4px; padding-top:12px; border-top:1px solid rgba(255,255,255,0.05);"><strong>Nihai Yorum:</strong> ${conclusion} ${supResText}</li>`;
  html += `</ul>`;
  
  return html;
}


// ────────────────────────────────────────────────────────────────────────────
// STOP-LOSS & SEVİYE HESAPLAMA MOTORu
// ────────────────────────────────────────────────────────────────────────────

function calcATR(highs, lows, closes, period) {
  // Gerçek ATR: TR = max(H-L, |H-Cprev|, |L-Cprev|)
  const trs = closes.map((c, i) => {
    if (i === 0) return highs[i] - lows[i];
    const prev = closes[i - 1];
    return Math.max(highs[i] - lows[i], Math.abs(highs[i] - prev), Math.abs(lows[i] - prev));
  });
  // Wilder ATR (EMA benzeri)
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

function calcBollingerBands(closes, period, stdDev) {
  const sma = simpleMovingAverage(closes, period);
  const upper = [], lower = [];
  for (let i = 0; i < closes.length; i++) {
    if (!Number.isFinite(sma[i])) { upper.push(null); lower.push(null); continue; }
    const slice = closes.slice(Math.max(0, i - period + 1), i + 1);
    const mean = sma[i];
    const sd = Math.sqrt(slice.reduce((acc, v) => acc + (v - mean) ** 2, 0) / slice.length);
    upper.push(mean + stdDev * sd);
    lower.push(mean - stdDev * sd);
  }
  return { upper, lower, mid: sma };
}

function findSwingLow(closes, lookback) {
  // Son `lookback` günde lokal minimum bul (pivot: her iki yanından yüksek)
  const slice = closes.slice(Math.max(0, closes.length - lookback));
  let minVal = Math.min(...slice);
  // Daha anlamlı swing: 3 günlük lokal diplerden en yüksek olanı (son destek)
  const pivots = [];
  for (let i = 1; i < slice.length - 1; i++) {
    if (slice[i] < slice[i - 1] && slice[i] < slice[i + 1]) pivots.push(slice[i]);
  }
  return pivots.length ? Math.max(...pivots) : minVal;
}

function calculateLevels(metrics, avgCost) {
  const { closes, sma20Array, sma50Array, sma200Array } = metrics;
  const highs  = metrics.highs  || closes;   // OHLC yoksa close ile yaklaşım
  const lows   = metrics.lows   || closes;
  const price  = Number(closes.at(-1));
  const n      = closes.length;

  if (!Number.isFinite(price) || price <= 0 || !n) return null;

  // ─── ATR (Wilder, 14 günlük) ───────────────────────────────────────────
  const rawAtr14 = calcATR(highs, lows, closes, 14);
  const atr14 = Number.isFinite(rawAtr14) && rawAtr14 > 0 ? rawAtr14 : price * 0.02;

  // ─── Bollinger Bantları (20, 2σ) ───────────────────────────────────────
  const bb = calcBollingerBands(closes, 20, 2);
  const bbLower = bb.lower.at(-1);
  const bbUpper = bb.upper.at(-1);

  // ─── Swing Low (son 30 gün pivot) ─────────────────────────────────────
  const swingLow30  = findSwingLow(lows,   30);
  const swingLow40  = findSwingLow(lows,   40);

  // ─── Direnç & Destek için yüksek/düşükler ─────────────────────────────
  const lookback60 = Math.min(60, n);
  const slice60    = closes.slice(n - lookback60);
  const swingHigh60 = Math.max(...slice60);
  const swingLow60  = Math.min(...(lows.slice(n - lookback60)));

  const yearSlice  = closes.slice(Math.max(0, n - 252));
  const high52w    = Math.max(...yearSlice);
  const low52w     = Math.min(...(lows.slice(Math.max(0, n - 252))));

  const sma20  = sma20Array.at(-1);
  const sma50  = sma50Array.at(-1);
  const sma200 = sma200Array.at(-1);

  // ─── 3 Stop-Loss Yöntemi ───────────────────────────────────────────────
  // MUHAFAZAKÂRı: ATR × 1.5  (sıkı, kısa vadeli) — her zaman price altında
  const stopFloor = Math.max(price * 0.01, 0.0001);
  const stopCeiling = price * 0.999;
  const validStop = value => Math.min(stopCeiling, Math.max(stopFloor, Number.isFinite(value) ? value : price * 0.95));
  const stopConservative  = validStop(price - 1.5 * atr14);
  // DENGELİ: 2.5×ATR ile pivot swing low arasından fiyata YAKIN olanı seç
  // (ikisi de price altındaysa hangisi daha yakınsa onu al — daha az kayıp)
  const atrBased25 = price - 2.5 * atr14;
  const swingStop  = swingLow30 < price ? swingLow30 * 0.99 : atrBased25;
  const stopBalanced = validStop(Math.max(atrBased25, swingStop));
  // AGRESİF: SMA50 altı %1 veya 40 günlük swing low — trendi takip, price altında olmalı
  const sma50stop     = (sma50 && sma50 < price) ? sma50 * 0.99 : null;
  const swingStop40   = swingLow40 < price ? swingLow40 * 0.985 : null;
  const stopAggressive = validStop(
    sma50stop && swingStop40 ? Math.max(sma50stop, swingStop40)
      : sma50stop ?? swingStop40 ?? price - 3 * atr14
  );

  // Pct helper
  const pct = (stop) => ((price - stop) / price * 100);

  // ─── Volatilite değerlendirmesi ────────────────────────────────────────
  const atrPct = (atr14 / price * 100);
  let volatilityLabel, volatilityNote;
  if (atrPct > 4) {
    volatilityLabel = "Çok Yüksek";
    volatilityNote  = `Bu hisse günlük ortalama %${atrPct.toFixed(1)} hareket ediyor — ATR bandı geniş tutuldu.`;
  } else if (atrPct > 2.5) {
    volatilityLabel = "Yüksek";
    volatilityNote  = `Günlük volatilite %${atrPct.toFixed(1)} ile ortalamanın üzerinde. Stop mesafenizi buna göre ayarlayın.`;
  } else if (atrPct > 1.2) {
    volatilityLabel = "Orta";
    volatilityNote  = `Volatilite (%${atrPct.toFixed(1)}/gün) makul seviyede.`;
  } else {
    volatilityLabel = "Düşük";
    volatilityNote  = `Düşük volatiliteli (%${atrPct.toFixed(1)}/gün) hisse; sıkı stop kullanılabilir.`;
  }

  // ─── Direnç & Destek seviyeleri ───────────────────────────────────────
  const resistanceLevels = [
    { label: "Son Dönem Yüksek (60g)", val: swingHigh60 },
    { label: "52 Hafta Yükseği",       val: high52w },
    { label: "Bollinger Üst Bant",     val: bbUpper },
    ...(sma20  && sma20  > price ? [{ label: "SMA 20",  val: sma20  }] : []),
    ...(sma50  && sma50  > price ? [{ label: "SMA 50",  val: sma50  }] : []),
    ...(sma200 && sma200 > price ? [{ label: "SMA 200", val: sma200 }] : []),
  ].filter(r => r.val && r.val > price * 1.001).sort((a, b) => a.val - b.val).slice(0, 4);

  const supportLevels = [
    { label: "Pivot Destek (30g)",     val: swingLow30 },
    { label: "Swing Düşük (60g)",      val: swingLow60 },
    { label: "52 Hafta Düşüğü",       val: low52w },
    { label: "Bollinger Alt Bant",     val: bbLower },
    ...(sma20  && sma20  < price ? [{ label: "SMA 20",  val: sma20  }] : []),
    ...(sma50  && sma50  < price ? [{ label: "SMA 50",  val: sma50  }] : []),
    ...(sma200 && sma200 < price ? [{ label: "SMA 200", val: sma200 }] : []),
  ].filter(s => s.val && s.val < price * 0.999).sort((a, b) => b.val - a.val).slice(0, 4);

  // ─── Maliyet bazlı risk ────────────────────────────────────────────────
  const costRisk = avgCost ? {
    conservative:  (stopConservative - avgCost)  / avgCost * 100,
    balanced:      (stopBalanced     - avgCost)  / avgCost * 100,
    aggressive:    (stopAggressive   - avgCost)  / avgCost * 100,
  } : null;

  return {
    price, atr14, atrPct, volatilityLabel, volatilityNote,
    bbLower, bbUpper,
    swingLow30, swingLow40, swingLow60, swingHigh60,
    sma50, sma200,
    stops: {
      conservative:  { 
        val: stopConservative,  
        pct: pct(stopConservative),  
        label: "Muhafazakâr (1.5×ATR)",  
        desc: "Volatilite bazlı sıkı stop. Kısa vadeli işlemler için uygundur.",
        nextStep: "Sıkı risk yönetimi için aracı kurum uygulamanızda bu seviyeye koşullu stop-loss emri girebilirsiniz."
      },
      balanced:      { 
        val: stopBalanced,      
        pct: pct(stopBalanced),      
        label: "Dengeli (2.5×ATR + Pivot)", 
        desc: "ATR oynaklığı ile son pivot desteğini harmanlar. Genel portföy takibi için idealdir.",
        nextStep: "Genel portföy koruması için aracı kurumunuzda bu fiyatı ana zarar kes noktası olarak kaydedebilirsiniz."
      },
      aggressive:    { 
        val: stopAggressive,    
        pct: pct(stopAggressive),    
        label: "Agresif (SMA50 bazlı)",   
        desc: "Trendi takip etmek için daha geniş alan tanır. Uzun vadeli pozisyonlara uygundur.",
        nextStep: "Trend takibi yapıyorsanız fiyatın bu seviyenin altında günlük kapanış yapıp yapmadığını takip edebilirsiniz."
      },
    },
    costRisk, resistanceLevels, supportLevels,
  };
}

function renderInfoTooltip(term, text) {
  return `<button type="button" class="info-icon" aria-label="${escapeHtml(term)} açıklaması" aria-haspopup="dialog">i<span class="info-tooltip"><strong>${escapeHtml(term)}</strong>${escapeHtml(text)}</span></button>`;
}

function renderLevels(metrics, currency) {
  const el = document.getElementById("levelsContent");
  if (!el) return;
  const holding  = calculatePortfolio().holdings.find(h => h.symbol === technicalView.symbol);
  const avgCost  = holding ? holding.avgCost : null;
  const levels   = calculateLevels(metrics, avgCost);
  if (!levels) {
    el.innerHTML = `<div class="level-empty">Geçerli ve pozitif fiyat verisi olmadan zarar kes veya hedef seviyesi hesaplanamaz.</div>`;
    return;
  }
  const fmt      = v  => formatMoney(v, currency, { maximumFractionDigits: 2 });
  const fmtPct   = v  => (v >= 0 ? "+" : "") + Math.abs(v).toFixed(1) + "%";

  // ─── Sonuç odaklı stop-loss kartları ─────────────────────────────────
  const stopLabels = {
    conservative: { title: "Sıkı Koruma", emoji: "●", actionText: "altına düşerse pozisyonu gözden geçirin" },
    balanced:     { title: "Önerilen Zarar Kes", emoji: "●", actionText: "altına kapanış yaparsa zarar kesin" },
    aggressive:   { title: "Geniş Takip", emoji: "●", actionText: "altında kalırsa trendi kaybetmiş olabilir" },
  };

  const stopCards = Object.entries(levels.stops).map(([key, s]) => {
    const meta = stopLabels[key];
    const border = key === "balanced" ? " sl-card-recommended" : "";
    const badge  = key === "balanced" ? `<span class="sl-badge">Önerilen</span>` : "";
    const costRiskVal = levels.costRisk ? levels.costRisk[key] : null;

    let costLine = "";
    if (costRiskVal !== null) {
      const isGain = costRiskVal >= 0;
      costLine = `<div class="sl-sub-line cost-line" style="color:${isGain ? "#10b981" : "#ef4444"}">
        ${isGain ? "▲" : "◆"} Maliyetinize göre: <strong>${fmtPct(costRiskVal)} ${isGain ? "kâr koruması" : "zarar"}</strong>
      </div>`;
    }

    return `
      <div class="sl-card${border}" data-sl-key="${key}">
        ${badge}
        <div class="sl-card-label">${meta.emoji} ${meta.title} ${renderInfoTooltip(escapeHtml(s.label), escapeHtml(s.desc))}</div>
        <div class="sl-card-val">${fmt(s.val)}</div>
        <div class="sl-card-action">Fiyat <strong>${fmt(s.val)}</strong> ${meta.actionText}</div>
        <div class="sl-card-sub-lines">
          <div class="sl-sub-line price-line">↓ Güncel fiyattan <strong>%${s.pct.toFixed(1)} aşağıda</strong></div>
          ${costLine}
        </div>
      </div>`;
  }).join("");

  // ─── Sonuç odaklı direnç/destek satırları ────────────────────────────
  const resistanceRows = levels.resistanceLevels.length
    ? levels.resistanceLevels.map((r, i) => {
        const p = ((r.val - levels.price) / levels.price * 100);
        const obs = i === 0
          ? `Geçmişte fiyat bu bölgede satıcıyla karşılaştı. Hacimli ve kalıcı geçilirse yukarı yönlü güçlenme olabilir.`
          : `Daha üstte ikinci bir engel bölgesi.`;
        return `<div class="level-row-v2">
          <div class="level-row-main">
            <span class="level-dot" style="background:#ef4444"></span>
            <span class="level-value-v2">${fmt(r.val)}</span>
            <span class="level-pct level-up">+${p.toFixed(1)}%</span>
            <span class="level-tag">${escapeHtml(r.label)} ${renderInfoTooltip(escapeHtml(r.label), "Geçmiş fiyat hareketlerinden hesaplanan direnç noktası.")}</span>
          </div>
          <div class="level-action-hint level-hint-obs">${obs}</div>
        </div>`;
      }).join("")
    : `<div class="level-empty">Yakın direnç seviyesi bulunamadı</div>`;

  const supportRows = levels.supportLevels.length
    ? levels.supportLevels.map((s, i) => {
        const p = ((s.val - levels.price) / levels.price * 100);
        const obs = i === 0
          ? `Geçmişte fiyat bu bölgeden alıcıyla karşılaştı. Zarar kes için yukarıdaki stop-loss kartlarını kullanın.`
          : `Daha altta ikinci bir tutunma bölgesi.`;
        return `<div class="level-row-v2">
          <div class="level-row-main">
            <span class="level-dot" style="background:#10b981"></span>
            <span class="level-value-v2">${fmt(s.val)}</span>
            <span class="level-pct level-down">${p.toFixed(1)}%</span>
            <span class="level-tag">${escapeHtml(s.label)} ${renderInfoTooltip(escapeHtml(s.label), "Geçmiş fiyat hareketlerinden hesaplanan destek noktası.")}</span>
          </div>
          <div class="level-action-hint level-hint-obs">${obs}</div>
        </div>`;
      }).join("")
    : `<div class="level-empty">Yakın destek seviyesi bulunamadı</div>`;

  // ─── Volatilite bilgisi (sade) ───────────────────────────────────────
  const volEmoji = levels.atrPct > 4 ? "Yüksek" : levels.atrPct > 2.5 ? "Orta" : "Düşük";
  const volText  = levels.atrPct > 4
    ? "Bu hisse çok hareketli — stop mesafesi geniş tutuldu."
    : levels.atrPct > 2.5
      ? "Orta-yüksek hareketlilik — seviyeler biraz geniş aralıklı."
      : "Sakin bir hisse — seviyeler birbirine yakın.";

  el.innerHTML = `
    <div class="sl-volatility-v2">${volEmoji} ${escapeHtml(volText)} ${renderInfoTooltip("Oynaklık (ATR)", "Son 14 günde fiyatın ortalama günlük dalgalanması: " + fmt(levels.atr14))}</div>

    <div class="sl-section-title">Zarar Kes (Stop-Loss) Seviyeleri</div>
    <div class="sl-section-note">Aşağıdaki seviyelerden birini aracı kurumunuzda zarar kes emri olarak girebilirsiniz. Destek seviyeleri bu değildir; onlar sadece referans noktalarıdır.</div>
    <div class="sl-cards">${stopCards}</div>

    <div class="levels-section" style="margin-top:14px">
      <div class="levels-section-title resistance-title">↑ Tarihsel Direnç Bölgeleri (Referans)</div>
      ${resistanceRows}
    </div>
    <div class="levels-current-price">
      <span>Şu Anki Fiyat</span>
      <span class="level-price-val">${fmt(levels.price)}</span>
    </div>
    <div class="levels-section">
      <div class="levels-section-title support-title">↓ Tarihsel Destek Bölgeleri (Referans)</div>
      ${supportRows}
    </div>

    <p class="levels-disclaimer">Bu hesaplamalar geçmiş fiyat verisine dayanır ve yatırım tavsiyesi değildir, sadece teknik referans noktalarıdır.</p>`;

  // Overlays managed in renderChartOverlayLines
}


// ═══════════════════════════════════════════════════════════════════════════════
// DESTEK / DİRENÇ & KIRILIM ANALİZİ MODÜLü
// ═══════════════════════════════════════════════════════════════════════════════

// Swing high ve low noktalarını bul
// Boundary guard: döngü [lookback, n-lookback) aralığında
function findSwingPoints(highs, lows, lookback) {
  lookback = lookback || 5;
  const n = highs.length;
  const MIN_POINTS = 2 * lookback + 1;
  if (n < MIN_POINTS) return { swingHighs: [], swingLows: [], insufficient: true };

  const swingHighs = [], swingLows = [];
  for (let i = lookback; i < n - lookback; i++) {
    const windowH = highs.slice(i - lookback, i + lookback + 1);
    const windowL = lows.slice(i - lookback, i + lookback + 1);
    if (highs[i] === Math.max(...windowH)) swingHighs.push({ i, val: highs[i] });
    if (lows[i]  === Math.min(...windowL)) swingLows.push({  i, val: lows[i]  });
  }
  return { swingHighs, swingLows, insufficient: false };
}

// Centroid bazlı clustering — drift riski yok
// Tolerans her zaman kümenin güncel centroid'ine göre hesaplanır
function clusterLevels(rawPoints, closes, tolerance) {
  tolerance = tolerance || 0.015;
  if (!rawPoints.length) return [];

  // Fiyata göre sırala
  const sorted = [...rawPoints].sort((a, b) => a.val - b.val);
  const clusters = [];

  for (const pt of sorted) {
    // Centroid'e en yakın uygun kümeyi bul
    let bestCluster = null, bestDist = Infinity;
    for (const c of clusters) {
      const dist = Math.abs(pt.val - c.centroid) / c.centroid;
      if (dist <= tolerance && dist < bestDist) {
        bestCluster = c; bestDist = dist;
      }
    }
    if (bestCluster) {
      // Centroid'i güncelle (kayan ortalama)
      bestCluster.points.push(pt);
      bestCluster.centroid = bestCluster.points.reduce((s, p) => s + p.val, 0) / bestCluster.points.length;
      bestCluster.testCount++;
    } else {
      clusters.push({ centroid: pt.val, points: [pt], testCount: 1, type: pt.type });
    }
  }

  // Her küme için testCount'u fiyatın test sayısıyla zenginleştir
  // (gerçek kapanış fiyatı küme bölgesine kaç kez girdi?)
  return clusters.map(c => {
    const lo = c.centroid * (1 - tolerance);
    const hi = c.centroid * (1 + tolerance);
    const touchCount = closes.filter(cl => cl >= lo && cl <= hi).length;
    const strength = touchCount >= 7 ? 'güçlü' : touchCount >= 4 ? 'orta' : 'zayıf';
    return {
      price: c.centroid,
      testCount: Math.max(c.testCount, touchCount),
      touchCount,
      strength,
      type: c.type, // 'resistance' | 'support'
    };
  });
}

// Confidence formülü: f(volumeRatio, testCount)
// volumeRatio: güncel hacim / 20 günlük ortalama hacim
// testCount: seviyenin test edilme sayısı
function calcConfidence(volumeRatio, testCount, hasVolume) {
  if (!hasVolume) return 'düşük'; // Hacim verisi yoksa otomatik düşük
  const volScore   = volumeRatio >= 2.0 ? 3 : volumeRatio >= 1.3 ? 2 : 1;
  const levelScore = testCount  >= 7    ? 3 : testCount  >= 4    ? 2 : 1;
  const total = volScore + levelScore;
  return total >= 5 ? 'yüksek' : total >= 3 ? 'orta' : 'düşük';
}

// Ana analiz fonksiyonu
function analyzeBreakouts(metrics, points) {
  const { closes, highs, lows, volumes } = metrics;
  const n = closes.length;
  const LOOKBACK = 5;
  const VOL_WINDOW = 20;
  const MIN_POINTS = Math.max(2 * LOOKBACK + 1, VOL_WINDOW + 1);

  // Minimum veri guard
  if (n < MIN_POINTS) return { insufficient: true, reason: `En az ${MIN_POINTS} günlük veri gerekli.` };

  // Swing noktaları
  const { swingHighs, swingLows, insufficient } = findSwingPoints(highs, lows, LOOKBACK);
  if (insufficient) return { insufficient: true, reason: 'Yeterli veri yok.' };

  // Hacim ortalaması (son 20 gün)
  const volSlice = volumes.slice(n - VOL_WINDOW);
  const hasVolume = volSlice.some(v => v > 0);
  const avgVolume = hasVolume ? volSlice.reduce((a, b) => a + b, 0) / VOL_WINDOW : 0;
  const lastVolume = volumes.at(-1) || 0;
  const volumeRatio = avgVolume > 0 ? lastVolume / avgVolume : 0;

  // Cluster oluştur
  const resistanceCandidates = swingHighs.map(p => ({ ...p, type: 'resistance' }));
  const supportCandidates    = swingLows.map(p  => ({ ...p, type: 'support'    }));
  const allClusters = [
    ...clusterLevels(resistanceCandidates, closes, 0.015),
    ...clusterLevels(supportCandidates, closes, 0.015),
  ];

  const price = closes.at(-1);

  // Seviyeye göre sırala ve ayır
  const resistances = allClusters
    .filter(c => c.price > price * 1.002)
    .sort((a, b) => a.price - b.price);   // en yakın önce
  const supports = allClusters
    .filter(c => c.price < price * 0.998)
    .sort((a, b) => b.price - a.price);   // en yakın önce

  const nearestResistance = resistances[0] || null;
  const nearestSupport    = supports[0]    || null;

  // ─── Sinyal tespiti — öncelik sırası: whipsaw > breakout > breakdown > bounce ───
  const TOLERANCE = 0.005; // %0.5 eşiği
  let event = null;

  // Yardımcı: son N günde hangi seviyelerin kırıldığına bak
  const WHIPSAW_WINDOW = 3;
  const recentCloses = closes.slice(n - WHIPSAW_WINDOW - 1);

  // 1. WHIPSAW: Son 3 gün içinde bir kırılım oluştu ama fiyat geri döndü mü?
  for (const level of [...resistances.slice(0, 3), ...supports.slice(0, 3)]) {
    const isRes = level.type === 'resistance';
    let brokeThrough = false, cameBack = false;
    for (let k = 0; k < recentCloses.length - 1; k++) {
      if (isRes && recentCloses[k] > level.price * (1 + TOLERANCE)) brokeThrough = true;
      if (!isRes && recentCloses[k] < level.price * (1 - TOLERANCE)) brokeThrough = true;
    }
    if (brokeThrough) {
      if (isRes && price < level.price) cameBack = true;
      if (!isRes && price > level.price) cameBack = true;
    }
    if (brokeThrough && cameBack) {
      event = {
        type: 'whipsaw',
        level,
        price,
        confidence: 'düşük',
        volumeRatio,
        hasVolume,
        title: 'Yalancı Kırılım (Whipsaw)',
        icon: '!',
        color: '#f59e0b',
        text: `${level.type === 'resistance' ? 'Direnç' : 'Destek'} seviyesi (${level.price.toFixed(2)}) son ${WHIPSAW_WINDOW} günde test edildi; fiyat kısa süre aşıp geri döndü. Yalancı kırılım riski yüksek.`,
      };
      break;
    }
  }

  // 2. BREAKOUT (direnç kırılımı)
  if (!event && nearestResistance) {
    const broke = price > nearestResistance.price * (1 + TOLERANCE);
    if (broke) {
      const volConfirmed = hasVolume && volumeRatio >= 1.3;
      const confidence = calcConfidence(volumeRatio, nearestResistance.testCount, hasVolume);
      event = {
        type: 'breakout',
        level: nearestResistance,
        price,
        confidence,
        volumeRatio,
        hasVolume,
        title: 'Direnç Kırılımı (Breakout)',
        icon: '↑',
        color: '#10b981',
        text: `Fiyat, ${nearestResistance.strength} direnç seviyesini (${nearestResistance.price.toFixed(2)}) yukarı kırdı.${volConfirmed ? ' Hacim teyidi var.' : ' Ancak hacim teyidi zayıf — yalancı kırılım olabilir.'}`,
      };
    }
  }

  // 3. BREAKDOWN (destek kırılımı)
  if (!event && nearestSupport) {
    const broke = price < nearestSupport.price * (1 - TOLERANCE);
    if (broke) {
      const volConfirmed = hasVolume && volumeRatio >= 1.3;
      const confidence = calcConfidence(volumeRatio, nearestSupport.testCount, hasVolume);
      event = {
        type: 'breakdown',
        level: nearestSupport,
        price,
        confidence,
        volumeRatio,
        hasVolume,
        title: 'Destek Kırılımı (Breakdown)',
        icon: '↓',
        color: '#ef4444',
        text: `Fiyat, ${nearestSupport.strength} destek seviyesini (${nearestSupport.price.toFixed(2)}) aşağı kırdı.${volConfirmed ? ' Hacim teyidi mevcut — potansiyel zarar kesme bölgesi.' : ' Hacim teyidi zayıf, izlenmeye devam edilmeli.'}`,
      };
    }
  }

  // 4. BOUNCE (destekte tutunma)
  if (!event && nearestSupport) {
    const nearPct = Math.abs(price - nearestSupport.price) / price;
    if (nearPct <= 0.025) { // Desteğe %2.5 yakın
      const last3 = closes.slice(n - 3);
      const recovering = last3.at(-1) > last3[0];
      if (recovering) {
        event = {
          type: 'bounce',
          level: nearestSupport,
          price,
          confidence: calcConfidence(volumeRatio, nearestSupport.testCount, hasVolume),
          volumeRatio,
          hasVolume,
          title: 'Destek Testi ve Tutunma',
          icon: '↩️',
          color: '#59b0ec',
          text: `Fiyat, ${nearestSupport.strength} destek bölgesine (${nearestSupport.price.toFixed(2)}) yaklaşıp geri sıçradı. Destek seviyesi şimdilik tutunuyor.`,
        };
      }
    }
  }

  return {
    insufficient: false,
    price,
    nearestResistance,
    nearestSupport,
    resistances: resistances.slice(0, 4),
    supports: supports.slice(0, 4),
    event,
    hasVolume,
    avgVolume,
    volumeRatio,
    // Grafikte çizilecek: en yakın 2 destek + 2 direnç
    chartLevels: [...resistances.slice(0, 2), ...supports.slice(0, 2)],
  };
}



// Kırılım analiz kartını render et
function renderBreakoutCard(analysis, currency) {
  const el = document.getElementById('breakoutContent');
  if (!el) return;
  const fmt = v => formatMoney(v, currency, { maximumFractionDigits: 2 });
  const fmtPct = v => (v >= 0 ? '+' : '') + v.toFixed(1) + '%';

  if (analysis.insufficient) {
    el.innerHTML = `<p class="bo-empty">${escapeHtml(analysis.reason || 'Yeterli veri yok.')}</p>`;
    return;
  }

  // Özet durum satırı
  const resStr = analysis.nearestResistance ? fmt(analysis.nearestResistance.price) : '—';
  const supStr = analysis.nearestSupport    ? fmt(analysis.nearestSupport.price)    : '—';
  const resPct = analysis.nearestResistance
    ? fmtPct((analysis.nearestResistance.price - analysis.price) / analysis.price * 100) : '';
  const supPct = analysis.nearestSupport
    ? fmtPct((analysis.nearestSupport.price - analysis.price) / analysis.price * 100) : '';

  // ─── Sonuç odaklı olay kutusu ────────────────────────────────────────
  let eventHtml = '';
  if (analysis.event) {
    const e = analysis.event;
    let plainText = "";
    let actionText = "";
    if (e.type === 'breakout') {
      plainText = `Fiyat ${fmt(e.level.price)} direncini yukarı geçti.`;
      actionText = analysis.hasVolume && analysis.volumeRatio >= 1.3
        ? `İşlem hacmi güçlü — kırılım güvenilir görünüyor. Yeni alım değerlendirilebilir.`
        : `Ancak işlem hacmi zayıf — sahte kırılım olabilir, teyit için 1-2 gün beklenmesi faydalı.`;
    } else if (e.type === 'breakdown') {
      plainText = `Fiyat ${fmt(e.level.price)} desteğinin altına düştü.`;
      actionText = `Düşüş devam edebilir. Elinizdeyse zarar kes seviyenizi kontrol edin.`;
    } else if (e.type === 'whipsaw') {
      const isRes = e.level && e.level.type === 'resistance';
      plainText = isRes
        ? `Fiyat ${fmt(e.level.price)} direncini geçer gibi oldu ama geri döndü.`
        : `Fiyat ${fmt(e.level.price)} desteğini kırar gibi oldu ama tutundu.`;
      actionText = `Bu bir sahte kırılım olabilir — acele etmeden fiyatın netleşmesini bekleyin.`;
    } else if (e.type === 'bounce') {
      plainText = `Fiyat ${fmt(e.level.price)} desteğine değip yukarı sıçradı.`;
      actionText = `Destek tutuyor. Stop-loss emrinizi bu seviyenin hemen altına koyabilirsiniz.`;
    }
    const confLabel = e.confidence === 'yüksek' ? 'Güvenilir sinyal' : e.confidence === 'orta' ? 'Orta güvenilirlik' : 'Zayıf sinyal';
    eventHtml = `
      <div class="bo-event" style="border-left-color:${e.color}">
        <div class="bo-event-header">
          <span class="bo-event-icon">${e.icon}</span>
          <span class="bo-event-title" style="color:${e.color}">${escapeHtml(plainText)}</span>
        </div>
        <p class="bo-event-action">${escapeHtml(actionText)}</p>
        <div class="bo-event-meta"><span class="bo-confidence">${confLabel}</span></div>
      </div>`;
  } else {
    const supHint = analysis.nearestSupport ? fmt(analysis.nearestSupport.price) : '—';
    const resHint = analysis.nearestResistance ? fmt(analysis.nearestResistance.price) : '—';
    eventHtml = `<div class="bo-event bo-neutral">
      <span class="bo-event-icon">▦</span>
      <div>
        <div class="bo-event-title">Fiyat ${supHint} ile ${resHint} arasında yatay hareket ediyor.</div>
        <p class="bo-event-action">Net bir kırılım yok. Fiyat bu iki seviyeden birine yaklaştığında alarm kurabilirsiniz.</p>
      </div>
    </div>`;
  }

  // ─── Seviye tablosu (yalnızca gözlemsel) ─────────────────────────────
  const levelRows = (lvls, isRes) => lvls.slice(0, 2).map((lvl, i) => {
    const pct = (lvl.price - analysis.price) / analysis.price * 100;
    const color = isRes ? '#ef4444' : '#10b981';
    const sw = Math.min(3, 0.8 + (lvl.testCount - 1) * 0.3).toFixed(1);
    let hint = "";
    if (isRes && i === 0) hint = `Geçmişte satıcıların yoğunlaştığı bölge — hacimli geçilirse önemli`;
    else if (!isRes && i === 0) hint = `Geçmişte alıcıların yoğunlaştığı bölge — zarar kes için stop-loss kartına bakın`;
    else if (isRes) hint = `Daha üstte ikinci engel bölgesi`;
    else hint = `Daha altta ikinci tutunma bölgesi`;
    return `<div class="bo-level-row">
      <span class="bo-level-strength-bar" style="width:${sw * 5}px; background:${color}; opacity:0.7"></span>
      <span class="bo-level-price" style="color:${color}">${fmt(lvl.price)}</span>
      <span class="bo-level-pct">${fmtPct(pct)}</span>
      <span class="bo-level-hint">${escapeHtml(hint)} ${renderInfoTooltip("Güç: " + lvl.testCount + "× test", "Bu seviye " + lvl.testCount + " kez test edildi. " + escapeHtml(lvl.strength) + " seviye.")}</span>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div class="bo-status-bar">
      <span class="bo-status-item">
        <span class="bo-dot" style="background:#ef4444"></span>
        Üst Engel <strong>${resStr}</strong>${resPct ? ` (${resPct})` : ''}
      </span>
      <span class="bo-status-sep">·</span>
      <span class="bo-status-item bo-price-item">Şu An <strong>${fmt(analysis.price)}</strong></span>
      <span class="bo-status-sep">·</span>
      <span class="bo-status-item">
        <span class="bo-dot" style="background:#10b981"></span>
        Alt Destek <strong>${supStr}</strong>${supPct ? ` (${supPct})` : ''}
      </span>
    </div>

    ${eventHtml}

    <div class="bo-levels-grid">
      <div class="bo-levels-col">
        <div class="bo-levels-title" style="color:#ef4444">Yukarıdaki Engeller</div>
        ${levelRows(analysis.resistances, true) || '<span class="bo-empty-small">Yakın direnç yok</span>'}
      </div>
      <div class="bo-levels-col">
        <div class="bo-levels-title" style="color:#10b981">Aşağıdaki Destekler</div>
        ${levelRows(analysis.supports, false) || '<span class="bo-empty-small">Yakın destek yok</span>'}
      </div>
    </div>

    <p class="bo-disclaimer">Bu analiz geçmiş fiyat hareketlerine dayalı teknik bir yorumdur, kesin sinyal değildir. Yalancı kırılımlar sık görülür; yatırım kararı vermeden önce başka faktörleri de değerlendirin.</p>`;
}

function describeTechnicalAlert(alert) {
  if (alert.type === "RSI_BELOW") return `RSI ${alert.threshold} seviyesinin altına inerse`;
  if (alert.type === "RSI_ABOVE") return `RSI ${alert.threshold} seviyesinin üstüne çıkarsa`;
  if (alert.type === "SMA20_CROSS_UP") return "SMA20, SMA50'yi yukarı keserse";
  return "SMA20, SMA50'yi aşağı keserse";
}

function technicalAlertTriggered(alert, metrics) {
  if (alert.type === "RSI_BELOW") return metrics.rsi !== null && metrics.rsi <= Number(alert.threshold);
  if (alert.type === "RSI_ABOVE") return metrics.rsi !== null && metrics.rsi >= Number(alert.threshold);
  if (alert.type === "SMA20_CROSS_UP") return metrics.cross === "up";
  return metrics.cross === "down";
}

function evaluateTechnicalAlerts(symbol, metrics, notify = false) {
  let changed = false;
  const newlyTriggered = [];
  state.technicalAlerts.filter(alert => alert.symbol === symbol).forEach(alert => {
    const active = technicalAlertTriggered(alert, metrics);
    if (alert.active !== active) {
      alert.active = active;
      changed = true;
      if (active) newlyTriggered.push(alert);
    }
  });
  if (changed) saveState();
  if (notify && newlyTriggered.length) showToast(`${symbol}: ${describeTechnicalAlert(newlyTriggered[0])}`);
  return state.technicalAlerts.filter(alert => alert.symbol === symbol);
}

function renderTechnicalAlerts(metrics) {
  const target = $("#technicalAlertList");
  const alerts = state.technicalAlerts.filter(alert => alert.symbol === technicalView.symbol);
  if (!alerts.length) { target.innerHTML = `<p class="security-name">Bu hisse için alarm yok.</p>`; return; }
  target.innerHTML = alerts.map(alert => `<div class="technical-alert-item ${alert.active ? "active" : ""}"><span>${escapeHtml(describeTechnicalAlert(alert))}${alert.active ? " · Şu an tetiklendi" : ""}</span><button class="button small danger" type="button" data-delete-technical-alert="${escapeHtml(alert.id)}">Sil</button></div>`).join("");
}

function renderTrendChannelCard(metrics, currency) {
  const target = $("#trendChannelContent");
  if (!target) return;
  const channel = metrics?.priceChannel;
  if (!channel || channel.code === "insufficient") {
    target.innerHTML = `<p class="levels-loading">Trend ve kanal tespiti için en az 20 fiyat noktası gerekli.</p>`;
    return;
  }
  const positionLabels = { inside: "Kanal içinde", above: "Kanal üstünde", below: "Kanal altında" };
  const range = Number.isFinite(channel.latestLower) && Number.isFinite(channel.latestUpper)
    ? `${formatMoney(channel.latestLower, currency, { maximumFractionDigits: 2 })} — ${formatMoney(channel.latestUpper, currency, { maximumFractionDigits: 2 })}`
    : "—";
  target.innerHTML = `
    <div class="trend-channel-heading">
      <div><p class="eyebrow">FİYAT YAPISI</p><h3 class="trend-channel-title ${channel.tone}">${escapeHtml(channel.trendLabel)}</h3></div>
      <span class="trend-channel-badge ${channel.tone}">${escapeHtml(channel.channelLabel)}</span>
    </div>
    <div class="trend-channel-grid">
      <div><span>Seçili dönemde eğim</span><strong class="${channel.tone}">${signedPercent(channel.movePct)}</strong></div>
      <div><span>Güncel kanal bandı</span><strong>${range}</strong></div>
      <div><span>Fiyatın konumu</span><strong>${escapeHtml(positionLabels[channel.position] || "Belirsiz")}</strong></div>
      <div><span>Kanal uyumu</span><strong>${escapeHtml(channel.fitLabel)} · %${formatNumber(channel.fit * 100, 0)}</strong></div>
    </div>
    <p class="trend-channel-note">Son ${channel.sampleSize} fiyat noktası logaritmik doğrusal eğim ve ±2 standart sapma bandıyla incelenir. Zayıf uyumda kanal iddiası üretilmez.</p>`;
}

function renderTechnicalAnalysis() {
  const title = $("#technicalTitle");
  const subtitle = $("#technicalSubtitle");
  const chart = $("#technicalChart");
  if (!technicalView.symbol) return;
  const holding = calculatePortfolio().holdings.find(item => item.symbol === technicalView.symbol);
  title.textContent = holding ? `${holding.symbol} · ${holding.name}` : technicalView.symbol;
  ["sma20", "sma50", "sma200", "channel"].forEach(key => { $(`#toggle${key[0].toUpperCase()}${key.slice(1)}`).checked = technicalView.indicators[key]; });
  $$("#technicalPeriodGroup button").forEach(button => button.classList.toggle("active", button.dataset.technicalPeriod === technicalView.period));
  if (technicalView.loading) {
    subtitle.textContent = "Geçmiş fiyat verisi yükleniyor...";
    chart.innerHTML = `<text class="chart-label" x="50%" y="50%" text-anchor="middle">Grafik hazırlanıyor...</text>`;
    $("#rsiChart").innerHTML = ""; $("#technicalSummary").innerHTML = "<p>Göstergeler hesaplanıyor...</p>"; $("#technicalOverviewContent").innerHTML = `<p class="levels-loading">Özet hesaplanıyor...</p>`; $("#trendChannelContent").innerHTML = `<p class="levels-loading">Trend ve kanal hesaplanıyor...</p>`; $("#rsiValue").textContent = "—";
    renderAiAnalysis(); return;
  }
  if (technicalView.error || !technicalView.points.length) {
    subtitle.textContent = technicalView.error || "Geçmiş fiyat verisi bulunamadı.";
    chart.innerHTML = `<text class="chart-label" x="50%" y="50%" text-anchor="middle">Veri alınamadı</text>`;
    $("#rsiChart").innerHTML = "";
    $("#technicalSummary").innerHTML = `<div class="service-error-state"><strong>Fiyat verisi yüklenemedi</strong><p>${escapeHtml(technicalView.error || serviceMessage("price"))}</p><div><button class="button primary small" type="button" data-retry-service="technical">Yeniden dene</button><button class="button secondary small" type="button" data-check-connection>Bağlantı durumunu kontrol et</button></div></div>`;
    $("#technicalOverviewContent").innerHTML = `<p class="levels-loading">Genel özet için fiyat verisi gerekli.</p>`; $("#trendChannelContent").innerHTML = `<p class="levels-loading">Trend ve kanal için fiyat verisi gerekli.</p>`;
    renderAiAnalysis(); return;
  }
  const metrics = getTechnicalMetrics(technicalView.points);
  technicalView.latestMetrics = metrics;
  const currency = getSymbolCurrency(technicalView.symbol);
  
  const periodMap = { "1d": "1 günlük", "1w": "1 haftalık", "1mo": "1 aylık", "3mo": "3 aylık", "6mo": "6 aylık", "ytd": "Yılbaşından bugüne", "1y": "1 yıllık" };
  const pText = periodMap[technicalView.period] || technicalView.period;
  subtitle.textContent = technicalView.staleWarning || `${pText} fiyat verisi · ${technicalView.points.length} veri noktası`;
  
  if ($("#technicalLatestPrice")) $("#technicalLatestPrice").textContent = formatMoney(metrics.price, currency, { maximumFractionDigits: 2 });
  renderTechnicalPriceChart(metrics, technicalView.points, currency);
  renderTrendChannelCard(metrics, currency);
  renderRsiChart(metrics);
  renderMacdChart(metrics);
  renderLevels(metrics, currency);
  const breakoutAnalysis = analyzeBreakouts(metrics, technicalView.points);
  technicalView.breakoutAnalysis = breakoutAnalysis;
  renderBreakoutCard(breakoutAnalysis, currency);
  renderChartOverlayLines(metrics, currency);
  renderTechnicalOverviewCard(metrics, currency);
  $("#technicalSummary").innerHTML = technicalSummary(metrics, currency);
  evaluateTechnicalAlerts(technicalView.symbol, metrics);
  renderTechnicalAlerts(metrics);
  renderAiAnalysis();
}

function handleChartHover(event, leftOffset, drawWidth) {
  if (!technicalView.points || !technicalView.points.length || !technicalView.latestMetrics) return;
  const rect = event.target.getBoundingClientRect();
  
  const ratio = (event.clientX - rect.left) / rect.width;
  if (ratio < 0 || ratio > 1) { hideCrosshair(); return; }
  
  const index = Math.round(ratio * (technicalView.points.length - 1));
  const safeIndex = Math.max(0, Math.min(technicalView.points.length - 1, index));
  
  const point = technicalView.points[safeIndex];
  const metrics = technicalView.latestMetrics;
  
  const includeTime = technicalView.period === "1d" || technicalView.period === "1w";
  const dateStr = chartDate(point.t, includeTime);
  const currency = getSymbolCurrency(technicalView.symbol);
  
  const ratioX = safeIndex / Math.max(technicalView.points.length - 1, 1);
  const priceSnapX = 52 + ratioX * 654; // Price: left=52, drawWidth=720-52-14=654
  const rsiSnapX = 28 + ratioX * 364;   // RSI: left=28, drawWidth=400-28-8=364
  const macdSnapX = 28 + ratioX * 364;  // MACD: left=28, drawWidth=400-28-8=364

  const pCross = document.getElementById("priceCrosshair");
  if (pCross) { pCross.setAttribute("x1", priceSnapX.toFixed(1)); pCross.setAttribute("x2", priceSnapX.toFixed(1)); pCross.style.display = "block"; }
  
  const rCross = document.getElementById("rsiCrosshair");
  if (rCross) { rCross.setAttribute("x1", rsiSnapX.toFixed(1)); rCross.setAttribute("x2", rsiSnapX.toFixed(1)); rCross.style.display = "block"; }

  const mCross = document.getElementById("macdCrosshair");
  if (mCross) { mCross.setAttribute("x1", macdSnapX.toFixed(1)); mCross.setAttribute("x2", macdSnapX.toFixed(1)); mCross.style.display = "block"; }

  const getPriceY = (val) => {
    const shown = [metrics.closes];
    if (technicalView.indicators.sma20) shown.push(metrics.sma20Array);
    if (technicalView.indicators.sma50) shown.push(metrics.sma50Array);
    if (technicalView.indicators.sma200) shown.push(metrics.sma200Array);
    const v = shown.flat().filter(Number.isFinite);
    const rMin = Math.min(...v), rMax = Math.max(...v);
    const p = Math.max((rMax - rMin) * .08, rMax * .01, .01);
    const minV = rMin - p, maxV = rMax + p;
    return 18 + ((maxV - val) / (maxV - minV || 1)) * (300 - 18 - 25);
  };

  const pDot = document.getElementById("priceDot");
  if (pDot) { pDot.setAttribute("cx", priceSnapX.toFixed(1)); pDot.setAttribute("cy", getPriceY(metrics.closes[safeIndex]).toFixed(1)); pDot.style.display = "block"; }

  const priceTooltip = document.getElementById("priceTooltip");
  if (priceTooltip) {
    const c = metrics.closes[safeIndex];
    let html = `<span>${dateStr}</span> <strong>Kapanış: ${formatMoney(c, currency, { maximumFractionDigits: 2 })}</strong>`;
    if (technicalView.indicators.sma20 && Number.isFinite(metrics.sma20Array[safeIndex])) html += ` <span><strong style="color:#55d694">SMA20:</strong> ${formatMoney(metrics.sma20Array[safeIndex], currency, { maximumFractionDigits: 2 })}</span>`;
    if (technicalView.indicators.sma50 && Number.isFinite(metrics.sma50Array[safeIndex])) html += ` <span><strong style="color:#f2c45c">SMA50:</strong> ${formatMoney(metrics.sma50Array[safeIndex], currency, { maximumFractionDigits: 2 })}</span>`;
    if (technicalView.indicators.sma200 && Number.isFinite(metrics.sma200Array[safeIndex])) html += ` <span><strong style="color:#59b0ec">SMA200:</strong> ${formatMoney(metrics.sma200Array[safeIndex], currency, { maximumFractionDigits: 2 })}</span>`;
    priceTooltip.innerHTML = html;
    priceTooltip.style.opacity = "1";
  }

  const rDot = document.getElementById("rsiDot");
  const rsiTooltip = document.getElementById("rsiTooltip");
  if (metrics.rsiArray[safeIndex] !== null) { 
    if (rDot) { rDot.setAttribute("cx", rsiSnapX.toFixed(1)); rDot.setAttribute("cy", (11 + ((100 - metrics.rsiArray[safeIndex]) / 100) * (160 - 11 - 19)).toFixed(1)); rDot.style.display = "block"; }
    if (rsiTooltip) {
      rsiTooltip.innerHTML = `<span>${dateStr}</span> <strong>RSI: ${formatNumber(metrics.rsiArray[safeIndex], 1)}</strong>`;
      rsiTooltip.style.opacity = "1";
    }
  } else {
    if (rDot) rDot.style.display = "none";
    if (rsiTooltip) rsiTooltip.style.opacity = "0";
  }

  const mDot = document.getElementById("macdDot");
  const macdTooltip = document.getElementById("macdTooltip");
  if (metrics.macdLine[safeIndex] !== null) {
    if (mDot) {
      const all = [...metrics.macdLine, ...metrics.macdSignal].filter(Number.isFinite);
      const mx = Math.max(...all.map(Math.abs));
      const maxV = mx + (mx * 0.1 || 0.1), minV = -maxV;
      mDot.setAttribute("cx", macdSnapX.toFixed(1)); mDot.setAttribute("cy", (11 + ((maxV - metrics.macdLine[safeIndex]) / (maxV - minV)) * (160 - 11 - 19)).toFixed(1)); mDot.style.display = "block";
    }
    if (macdTooltip) {
      macdTooltip.innerHTML = `<span>${dateStr}</span> <span><strong>MACD:</strong> ${formatNumber(metrics.macdLine[safeIndex], 2)}</span> <span><strong style="color:#f0bd60">Sinyal:</strong> ${formatNumber(metrics.macdSignal[safeIndex], 2)}</span> <span><strong>Hist:</strong> ${formatNumber(metrics.macdHist[safeIndex], 2)}</span>`;
      macdTooltip.style.opacity = "1";
    }
  } else {
    if (mDot) mDot.style.display = "none";
    if (macdTooltip) macdTooltip.style.opacity = "0";
  }
}

function hideCrosshair() {
  ["priceCrosshair", "rsiCrosshair", "macdCrosshair"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
  ["priceDot", "rsiDot", "macdDot"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
  ["priceTooltip", "rsiTooltip", "macdTooltip"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.opacity = "0";
  });
}

async function getTechnicalHistory(symbol, period) {
  const key = `${symbol}|${period}`;
  const alignWithLatestQuote = sourcePoints => {
    const points = sourcePoints.map(point => ({ ...point }));
    const quote = state.prices?.[symbol];
    const quotePrice = Number(quote?.price);
    const quoteTimestamp = Math.floor(Number(quote?.updatedAt) / 1000);
    const last = points.at(-1);
    if (!last || !Number.isFinite(quotePrice) || quotePrice <= 0 || !Number.isFinite(quoteTimestamp) || quoteTimestamp <= 0) return points;
    const lastDay = new Date(last.t * 1000).toISOString().slice(0, 10);
    const quoteDay = new Date(quoteTimestamp * 1000).toISOString().slice(0, 10);
    if (quoteDay < lastDay) return points;
    if (quoteDay === lastDay) {
      last.c = quotePrice;
      last.h = Math.max(last.h, quotePrice);
      last.l = Math.min(last.l, quotePrice);
    } else {
      points.push({ t: quoteTimestamp, o: quotePrice, h: quotePrice, l: quotePrice, c: quotePrice, v: 0 });
    }
    return points;
  };
  if (technicalHistoryCache.has(key)) return alignWithLatestQuote(technicalHistoryCache.get(key));
  const response = await fetch(`/api/history?symbol=${encodeURIComponent(symbol)}&period=${period}`, { cache: "no-store" });
  const payload = await readJsonResponse(response, "price");
  if (!response.ok) throw serviceError("price");
  const byTimestamp = new Map();
  (Array.isArray(payload.points) ? payload.points : []).forEach(point => {
    const t = Number(point?.t);
    const c = Number(point?.c);
    if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(c) || c <= 0) return;
    const rawOpen = Number(point?.o);
    const rawHigh = Number(point?.h);
    const rawLow = Number(point?.l);
    const o = Number.isFinite(rawOpen) && rawOpen > 0 ? rawOpen : c;
    const candidates = [o, c];
    if (Number.isFinite(rawHigh) && rawHigh > 0) candidates.push(rawHigh);
    if (Number.isFinite(rawLow) && rawLow > 0) candidates.push(rawLow);
    byTimestamp.set(t, {
      t,
      o,
      h: Math.max(...candidates),
      l: Math.min(...candidates),
      c,
      v: Number.isFinite(Number(point?.v)) ? Math.max(0, Number(point.v)) : 0,
    });
  });
  const points = [...byTimestamp.values()].sort((a, b) => a.t - b.t);
  if (!points.length) throw new Error("Geçerli ve pozitif geçmiş fiyat verisi bulunamadı.");
  technicalHistoryCache.set(key, points);
  return alignWithLatestQuote(points);
}

function detailText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function setDetailMetric(id, value, tone = "") {
  const element = document.getElementById(id);
  if (!element) return;
  element.textContent = value;
  element.classList.remove("positive", "negative");
  if (tone) element.classList.add(tone);
}

function formatCompactUsd(value) {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDetailDate(value) {
  if (!value) return "tarih yok";
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function finiteDetailNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeFundamentalRatio(numerator, denominator, multiplier = 1) {
  const top = finiteDetailNumber(numerator);
  const bottom = finiteDetailNumber(denominator);
  return top === null || bottom === null || bottom === 0 ? null : (top / bottom) * multiplier;
}

function isUsMarketWeekend(now = new Date()) {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(now);
  return weekday === "Sat" || weekday === "Sun";
}

function describeQuoteContext(quote = {}) {
  if (quote.source === "sample") return "Örnek veri · canlı değildir";
  const provider = ({ tradingview: "TradingView", yahoo: "Yahoo Finance", yahoo_finance: "Yahoo Finance", "local-entry": "İşlem girişi" })[String(quote.source || "").toLowerCase()] || quote.source || "Kaynak bilinmiyor";
  const updated = Number(quote.updatedAt);
  const asOf = Number.isFinite(updated) && updated > 0
    ? new Date(updated).toLocaleString("tr-TR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
    : "zaman bilgisi yok";
  const cacheNote = quote.cacheState === "stale"
    ? " · son başarılı kayıt"
    : quote.cacheState === "fresh" ? " · taze önbellek" : "";
  const freshness = `${provider} · ${asOf}${quote.delayed ? " · gecikmeli" : ""}${cacheNote}`;
  if (quote.priceType === "extended") {
    return `${freshness} · ${quote.session === "pre-market" ? "piyasa öncesi" : "seans sonrası"}`;
  }
  if (quote.priceType === "extended-close") {
    return `${freshness} · ${isUsMarketWeekend() ? "haftalık extended kapanış" : "son extended kapanış"}`;
  }
  if (quote.priceType === "daily-close") return `${freshness} · günlük kapanış`;
  if (quote.priceType === "regular-close") return `${freshness} · normal seans kapanışı`;
  if (quote.session === "regular") return `${freshness} · normal seans`;
  return freshness;
}

function renderStockDetail() {
  const page = document.getElementById("stockDetailPage");
  if (!page || !stockDetailView.symbol) return;
  const symbol = stockDetailView.symbol;
  const holding = calculatePortfolio().holdings.find(item => item.symbol === symbol);
  const quote = state.prices[symbol] || holding?.quote || {};
  const points = stockDetailView.history;
  const payload = stockDetailView.fundamentals;
  const fundamentals = payload?.fundamentals || {};
  const identity = payload?.identity || {};
  const metrics = points.length ? getTechnicalMetrics(points) : null;
  const price = Number.isFinite(Number(quote.price)) && Number(quote.price) > 0 ? Number(quote.price) : metrics?.price || null;
  const change = Number.isFinite(Number(quote.changePct)) ? Number(quote.changePct) : null;
  const marketCap = price && Number.isFinite(Number(fundamentals.sharesOutstanding)) ? price * Number(fundamentals.sharesOutstanding) : null;
  const trailingPe = price && Number(fundamentals.trailingEps) > 0 ? price / Number(fundamentals.trailingEps) : null;
  const epsGrowth = Number(fundamentals.epsGrowthYoYPct);
  const peg = trailingPe && Number.isFinite(epsGrowth) && epsGrowth > 0 ? trailingPe / epsGrowth : null;
  const annualPoints = points.slice(-252);
  const annualHighs = annualPoints.map(point => Number(point.h) || Number(point.c)).filter(Number.isFinite);
  const annualLows = annualPoints.map(point => Number(point.l) || Number(point.c)).filter(Number.isFinite);
  const high52 = annualHighs.length ? Math.max(...annualHighs) : null;
  const low52 = annualLows.length ? Math.min(...annualLows) : null;
  const rangePosition = Core.calculateRangePosition({ price, low: low52, high: high52 });
  const stage = Core.classifyTechnicalStage({ price, sma50: metrics?.sma50, sma200: metrics?.sma200 });
  const watchlistButton = document.getElementById("stockDetailWatchlistButton");
  if (watchlistButton) {
    const watched = isOnWatchlist(symbol);
    watchlistButton.disabled = Boolean(holding);
    watchlistButton.textContent = holding ? "✓ Portföyünde" : watched ? "★ Takipten çıkar" : "☆ Takibe ekle";
    watchlistButton.className = `button ${watched ? "primary" : "secondary"}`;
  }

  page.classList.toggle("is-loading", stockDetailView.loading);
  detailText("stockDetailSymbol", symbol);
  detailText("stockDetailPrice", price ? formatMoney(price, "USD", { maximumFractionDigits: 2, minimumFractionDigits: 2 }) : "—");
  setDetailMetric("stockDetailChange", change === null ? "—" : signedPercent(change), change === null ? "" : typeClass(change));
  detailText("stockDetailPriceContext", describeQuoteContext(quote));
  detailText("stockDetailIdentity", `${identity.name || holding?.name || symbol}${identity.exchange ? ` · ${identity.exchange}` : ""} · USD`);
  detailText("stockDetailPositionValue", holding ? formatMoney(holding.value, "USD", { maximumFractionDigits: 2 }) : "Portföyünde değil");
  detailText("stockDetailPositionMeta", holding ? `${formatNumber(holding.quantity, 4)} adet · ort. ${formatMoney(holding.avgCost, "USD", { maximumFractionDigits: 2 })}` : "Yalnızca inceleme görünümü");

  setDetailMetric("stockMetricMarketCap", marketCap ? formatCompactUsd(marketCap) : "—");
  detailText("stockMetricMarketCapNote", fundamentals.sharesAsOf ? `Yaklaşık · pay adedi ${formatDetailDate(fundamentals.sharesAsOf)} tarihli SEC kaydı` : "SEC pay adedi bulunamadı");
  const revenueGrowth = fundamentals.revenueGrowthYoYPct === null || fundamentals.revenueGrowthYoYPct === undefined
    ? null
    : Number(fundamentals.revenueGrowthYoYPct);
  setDetailMetric("stockMetricRevenueGrowth", Number.isFinite(revenueGrowth) ? signedPercent(revenueGrowth) : "—", Number.isFinite(revenueGrowth) ? typeClass(revenueGrowth) : "");
  detailText("stockMetricRevenueGrowthNote", fundamentals.revenuePeriodEnd ? `${formatDetailDate(fundamentals.revenuePeriodEnd)} biten ${fundamentals.revenueGrowthBasis === "FY" ? "mali yıl" : "YTD dönem"} · yıllık karşılaştırma` : "Karşılaştırılabilir dönem bulunamadı");
  setDetailMetric("stockMetricTrailingPe", trailingPe ? formatNumber(trailingPe, 1) : "—");
  detailText("stockMetricTrailingPeNote", fundamentals.trailingEps ? `Hesaplanan · GAAP seyreltilmiş TTM EPS: ${formatMoney(Number(fundamentals.trailingEps), "USD", { maximumFractionDigits: 2 })}` : "GAAP seyreltilmiş TTM EPS üretilemedi");
  setDetailMetric("stockMetricForwardPe", "—");
  setDetailMetric("stockMetricPeg", peg ? formatNumber(peg, 2) : "—");
  detailText("stockMetricPegNote", peg ? `Gerçekleşmiş EPS büyümesi: ${signedPercent(epsGrowth)}` : "Pozitif ve karşılaştırılabilir EPS büyümesi gerekli");
  setDetailMetric("stockMetricRsi", Number.isFinite(metrics?.rsi) ? formatNumber(metrics.rsi, 0) : "—", metrics?.rsi >= 70 ? "negative" : metrics?.rsi <= 30 ? "positive" : "");
  detailText("stockMetricRsiNote", Number.isFinite(metrics?.rsi) ? (metrics.rsi >= 70 ? "70 üzeri: aşırı alım bölgesi" : metrics.rsi <= 30 ? "30 altı: aşırı satım bölgesi" : "30–70 arası: nötr momentum") : "Yeterli fiyat geçmişi yok");
  setDetailMetric("stockMetricRange", rangePosition === null ? "—" : `%${formatNumber(rangePosition, 0)}`);
  detailText("stockMetricRangeNote", low52 && high52 ? `${formatMoney(low52, "USD", { maximumFractionDigits: 2 })} — ${formatMoney(high52, "USD", { maximumFractionDigits: 2 })}` : "Bir yıllık fiyat aralığı bulunamadı");
  setDetailMetric("stockMetricStage", stage.label, stage.tone === "positive" ? "positive" : stage.tone === "negative" ? "negative" : "");
  detailText("stockMetricStageNote", Number.isFinite(metrics?.sma50) && Number.isFinite(metrics?.sma200) ? `SMA50 ${formatMoney(metrics.sma50, "USD", { maximumFractionDigits: 2 })} · SMA200 ${formatMoney(metrics.sma200, "USD", { maximumFractionDigits: 2 })}` : "En az 200 işlem günü gerekli");

  let resistance = null;
  let support = null;
  if (metrics && points.length >= 30) {
    try {
      const levels = calculateLevels(metrics, holding?.avgCost || null);
      resistance = levels.resistanceLevels[0] || null;
      support = levels.supportLevels[0] || null;
    } catch (_) { /* Optional price-map detail must not break the page. */ }
  }
  const levelText = level => level && price ? `${formatMoney(level.val, "USD", { maximumFractionDigits: 2 })} · ${formatNumber(Math.abs(level.val / price - 1) * 100, 1)}%` : "—";
  detailText("stockNearestResistance", levelText(resistance));
  detailText("stockNearestSupport", levelText(support));
  const fill = document.getElementById("stockRangeFill");
  const marker = document.getElementById("stockRangeMarker");
  const safePosition = rangePosition ?? 0;
  if (fill) fill.style.width = `${safePosition}%`;
  if (marker) marker.style.left = `${safePosition}%`;
  detailText("stockPriceMapNote", rangePosition === null ? "Bir yıllık fiyat geçmişi henüz hazır değil." : `Fiyat 52 haftalık bandın %${formatNumber(rangePosition, 0)} seviyesinde. Seviyeler mekanik göstergedir; tek başına işlem sinyali değildir.`);

  const status = document.getElementById("stockDetailStatus");
  if (status) {
    status.className = `status-chip ${stockDetailView.loading ? "neutral" : stockDetailView.errors.length ? "warn" : "live"}`;
    status.textContent = stockDetailView.loading ? "SEC ve fiyat geçmişi yükleniyor" : stockDetailView.errors.length ? "Kısmi veri · ayrıntı aşağıda" : "Veriler hazır";
  }
  const sourceParts = ["Finansallar: SEC EDGAR (resmi, gerçekleşmiş)", `Fiyat geçmişi: mevcut ücretsiz akış (${points.length} gün)`];
  if (fundamentals.reportingFiledAt) sourceParts.push(`son SEC dosyası ${formatDetailDate(fundamentals.reportingFiledAt)}`);
  if (stockDetailView.errors.length) sourceParts.push(`uyarı: ${stockDetailView.errors.join(" · ")}`);
  detailText("stockDetailSources", sourceParts.join(" · "));
}

function setFundamentalText(id, value, tone = "") {
  const element = document.getElementById(id);
  if (!element) return;
  element.textContent = value;
  element.classList.remove("positive", "negative");
  if (tone) element.classList.add(tone);
}

function formatFundamentalAmount(value) {
  const parsed = finiteDetailNumber(value);
  return parsed === null ? "—" : formatCompactUsd(parsed);
}

function formatFundamentalPercent(value, digits = 1) {
  const parsed = finiteDetailNumber(value);
  return parsed === null ? "—" : `${formatNumber(parsed, digits)}%`;
}

function setFundamentalPillar(id, result) {
  const article = document.getElementById(id);
  if (!article) return;
  article.classList.remove("good", "watch", "risk");
  if (result.tone) article.classList.add(result.tone);
  const strong = article.querySelector("strong");
  const small = article.querySelector("small");
  if (strong) strong.textContent = result.label;
  if (small) small.textContent = result.note;
}

function fundamentalListRow(label, value, note, tone = "") {
  return `<div class="fundamental-list-row"><span>${escapeHtml(label)}</span><strong class="${tone}">${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></div>`;
}

function renderFundamentalAnalysis() {
  const page = document.getElementById("fundamentalAnalysisPage");
  if (!page || !stockDetailView.symbol) return;
  const symbol = stockDetailView.symbol;
  const holding = calculatePortfolio().holdings.find(item => item.symbol === symbol);
  const quote = state.prices[symbol] || holding?.quote || {};
  const payload = stockDetailView.fundamentals;
  const fundamentals = payload?.fundamentals || {};
  const identity = payload?.identity || {};
  const ttm = fundamentals.ttm || {};
  const balance = fundamentals.balanceSheet || {};
  const annualSeries = Array.isArray(fundamentals.annualSeries) ? fundamentals.annualSeries : [];
  const providerWarnings = Array.isArray(payload?.warnings) ? payload.warnings : [];
  const price = finiteDetailNumber(quote.price);
  const shares = finiteDetailNumber(fundamentals.sharesOutstanding);
  const marketCap = price !== null && shares !== null ? price * shares : null;
  const revenue = finiteDetailNumber(ttm.revenue);
  const grossProfit = finiteDetailNumber(ttm.grossProfit);
  const operatingIncome = finiteDetailNumber(ttm.operatingIncome);
  const netIncome = finiteDetailNumber(ttm.netIncome);
  const operatingCashFlow = finiteDetailNumber(ttm.operatingCashFlow);
  const freeCashFlow = finiteDetailNumber(ttm.freeCashFlow);
  const totalCash = finiteDetailNumber(balance.totalCash);
  const totalDebt = finiteDetailNumber(balance.totalDebt);
  const equity = finiteDetailNumber(balance.equity);
  const currentAssets = finiteDetailNumber(balance.currentAssets);
  const currentLiabilities = finiteDetailNumber(balance.currentLiabilities);
  const grossMargin = safeFundamentalRatio(grossProfit, revenue, 100);
  const operatingMargin = safeFundamentalRatio(operatingIncome, revenue, 100);
  const netMargin = safeFundamentalRatio(netIncome, revenue, 100);
  const fcfMargin = safeFundamentalRatio(freeCashFlow, revenue, 100);
  const cashConversion = safeFundamentalRatio(operatingCashFlow, netIncome, 100);
  const currentRatio = safeFundamentalRatio(currentAssets, currentLiabilities);
  const debtToEquity = safeFundamentalRatio(totalDebt, equity);
  const netCash = totalCash !== null && totalDebt !== null ? totalCash - totalDebt : null;
  const trailingPe = price !== null && finiteDetailNumber(fundamentals.trailingEps) > 0 ? price / Number(fundamentals.trailingEps) : null;
  const priceToSales = safeFundamentalRatio(marketCap, revenue);
  const fcfYield = safeFundamentalRatio(freeCashFlow, marketCap, 100);
  const netCashPerShare = safeFundamentalRatio(netCash, shares);
  const revenueGrowth = finiteDetailNumber(fundamentals.revenueGrowthYoYPct);
  const epsGrowth = finiteDetailNumber(fundamentals.epsGrowthYoYPct);

  setFundamentalText("fundamentalSymbol", symbol);
  setFundamentalText("fundamentalPrice", price === null ? "—" : formatMoney(price, "USD", { maximumFractionDigits: 2, minimumFractionDigits: 2 }));
  setFundamentalText("fundamentalPriceContext", describeQuoteContext(quote));
  setFundamentalText("fundamentalIdentity", `${identity.name || holding?.name || symbol}${identity.exchange ? ` · ${identity.exchange}` : ""} · USD`);
  setFundamentalText("fundamentalPeriod", fundamentals.ttmPeriod?.end ? `${formatDetailDate(fundamentals.ttmPeriod.end)} biten TTM` : "TTM dönemi üretilemedi");
  setFundamentalText("fundamentalFiledAt", fundamentals.reportingFiledAt ? `Son kullanılan dosya: ${formatDetailDate(fundamentals.reportingFiledAt)}` : "Dosya tarihi yok");

  const status = document.getElementById("fundamentalStatus");
  if (status) {
    const partial = stockDetailView.errors.length > 0 || providerWarnings.length > 0;
    status.className = `status-chip ${stockDetailView.loading ? "neutral" : payload ? (partial ? "warn" : "live") : "warn"}`;
    status.textContent = stockDetailView.loading ? "SEC verileri yükleniyor" : payload ? (partial ? "Kısmi resmî veri" : "Resmî veriler hazır") : "SEC ayarı/verisi gerekli";
  }

  setFundamentalText("fundamentalRevenue", formatFundamentalAmount(revenue));
  setFundamentalText("fundamentalRevenueNote", fundamentals.ttmPeriod?.basis === "LATEST_FY" ? "Son tamamlanmış mali yıl" : "FY + güncel YTD − önceki eş YTD");
  setFundamentalText("fundamentalRevenueGrowth", revenueGrowth === null ? "—" : signedPercent(revenueGrowth), revenueGrowth === null ? "" : typeClass(revenueGrowth));
  setFundamentalText("fundamentalRevenueGrowthNote", fundamentals.revenueGrowthBasis === "FY" ? "Son mali yıl / önceki mali yıl" : "Güncel YTD / önceki yıl eş YTD");
  setFundamentalText("fundamentalGrossMargin", formatFundamentalPercent(grossMargin));
  setFundamentalText("fundamentalOperatingMargin", formatFundamentalPercent(operatingMargin));
  setFundamentalText("fundamentalNetMargin", formatFundamentalPercent(netMargin));
  setFundamentalText("fundamentalFcf", formatFundamentalAmount(freeCashFlow), freeCashFlow === null ? "" : typeClass(freeCashFlow));
  setFundamentalText("fundamentalFcfMargin", formatFundamentalPercent(fcfMargin));
  setFundamentalText("fundamentalCashConversion", formatFundamentalPercent(cashConversion, 0));
  setFundamentalText("fundamentalBalanceDate", balance.asOf ? `${formatDetailDate(balance.asOf)} itibarıyla` : "Aynı tarihli bilanço seti bulunamadı");

  const growthPillar = revenueGrowth === null && epsGrowth === null
    ? { label: "Veri eksik", note: "Yıllık ciro/EPS karşılaştırması yok", tone: "" }
    : revenueGrowth !== null && epsGrowth !== null && revenueGrowth >= 10 && epsGrowth >= 10
      ? { label: "Güçlü", note: `Ciro ${signedPercent(revenueGrowth)} · EPS ${signedPercent(epsGrowth)}`, tone: "good" }
      : (revenueGrowth !== null && revenueGrowth < 0) || (epsGrowth !== null && epsGrowth < 0)
        ? { label: "Baskı altında", note: `Ciro ${revenueGrowth === null ? "—" : signedPercent(revenueGrowth)} · EPS ${epsGrowth === null ? "—" : signedPercent(epsGrowth)}`, tone: "risk" }
        : { label: "Ilımlı", note: `Ciro ${revenueGrowth === null ? "—" : signedPercent(revenueGrowth)} · EPS ${epsGrowth === null ? "—" : signedPercent(epsGrowth)}`, tone: "watch" };
  const profitPillar = operatingMargin === null || netMargin === null
    ? { label: "Veri eksik", note: "Aynı TTM döneminde marj üretilemedi", tone: "" }
    : operatingMargin >= 15 && netMargin >= 10
      ? { label: "Güçlü", note: `Faaliyet %${formatNumber(operatingMargin, 1)} · net %${formatNumber(netMargin, 1)}`, tone: "good" }
      : operatingMargin > 0 && netMargin > 0
        ? { label: "Pozitif", note: `Faaliyet %${formatNumber(operatingMargin, 1)} · net %${formatNumber(netMargin, 1)}`, tone: "watch" }
        : { label: "Zayıf", note: "Faaliyet veya net marj pozitif değil", tone: "risk" };
  const cashPillar = freeCashFlow === null
    ? { label: "Veri eksik", note: "Aynı dönem CFO ve capex bulunamadı", tone: "" }
    : freeCashFlow > 0 && cashConversion !== null && cashConversion >= 80
      ? { label: "Güçlü", note: `FCF ${formatFundamentalAmount(freeCashFlow)} · dönüşüm %${formatNumber(cashConversion, 0)}`, tone: "good" }
      : freeCashFlow > 0
        ? { label: "Pozitif", note: `FCF ${formatFundamentalAmount(freeCashFlow)}`, tone: "watch" }
        : { label: "Negatif", note: `FCF ${formatFundamentalAmount(freeCashFlow)}`, tone: "risk" };
  const balancePillar = netCash === null || currentRatio === null
    ? { label: "Veri eksik", note: "Aynı tarihli nakit/borç/cari oran seti yok", tone: "" }
    : netCash >= 0 && currentRatio >= 1.5
      ? { label: "Güçlü", note: `Net nakit ${formatFundamentalAmount(netCash)} · cari ${formatNumber(currentRatio, 2)}x`, tone: "good" }
      : currentRatio >= 1 && (debtToEquity === null || debtToEquity < 1)
        ? { label: "Dengeli", note: `Cari oran ${formatNumber(currentRatio, 2)}x`, tone: "watch" }
        : { label: "İzlenmeli", note: `Net borç ${formatFundamentalAmount(Math.abs(Math.min(netCash, 0)))} · cari ${formatNumber(currentRatio, 2)}x`, tone: "risk" };
  const pillars = [growthPillar, profitPillar, cashPillar, balancePillar];
  setFundamentalPillar("fundamentalGrowthPillar", growthPillar);
  setFundamentalPillar("fundamentalProfitPillar", profitPillar);
  setFundamentalPillar("fundamentalCashPillar", cashPillar);
  setFundamentalPillar("fundamentalBalancePillar", balancePillar);

  const coverageInputs = [revenue, grossProfit, operatingIncome, netIncome, operatingCashFlow, freeCashFlow, totalCash, totalDebt, equity, currentAssets, currentLiabilities, fundamentals.trailingEps, revenueGrowth, epsGrowth, shares];
  const covered = coverageInputs.filter(value => finiteDetailNumber(value) !== null).length;
  const minimumCoverage = Math.ceil(coverageInputs.length * 0.8);
  const coverageSufficient = covered >= minimumCoverage;
  const goodCount = pillars.filter(item => item.tone === "good").length;
  const riskCount = pillars.filter(item => item.tone === "risk").length;
  setFundamentalText("fundamentalCoverage", `${covered}/${coverageInputs.length} kritik alan doğrulandı`);
  setFundamentalText("fundamentalVerdict", payload ? (!coverageSufficient ? "Değerlendirme için veri yetersiz" : riskCount ? `${riskCount} başlık yakından izlenmeli` : goodCount >= 3 ? "Temel yapı güçlü görünüyor" : "Temel yapı dengeli, seçici izleme gerekli") : "SEC verisi bekleniyor");
  setFundamentalText("fundamentalVerdictNote", `Şeffaf eşikler: en az ${minimumCoverage}/${coverageInputs.length} veri kapsamı, büyümede %10, faaliyet marjında %15, pozitif FCF, nakit dönüşümünde %80 ve cari oranda 1,5x. ${covered < coverageInputs.length ? "Eksik alanlar sonuca zorla sıfır olarak katılmadı." : "Kritik alanların tamamı mevcut."}`);

  const balanceRows = [
    fundamentalListRow("Nakit + kısa vadeli yatırımlar", formatFundamentalAmount(totalCash), "Aynı bilanço tarihi", totalCash !== null ? "positive" : ""),
    fundamentalListRow("Raporlanan finansal borç", formatFundamentalAmount(totalDebt), "Kısa borç + cari uzun borç + uzun borç"),
    fundamentalListRow(netCash !== null && netCash >= 0 ? "Net nakit" : "Net borç", formatFundamentalAmount(netCash === null ? null : Math.abs(netCash)), "Toplam nakit − raporlanan borç", netCash === null ? "" : netCash >= 0 ? "positive" : "negative"),
    fundamentalListRow("Cari oran", currentRatio === null ? "—" : `${formatNumber(currentRatio, 2)}x`, "Dönen varlık / kısa vadeli yükümlülük", currentRatio === null ? "" : currentRatio >= 1.5 ? "positive" : currentRatio < 1 ? "negative" : ""),
    fundamentalListRow("Borç / özkaynak", debtToEquity === null ? "—" : `${formatNumber(debtToEquity, 2)}x`, "Raporlanan borç / özkaynak"),
  ];
  const balanceList = document.getElementById("fundamentalBalanceList");
  if (balanceList) balanceList.innerHTML = balanceRows.join("");

  const valuationRows = [
    fundamentalListRow("TTM F/K", trailingPe === null ? "—" : `${formatNumber(trailingPe, 1)}x`, "Güncel etkin fiyat / GAAP seyreltilmiş TTM EPS"),
    fundamentalListRow("Fiyat / satış", priceToSales === null ? "—" : `${formatNumber(priceToSales, 2)}x`, "Yaklaşık piyasa değeri / TTM ciro"),
    fundamentalListRow("FCF verimi", fcfYield === null ? "—" : `${formatNumber(fcfYield, 2)}%`, "TTM serbest nakit / yaklaşık piyasa değeri", fcfYield === null ? "" : fcfYield > 0 ? "positive" : "negative"),
    fundamentalListRow("Hisse başına net nakit", netCashPerShare === null ? "—" : formatMoney(netCashPerShare, "USD", { maximumFractionDigits: 2 }), "Net nakit / SEC son pay adedi"),
    fundamentalListRow("İleri değerleme", "—", "Ücretsiz resmî kaynak analist tahmini içermez"),
  ];
  const valuationList = document.getElementById("fundamentalValuationList");
  if (valuationList) valuationList.innerHTML = valuationRows.join("");

  const trendBody = document.getElementById("fundamentalTrendBody");
  if (trendBody) {
    trendBody.innerHTML = annualSeries.length ? [...annualSeries].reverse().map(row => {
      const rowRevenue = finiteDetailNumber(row.revenue);
      const rowGrossMargin = safeFundamentalRatio(row.grossProfit, rowRevenue, 100);
      const rowOperatingMargin = safeFundamentalRatio(row.operatingIncome, rowRevenue, 100);
      return `<tr><td>${escapeHtml(row.periodEnd ? formatDetailDate(row.periodEnd) : "—")}</td><td>${escapeHtml(formatFundamentalAmount(rowRevenue))}</td><td>${escapeHtml(formatFundamentalPercent(rowGrossMargin))}</td><td>${escapeHtml(formatFundamentalPercent(rowOperatingMargin))}</td><td>${escapeHtml(formatFundamentalAmount(row.netIncome))}</td><td>${escapeHtml(formatFundamentalAmount(row.freeCashFlow))}</td></tr>`;
    }).join("") : `<tr><td colspan="6">Aynı kavramlarla karşılaştırılabilir yıllık seri bulunamadı.</td></tr>`;
  }

  const strengths = [];
  const risks = [];
  if (revenueGrowth !== null && revenueGrowth >= 10) strengths.push(`Son karşılaştırılabilir çeyrekte ciro yıllık ${signedPercent(revenueGrowth)} büyüdü.`);
  if (operatingMargin !== null && operatingMargin >= 15) strengths.push(`TTM faaliyet marjı %${formatNumber(operatingMargin, 1)} ile güçlü eşik üzerinde.`);
  if (freeCashFlow !== null && freeCashFlow > 0) strengths.push(`İşletme, yatırımlar sonrasında ${formatFundamentalAmount(freeCashFlow)} TTM serbest nakit üretti.`);
  if (netCash !== null && netCash > 0) strengths.push(`Bilanço ${formatFundamentalAmount(netCash)} net nakit taşıyor.`);
  if (revenueGrowth !== null && revenueGrowth < 0) risks.push(`Karşılaştırılabilir çeyrekte ciro ${signedPercent(revenueGrowth)} daraldı.`);
  if (operatingMargin !== null && operatingMargin <= 0) risks.push("TTM faaliyet marjı pozitif değil.");
  if (freeCashFlow !== null && freeCashFlow <= 0) risks.push("TTM serbest nakit akışı negatif; nakit kalitesi izlenmeli.");
  if (freeCashFlow === null) risks.push("CFO veya capex aynı TTM döneminde doğrulanamadığı için FCF üretilemedi.");
  if (netCash !== null && netCash < 0) risks.push(`Bilanço ${formatFundamentalAmount(Math.abs(netCash))} net borç taşıyor.`);
  if (trailingPe !== null && trailingPe > 40) risks.push(`TTM F/K ${formatNumber(trailingPe, 1)}x; büyüme yavaşlarsa çarpan hassasiyeti yüksek olabilir.`);
  if (covered < 10) risks.push("Temel analiz kapsamı düşük; eksik SEC alanları nedeniyle sonuç ihtiyatla okunmalı.");
  const strengthsList = document.getElementById("fundamentalStrengths");
  const risksList = document.getElementById("fundamentalRisks");
  if (strengthsList) strengthsList.innerHTML = (strengths.length ? strengths : ["Tanımlı güçlü eşiklerde doğrulanmış belirgin bir madde oluşmadı."]).map(item => `<li>${escapeHtml(item)}</li>`).join("");
  if (risksList) risksList.innerHTML = (risks.length ? risks : ["Mevcut doğrulanmış alanlarda belirgin risk eşiği tetiklenmedi."]).map(item => `<li>${escapeHtml(item)}</li>`).join("");

  const concepts = fundamentals.concepts || {};
  const conceptLabels = Object.entries(concepts).filter(([, tag]) => tag).map(([key, tag]) => `${escapeHtml(key)}: <code>${escapeHtml(tag)}</code>`);
  const methodology = document.getElementById("fundamentalMethodologyContent");
  if (methodology) methodology.innerHTML = `<p>TTM akışları <code>son FY + güncel YTD − önceki yıl eş YTD</code> ile ve aynı dönem sonunda hesaplanır. Bilanço kalemleri yalnızca <code>${escapeHtml(balance.asOf || "aynı tarih bulunamadı")}</code> tarihinde birleşir. Eksik değerler sıfır yapılmaz.</p><p style="margin-top:8px">Seçilen standart kavramlar: ${conceptLabels.length ? conceptLabels.join(" · ") : "veri yok"}</p>${(payload?.notes || []).length ? `<p style="margin-top:8px">Yöntem notları: ${payload.notes.map(escapeHtml).join(" · ")}</p>` : ""}${stockDetailView.errors.length ? `<p style="margin-top:8px">Uyarılar: ${stockDetailView.errors.map(escapeHtml).join(" · ")}</p>` : ""}`;
  setFundamentalText("fundamentalSources", `Finansallar: SEC EDGAR Company Facts · CIK ${identity.cik || "—"} · fiyat: ${quote.source || "yerel kayıt"} (${describeQuoteContext(quote)})`);
}

function openFundamentalAnalysis() {
  if (!stockDetailView.symbol) return;
  activatePage("fundamentalAnalysis");
  renderFundamentalAnalysis();
  if (!stockDetailView.fundamentals && !stockDetailView.loading) void loadStockDetail({ force: false });
}

async function loadStockDetail({ force = false } = {}) {
  const symbol = stockDetailView.symbol;
  if (!symbol) return;
  const requestId = ++stockDetailView.requestId;
  stockDetailView.loading = true;
  stockDetailView.errors = [];
  if (force) technicalHistoryCache.delete(`${symbol}|1y`);
  renderStockDetail();
  if ($("#fundamentalAnalysisPage")?.classList.contains("active")) renderFundamentalAnalysis();
  const previousHistory = stockDetailView.history;
  const previousFundamentals = stockDetailView.fundamentals;
  const [historyResult, secResult] = await Promise.allSettled([
    getTechnicalHistory(symbol, "1y"),
    fetch(`/api/sec-fundamentals?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" }).then(async response => {
      const payload = await readJsonResponse(response, "sec");
      if (!response.ok) throw serviceError("sec");
      return payload;
    }),
  ]);
  if (requestId !== stockDetailView.requestId) return;
  if (historyResult.status === "fulfilled") stockDetailView.history = historyResult.value;
  else {
    stockDetailView.history = previousHistory?.length ? previousHistory : [];
    stockDetailView.errors.push(friendlyError("price", historyResult.reason, { hasCached: Boolean(previousHistory?.length) }));
  }
  if (secResult.status === "fulfilled") {
    stockDetailView.fundamentals = secResult.value;
    stockDetailView.errors.push(...(secResult.value.warnings || []));
  } else {
    stockDetailView.fundamentals = previousFundamentals || null;
    stockDetailView.errors.push(friendlyError("sec", secResult.reason, { hasCached: Boolean(previousFundamentals) }));
  }
  stockDetailView.loading = false;
  renderStockDetail();
  if ($("#fundamentalAnalysisPage")?.classList.contains("active")) renderFundamentalAnalysis();
}

function openStockDetail(symbol) {
  const normalized = String(symbol || "").trim().toUpperCase();
  if (!normalized) return;
  if (normalized.endsWith(".IS")) { openTechnicalAnalysis(normalized); return; }
  const activePage = document.querySelector(".page.active")?.id?.replace(/Page$/, "");
  if (activePage && activePage !== "stockDetail") stockDetailView.returnPage = activePage;
  const changed = stockDetailView.symbol !== normalized;
  stockDetailView.symbol = normalized;
  if (changed) {
    stockDetailView.history = [];
    stockDetailView.fundamentals = null;
    stockDetailView.errors = [];
  }
  activatePage("stockDetail");
  renderStockDetail();
  void loadStockDetail({ force: false });
}

async function loadTechnicalHistory() {
  if (!technicalView.symbol) return;
  if (location.protocol === "file:") { technicalView.error = "Teknik analiz için uygulamayı Baslat.cmd ile aç."; renderTechnicalAnalysis(); return; }
  const previousPoints = technicalView.points;
  technicalView.loading = true; technicalView.error = ""; technicalView.staleWarning = ""; renderTechnicalAnalysis();
  try {
    technicalView.points = await getTechnicalHistory(technicalView.symbol, technicalView.period);
  } catch (error) {
    technicalView.points = previousPoints?.length ? previousPoints : [];
    if (technicalView.points.length) technicalView.staleWarning = friendlyError("price", error, { hasCached: true });
    else technicalView.error = friendlyError("price", error);
  } finally {
    technicalView.loading = false; renderTechnicalAnalysis();
    // Auto-analyze: veri yüklendi, ayar aktifse AI'ı çalıştır
    if (!technicalView.error && technicalView.points.length && getAiSettings().autoAnalyze && hasGeminiKey()) {
      void callGeminiAI();
    }
  }
}

function openTechnicalAnalysis(symbol) {
  technicalView.symbol = symbol;
  technicalView.currency = getSymbolCurrency(symbol);
  technicalView.symbol = symbol;
  technicalView.points = [];
  technicalView.error = "";
  technicalView.staleWarning = "";
  technicalView.aiResult = null;
  technicalView.aiLoading = false;
  technicalView.aiError = "";
  $("#technicalAdvancedDetails")?.removeAttribute("open");
  const dialog = $("#technicalDialog");
  if (!dialog.open) dialog.showModal();
  loadTechnicalHistory();
}

function updateTechnicalAlertForm() {
  const threshold = $("#technicalAlertThreshold");
  const usesRsi = $("#technicalAlertType").value.startsWith("RSI_");
  threshold.disabled = !usesRsi;
  threshold.hidden = !usesRsi;
}

function saveTechnicalAlert(event) {
  event.preventDefault();
  if (!technicalView.symbol || !technicalView.points.length) { showToast("Alarm için önce teknik veri yüklenmeli."); return; }
  const type = $("#technicalAlertType").value;
  const threshold = Math.max(1, Math.min(99, Math.round(number($("#technicalAlertThreshold").value) || 30)));
  state.technicalAlerts.push({ id: uid("ta"), symbol: technicalView.symbol, type, threshold, active: false, createdAt: Date.now() });
  saveState(); renderTechnicalAnalysis(); showToast("Teknik alarm eklendi.");
}

function deleteTechnicalAlert(id) {
  state.technicalAlerts = state.technicalAlerts.filter(alert => alert.id !== id);
  saveState(); renderTechnicalAnalysis();
}

// ── AI Analiz ──────────────────────────────────────────────────────────────

function getAiSettings() {
  try {
    const raw = localStorage.getItem(AI_SETTINGS_KEY);
    return raw ? JSON.parse(raw) : { autoAnalyze: false, model: "" };
  } catch { return { autoAnalyze: false, model: "" }; }
}

function getGeminiModel() {
  return getAiSettings().model || "";
}

function getGeminiKey() {
  return $("#geminiApiKeyInput")?.value?.trim() || "";
}

function hasGeminiKey() {
  return aiSecretStatus.hasGeminiKey || Boolean(getGeminiKey());
}

function renderAiAnalysis() {
  const result = $("#aiAnalysisResult");
  if (!result) return;

  if (technicalView.aiLoading) {
    result.className = "ai-analysis-result ai-loading";
    result.innerHTML = `<span>Gemini yorumluyor</span><span class="ai-loading-dots"><span></span><span></span><span></span></span>`;
    return;
  }
  if (technicalView.aiError) {
    result.className = "ai-analysis-result ai-error";
    result.innerHTML = `<p>${escapeHtml(technicalView.aiError)}</p>`;
    return;
  }
  if (!technicalView.aiResult) {
    result.className = "ai-analysis-result ai-idle";
    result.innerHTML = hasGeminiKey()
      ? `<p class="ai-idle-text">✦ AI ile Yorumla butonuna tıkla; Gemini mevcut teknik göstergeleri analiz eder.</p>`
      : `<p class="ai-idle-text">API anahtarın ayarlanmamış. Ayarlar → Yapay Zekâ bölümünden Gemini API anahtarını gir ve kaydet.</p>`;
    return;
  }
  result.className = "ai-analysis-result";
  // Markdown-benzeri metni HTML'e çevir (kalın, liste)
  const html = technicalView.aiResult
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/^[\*\-] (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/gs, m => `<ul>${m}</ul>`)
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/\n/g, "<br>");
  result.innerHTML = `<p>${html}</p>`;
}

async function callGeminiAI() {
  if (!hasGeminiKey()) {
    technicalView.aiError = "Gemini API anahtarı bulunamadı. Lütfen Ayarlar → Yapay Zekâ bölümünden gir.";
    renderAiAnalysis();
    return;
  }
  // Model: kaydedilmiş veya dropdown'daki mevcut seçim
  const model = getGeminiModel() || $("#geminiModelSelect")?.value || "";
  if (!model) {
    technicalView.aiError = "Ayarlar → Yapay Zekâ bölümünden bir model seçip kaydet.";
    renderAiAnalysis();
    return;
  }
  if (!technicalView.points.length) {
    technicalView.aiError = "Teknik veri henüz yüklenmedi. Lütfen birkaç saniye bekle.";
    renderAiAnalysis();
    return;
  }

  const metrics = getTechnicalMetrics(technicalView.points);
  const holding = calculatePortfolio().holdings.find(h => h.symbol === technicalView.symbol);
  const currency = getSymbolCurrency(technicalView.symbol);
  const periodLabels = { "1d": "1 günlük", "1w": "1 haftalık", "1mo": "1 aylık", "3mo": "3 aylık", "6mo": "6 aylık", ytd: "yılbaşından bugüne", "1y": "1 yıllık" };
  const period = periodLabels[technicalView.period] || "seçili dönem";
  const levels = calculateLevels(metrics, holding?.avgCost ?? null);
  const breakout = analyzeBreakouts(metrics, technicalView.points);
  const lastMacd = latestFinite(metrics.macdLine);
  const lastMacdSignal = latestFinite(metrics.macdSignal);
  const volumeWindow = metrics.volumes.slice(-20);
  const hasVolume = volumeWindow.some(value => value > 0);
  const averageVolume = hasVolume ? volumeWindow.reduce((sum, value) => sum + value, 0) / volumeWindow.length : 0;
  const lastVolume = metrics.volumes.at(-1) || 0;
  const volumeRatio = averageVolume > 0 ? lastVolume / averageVolume : null;
  const support = breakout?.nearestSupport?.price || levels?.supportLevels?.[0]?.val || null;
  const resistance = breakout?.nearestResistance?.price || levels?.resistanceLevels?.[0]?.val || null;

  const prompt = `Sen bir teknik analiz uzmanısın ve yatırımcılara Türkçe olarak yardım ediyorsun.

Aşağıdaki hisse senedinin ${period} teknik göstergelerini değerlendir:

**Hisse:** ${technicalView.symbol}${holding ? ` (${holding.name})` : ""}
**Para birimi:** ${currency}
**Son fiyat:** ${formatMoney(metrics.price, currency, { maximumFractionDigits: 2 })}
**Mevcut trend özeti:** ${metrics.trend}
**Regresyon trendi:** ${metrics.priceChannel.trendLabel}
**Fiyat kanalı:** ${metrics.priceChannel.channelLabel} (uyum: %${formatNumber(metrics.priceChannel.fit * 100, 0)})
**SMA20:** ${metrics.sma20 ? formatMoney(metrics.sma20, currency, { maximumFractionDigits: 2 }) : "hesaplanamadı"}
**SMA50:** ${metrics.sma50 ? formatMoney(metrics.sma50, currency, { maximumFractionDigits: 2 }) : "hesaplanamadı"}
**SMA200:** ${metrics.sma200 ? formatMoney(metrics.sma200, currency, { maximumFractionDigits: 2 }) : "hesaplanamadı (1 yıl verisi gerekli)"}
**RSI(14):** ${metrics.rsi !== null ? metrics.rsi.toFixed(1) : "hesaplanamadı"}
**MACD / sinyal çizgisi:** ${Number.isFinite(lastMacd) && Number.isFinite(lastMacdSignal) ? `${formatNumber(lastMacd, 3)} / ${formatNumber(lastMacdSignal, 3)}` : "hesaplanamadı"}
**Son hacim / 20 dönemlik ortalama:** ${Number.isFinite(volumeRatio) ? `${formatNumber(volumeRatio, 2)} kat` : "hacim verisi yok"}
**ATR(14) oynaklığı:** ${Number.isFinite(levels?.atrPct) ? `%${formatNumber(levels.atrPct, 1)}` : "hesaplanamadı"}
**İlk destek:** ${support ? formatMoney(support, currency, { maximumFractionDigits: 2 }) : "bulunamadı"}
**İlk direnç:** ${resistance ? formatMoney(resistance, currency, { maximumFractionDigits: 2 }) : "bulunamadı"}
**SMA20/SMA50 son kesişim:** ${metrics.cross ? (metrics.cross === "up" ? "Yukarı kesiş (golden cross benzeri)" : "Aşağı kesiş (death cross benzeri)") : "Son periyotta kesişim yok"}

Yeni başlayan birinin tek okumada anlayacağı biçimde yaz. Gösterge adını mutlaka söyle, hemen ardından parantezsiz sade anlamını açıkla. Çelişen sinyalleri gizleme ve kesin kazanç ihtimali verme.

Şu sırayı ve başlıkları kullan:
1. İlk satır yalnızca **Net sonuç: OLUMLU**, **Net sonuç: KARARSIZ — BEKLE** veya **Net sonuç: OLUMSUZ** olsun.
2. **Neden?** altında en fazla dört kısa madde: Trend (SMA20/SMA50/SMA200), Momentum (RSI ve MACD), Hacim ve Risk (ATR).
3. **Kritik seviyeler:** olumlu teyit için direnç ile ilk savunma için desteği açıkla.
4. **Elimde varsa:** mevcut pozisyon için izlenecek koşulu tek cümlede yaz.
5. **Yeni almayı düşünüyorsam:** teyit bekleme koşulunu tek cümlede yaz.

Sonuna bunun yatırım tavsiyesi olmadığını belirten tek kısa cümle ekle. Markdown **kalın** ve - liste formatını kullanabilirsin.`;

  technicalView.aiLoading = true;
  technicalView.aiError = "";
  technicalView.aiResult = null;
  renderAiAnalysis();

  try {
    if (getGeminiKey() && !await syncGeminiKeyToServer(getGeminiKey())) {
      throw new Error("Gemini anahtarı güvenli bulut ayarlarına kaydedilemedi.");
    }
    const response = await fetch("/api/ai/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 2048 }
      })
    });
    const data = await readJsonResponse(response, "gemini");
    if (!response.ok) throw serviceError("gemini");
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini boş yanıt döndürdü.");
    technicalView.aiResult = text;
  } catch (err) {
    technicalView.aiError = friendlyError("gemini", err);
  } finally {
    technicalView.aiLoading = false;
    renderAiAnalysis();
  }
}

// Gemini API'den mevcut modelleri çek, generateContent destekleyenleri filtrele
async function fetchGeminiModels() {
  try {
    const resp = await fetch("/api/ai/models", { cache: "no-store" });
    const data = await readJsonResponse(resp, "gemini");
    aiSecretStatus = { hasGeminiKey: data.hasGeminiKey !== false, loaded: true };
    if (!resp.ok) throw serviceError("gemini");
    return (data.models || []).filter(m =>
      Array.isArray(m.supportedGenerationMethods) &&
      m.supportedGenerationMethods.includes("generateContent") &&
      !m.name.includes("embedding") &&
      !m.name.includes("aqa")
    );
  } catch { return []; }
}

function populateModelSelect(models, savedModel) {
  const sel = $("#geminiModelSelect");
  if (!sel) return;

  if (models.length === 0) {
    sel.innerHTML = savedModel
      ? `<option value="${escapeHtml(savedModel)}">${escapeHtml(savedModel)} (kayıtlı)</option>`
      : aiSecretStatus.hasGeminiKey
        ? `<option value="" disabled selected>Model listesi alınamadı — bağlantıyı kontrol edin</option>`
        : `<option value="" disabled selected>Önce API anahtarını kaydedin</option>`;
  } else {
    sel.innerHTML = models.map(m => {
      const shortName = m.name.replace("models/", "");
      const displayName = m.displayName || shortName;
      return `<option value="${escapeHtml(shortName)}">${escapeHtml(displayName)}</option>`;
    }).join("");
  }

  if (!sel || !sel.options) return;
  // Kaydedilmiş modeli seç ; bulunamazsa ilk öğeyi seç
  if (savedModel && Array.from(sel.options).some(o => o.value === savedModel)) {
    sel.value = savedModel;
  } else if (sel.options.length > 0) {
    sel.value = sel.options[0].value;
  }
}

async function loadAiSettings() {
  const settings = getAiSettings();
  const keyInput = $("#geminiApiKeyInput");
  const autoCheck = $("#aiAutoAnalyze");
  const modelSelect = $("#geminiModelSelect");
  if (keyInput) keyInput.value = "";
  if (autoCheck) autoCheck.checked = settings.autoAnalyze || false;

  if (modelSelect && !aiSecretStatus.loaded && !aiModelsLoading) {
    aiModelsLoading = true;
    modelSelect.innerHTML = `<option disabled selected>Model listesi yükleniyor...</option>`;
    try {
      const models = await fetchGeminiModels();
      populateModelSelect(models, settings.model);
    } finally {
      aiModelsLoading = false;
    }
  } else if (modelSelect && !modelSelect.options.length) {
    populateModelSelect([], settings.model);
  }
  if (keyInput && aiSecretStatus.hasGeminiKey) keyInput.placeholder = "Kayıtlı — değiştirmek için yeni anahtar girin";
}

async function saveAiSettings() {
  const key = $("#geminiApiKeyInput")?.value?.trim() || "";
  const autoAnalyze = $("#aiAutoAnalyze")?.checked || false;
  const model = $("#geminiModelSelect")?.value || "";
  let recoveredPreviousConfig = false;
  if (key) {
    const saved = await syncGeminiKeyToServer(key);
    if (!saved) {
      showToast("API anahtarı güvenli bulut ayarlarına kaydedilemedi.");
      return;
    }
    recoveredPreviousConfig = Boolean(saved.recoveredPreviousConfig);
    $("#geminiApiKeyInput").value = "";
    $("#geminiApiKeyInput").placeholder = "Kayıtlı — değiştirmek için yeni anahtar girin";
  }
  localStorage.removeItem(AI_KEY_STORAGE);
  localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify({ autoAnalyze, model }));
  aiSecretStatus.loaded = false;
  await loadAiSettings();
  const status = $("#aiSettingsStatus");
  if (status) {
    status.textContent = recoveredPreviousConfig
      ? "✓ AI ayarı kaydedildi. Önceki okunamayan şifreli dosya yedeğe ayrıldı; SEC/Telegram ayarlarını yeniden girin."
      : `✓ AI ayarları kaydedildi${model ? ` — ${model}` : ""}`;
    status.style.color = recoveredPreviousConfig ? "var(--yellow)" : "";
    setTimeout(() => { if (status) { status.textContent = ""; status.style.color = ""; } }, recoveredPreviousConfig ? 9000 : 4000);
  }
  showToast(recoveredPreviousConfig ? "Şifreli ayarlar onarıldı; AI anahtarı kaydedildi." : "AI ayarları kaydedildi.");
}

async function syncGeminiKeyToServer(key) {
  if (!key || location.protocol === "file:") return false;
  try {
    const response = await fetch("/api/sync-gemini-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ geminiKey: key })
    });
    const payload = await readJsonResponse(response, "gemini");
    if (!response.ok) return false;
    aiSecretStatus = { hasGeminiKey: true, loaded: true };
    return payload;
  } catch (_) { return false; }
}

async function migrateLegacyBrowserSecrets() {
  if (location.protocol === "file:") return;
  const legacyGemini = localStorage.getItem(AI_KEY_STORAGE) || "";
  const legacyToken = localStorage.getItem("tgToken") || "";
  const legacyUserId = localStorage.getItem("tgUserId") || "";
  if (legacyGemini && await syncGeminiKeyToServer(legacyGemini)) {
    localStorage.removeItem(AI_KEY_STORAGE);
  }
  if (legacyToken || legacyUserId) {
    try {
      const response = await fetch("/api/save-telegram-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: legacyToken, userId: legacyUserId })
      });
      if (response.ok) {
        localStorage.removeItem("tgToken");
        localStorage.removeItem("tgUserId");
      }
    } catch (_) {}
  }
}

async function loadTelegramSettings() {
  if (location.protocol === "file:") return;
  try {
    const res = await fetch("/api/telegram-status", { cache: "no-store" });
    const data = await readJsonResponse(res, "telegram");
    if (!res.ok) throw serviceError("telegram");
    const tokenInput = $("#tgBotTokenInput");
    const userIdInput = $("#tgUserIdInput");
    const badge = $("#tgBotStatusBadge");
    if (userIdInput && data.userId) userIdInput.value = data.userId;
    if (tokenInput && data.hasToken && !tokenInput.value) {
      tokenInput.placeholder = "Kayıtlı — değiştirmek için yeni token girin";
    }
    aiSecretStatus = { hasGeminiKey: Boolean(data.hasGeminiKey), loaded: true };
    if (badge) {
      badge.style.display = "inline-block";
      if (data.active && data.hasGeminiKey) {
        badge.className = "status-badge active";
        badge.style.background = "";
        badge.style.color = "";
        badge.style.borderColor = "";
        badge.textContent = "Bağlı · aktif";
      } else if (data.active && !data.hasGeminiKey) {
        badge.className = "status-badge active";
        badge.style.background = "rgba(234, 179, 8, 0.15)";
        badge.style.color = "#eab308";
        badge.style.borderColor = "rgba(234, 179, 8, 0.3)";
        badge.textContent = "Uyarı · Gemini anahtarı eksik";
      } else {
        badge.className = "status-badge inactive";
        badge.style.background = "";
        badge.style.color = "";
        badge.style.borderColor = "";
        badge.textContent = "Yapılandırılmadı";
      }
    }
  } catch (_) {}
}


async function saveTelegramSettings() {
  const token = $("#tgBotTokenInput")?.value?.trim() || "";
  const userId = $("#tgUserIdInput")?.value?.trim() || "";
  const status = $("#tgSettingsStatus");

  if (!token && !userId) {
    if (status) { status.textContent = "Lütfen token ve kullanıcı ID girin."; status.style.color = "var(--red)"; }
    return;
  }

  try {
    const res = await fetch("/api/save-telegram-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, userId })
    });
    const payload = await readJsonResponse(res, "telegram");
    if (res.ok) {
      if (status) {
        status.textContent = payload.recoveredPreviousConfig
          ? "✓ Telegram ayarı kaydedildi. Önceki okunamayan şifreli dosya yedeğe ayrıldı; SEC/Gemini ayarlarını yeniden girin."
        : "✓ Telegram ayarları kaydedildi ve güvenli webhook etkinleştirildi!";
        status.style.color = payload.recoveredPreviousConfig ? "var(--yellow)" : "var(--green)";
        setTimeout(() => { if (status) status.textContent = ""; }, payload.recoveredPreviousConfig ? 9000 : 4000);
      }
      showToast(payload.recoveredPreviousConfig ? "Şifreli ayarlar onarıldı; Telegram kaydedildi." : "Telegram bot ayarları kaydedildi.");
      localStorage.removeItem("tgToken");
      localStorage.removeItem("tgUserId");
      if ($("#tgBotTokenInput")) $("#tgBotTokenInput").value = "";
      loadTelegramSettings();
    } else {
      throw serviceError("telegram");
    }
  } catch (err) {
    const message = friendlyError("telegram", err);
    if (status) { status.textContent = message; status.style.color = "var(--red)"; }
    showServiceError("telegram", { retry: saveTelegramSettings });
  }
}


async function refreshTechnicalAlertStatuses(notify = false) {
  const symbols = [...new Set(state.technicalAlerts.map(alert => alert.symbol))];
  await Promise.all(symbols.map(async symbol => {
    try {
      const points = await getTechnicalHistory(symbol, "6mo");
      const metrics = getTechnicalMetrics(points);
      evaluateTechnicalAlerts(symbol, metrics, notify);
      if (technicalView.symbol === symbol && !technicalView.loading) renderTechnicalAnalysis();
    } catch { /* Price refresh must not fail because an optional alert cannot be evaluated. */ }
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// PORTFÖY DAĞILIMI (PASTA GRAFİK & KATEGORİLER)
// ═══════════════════════════════════════════════════════════════════════════════

const ALLOC_COLORS = [
  "#8e77ff", "#55d694", "#f2c45c", "#59b0ec", "#e66773",
  "#a799ff", "#34d399", "#fbbf24", "#38bdf8", "#f43f5e"
];

function getHoldingAssetClass(h) {
  const symbol = (h.symbol || "").toUpperCase();
  const name = (h.name || "").toLowerCase();
  if (symbol === "VOO" || symbol === "QQQ" || symbol === "SPY" || name.includes("etf") || name.includes("fon")) {
    return "ETF / Borsa Yatırım Fonu";
  }
  if (h.market === "BIST" || symbol.endsWith(".IS")) return "BİST Hisseleri";
  if (h.market === "ABD" || h.currency === "USD") return "ABD Hisseleri";
  return "Diğer Hisseler";
}

function getHoldingSector(h) {
  const symbol = (h.symbol || "").toUpperCase();
  if (symbol === "THYAO.IS" || symbol === "PGSUS.IS") return "Havacılık & Ulaşım";
  if (symbol === "ASTOR.IS" || symbol === "EUPWR.IS" || symbol === "KONTR.IS") return "Enerji & Sanayi";
  if (symbol === "NVDA" || symbol === "AAPL" || symbol === "MSFT" || symbol === "AMD") return "Teknoloji & Yarı İletken";
  if (symbol === "VOO" || symbol === "QQQ" || symbol === "SPY") return "Endeks & Fon";
  if (symbol.includes("AKBNK") || symbol.includes("GARAN") || symbol.includes("ISCTR")) return "Finans & Bankacılık";
  if (h.market === "BIST") return "BİST Diğer Sektörler";
  if (h.market === "ABD") return "ABD Diğer Sektörler";
  return "Genel Sektörler";
}

function renderAllocation(data) {
  const svg = document.getElementById("allocationPieSvg");
  const listEl = document.getElementById("allocationList");
  if (!svg || !listEl) return;

  // Mod butonlarının aktifliğini güncelle
  const buttons = document.querySelectorAll("#allocationModeGroup button[data-alloc-mode]");
  buttons.forEach(btn => btn.classList.toggle("active", btn.dataset.allocMode === allocationMode));

  const totalVal = Math.max(data.holdingsValue, 1);
  const groups = new Map();

  // Açık pozisyonları grupla. Para yatırma/çekme kayıtları dağılıma girmez.
  data.holdings.forEach(h => {
    const val = baseValue(h.value, h.currency);
    let key = "Diğer";
    if (allocationMode === "assetClass") {
      key = getHoldingAssetClass(h);
    } else if (allocationMode === "sector") {
      key = getHoldingSector(h);
    } else if (allocationMode === "currency") {
      key = h.currency === "TRY" ? "Türk Lirası (TRY)" : "Amerikan Doları (USD)";
    }
    groups.set(key, (groups.get(key) || 0) + val);
  });

  const sorted = [...groups.entries()].sort((a, b) => b[1] - a[1]);

  if (!sorted.length) {
    svg.innerHTML = `<circle cx="100" cy="100" r="70" fill="none" stroke="#2a3040" stroke-width="26"/>`;
    listEl.innerHTML = `<div class="empty-state">Henüz açık pozisyon yok.</div>`;
    $("#allocCenterVal").textContent = "—";
    return;
  }

  $("#allocCenterVal").textContent = formatMoney(data.holdingsValue);
  const subtitleMap = {
    assetClass: "Varlık türlerine göre dağılım",
    sector: "Sektörel yoğunlaşma ve ağırlıklar",
    currency: "Para birimi bazlı maruziyet"
  };
  if ($("#allocationSubtitle")) $("#allocationSubtitle").textContent = subtitleMap[allocationMode] || "Portföy ağırlıkları";

  // Pasta Grafiği (Donut SVG: r=65, cx=100, cy=100, çevre = 2 * PI * 65 ≈ 408.4)
  const radius = 65;
  const circumference = 2 * Math.PI * radius;
  let accumulatedAngle = 0;

  const svgPaths = sorted.map(([name, val], idx) => {
    const pct = val / totalVal;
    const dashLength = pct * circumference;
    const gapLength = circumference - dashLength;
    const strokeColor = ALLOC_COLORS[idx % ALLOC_COLORS.length];
    const strokeOffset = -accumulatedAngle * circumference;
    accumulatedAngle += pct;

    return `<circle class="allocation-slice" cx="100" cy="100" r="${radius}"
      fill="none"
      stroke="${strokeColor}"
      stroke-width="24"
      stroke-dasharray="${dashLength.toFixed(2)} ${gapLength.toFixed(2)}"
      stroke-dashoffset="${strokeOffset.toFixed(2)}">
      <title>${escapeHtml(name)}: ${formatMoney(val)} (%${(pct * 100).toFixed(1)})</title>
    </circle>`;
  }).join("");

  svg.innerHTML = svgPaths;

  // Liste Görünümü
  listEl.innerHTML = sorted.map(([name, val], idx) => {
    const pct = (val / totalVal) * 100;
    const color = ALLOC_COLORS[idx % ALLOC_COLORS.length];
    return `
      <div class="alloc-item-row" title="${escapeHtml(name)}: %${pct.toFixed(1)}">
        <div class="alloc-item-left">
          <span class="alloc-dot" style="background:${color}"></span>
          <span class="alloc-name">${escapeHtml(name)}</span>
        </div>
        <div class="alloc-item-right">
          <span class="alloc-val">${formatMoney(val)}</span>
          <span class="alloc-pct-badge">%${pct.toFixed(1)}</span>
        </div>
      </div>
    `;
  }).join("");
}

// ═══════════════════════════════════════════════════════════════════════════════
// AYALIK & OTOMATİK AI ROLÜ VE RAPOR KARTI
// ═══════════════════════════════════════════════════════════════════════════════

function renderExecutiveReport(data) {
  const el = document.getElementById("executiveReportContent");
  if (!el) return;

  const monthReturnPct = getUserPeriodReturn("1m", data);
  const hasMonthlyReturn = Number.isFinite(monthReturnPct);

  // 1. En çok katkı sağlayan hisse
  let bestHolding = null;
  let bestHoldingImpact = -Infinity;
  data.holdings.forEach(h => {
    const val = baseValue(h.value, h.currency);
    const pnlVal = baseValue(h.pnl, h.currency);
    if (pnlVal > bestHoldingImpact) {
      bestHoldingImpact = pnlVal;
      bestHolding = h;
    }
  });

  // 2. Ağırlıklı Sınıf Yoğunlaşması
  const assetClassMap = new Map();
  data.holdings.forEach(h => {
    const cls = getHoldingAssetClass(h);
    const val = baseValue(h.value, h.currency);
    assetClassMap.set(cls, (assetClassMap.get(cls) || 0) + val);
  });
  const sortedClasses = [...assetClassMap.entries()].sort((a, b) => b[1] - a[1]);
  const topClass = sortedClasses[0];
  const topClassPct = topClass ? (topClass[1] / Math.max(data.totalValue, 1)) * 100 : 0;

  // Mini Kartlar
  const monthClass = hasMonthlyReturn ? (monthReturnPct >= 0 ? "positive" : "negative") : "";
  const monthSign = hasMonthlyReturn && monthReturnPct >= 0 ? "+" : "";

  const bestStockText = bestHolding
    ? `${bestHolding.symbol} (${signedMoney(bestHoldingImpact)})`
    : "Henüz pozisyon yok";

  const topAllocText = topClass
    ? `${topClass[0]} (%${topClassPct.toFixed(0)})`
    : "—";

  // Otomatik Analiz Cümlesi
  let reportSentence = "";
  if (!hasMonthlyReturn) {
    reportSentence = "Aylık performans için henüz yeterli günlük portföy geçmişi yok. Kayıtlar fiyat yenilemeleriyle otomatik oluşur.";
  } else if (monthReturnPct >= 2) {
    reportSentence = `Bu ay portföyün <strong>%${monthReturnPct.toFixed(1)}</strong> değer kazandı. Katkıda başı <strong>${bestHolding ? bestHolding.symbol : 'varlıklarınız'}</strong> çekti.`;
  } else if (monthReturnPct <= -2) {
    reportSentence = `Bu ay portföyün <strong>%${Math.abs(monthReturnPct).toFixed(1)}</strong> geriledi. En dayanıklı grup <strong>${topClass ? topClass[0] : 'diğer varlıklar'}</strong> oldu.`;
  } else {
    reportSentence = `Portföyün son 1 ayda <strong>%${monthReturnPct.toFixed(1)}</strong> ile yatay/dengeli bir seyir izledi.`;
  }

  let riskNote = "";
  if (topClassPct > 45) {
    riskNote = `Portföyünün <strong>%${topClassPct.toFixed(0)}</strong> kadarı <strong>${topClass[0]}</strong> grubunda toplanmış. Çeşitlendirme gözden geçirilebilir.`;
  } else {
    riskNote = `Portföy dağılımın varlık sınıfları arasında makul düzeyde dengelenmiş görünüyor.`;
  }

  el.innerHTML = `
    <div class="exec-cards-grid">
      <div class="exec-mini-card">
        <div class="exec-card-lbl">Son 1 aylık getiri</div>
        <div class="exec-card-val ${monthClass}">${hasMonthlyReturn ? `${monthSign}%${Math.abs(monthReturnPct).toFixed(1)}` : "—"}</div>
        <div class="exec-card-sub">${hasMonthlyReturn ? "Nakit akışlarından arındırılmış getiri" : "En az 1 aylık günlük kayıt gerekli"}</div>
      </div>
      <div class="exec-mini-card">
        <div class="exec-card-lbl">En çok katkı sağlayan</div>
        <div class="exec-card-val">${escapeHtml(bestStockText)}</div>
        <div class="exec-card-sub">${bestHolding ? `Toplam K/Z: ${signedPercent(bestHolding.pnlPct)}` : 'İşlem ekleyin'}</div>
      </div>
      <div class="exec-mini-card">
        <div class="exec-card-lbl">Ağırlıklı varlık grubu</div>
        <div class="exec-card-val">${escapeHtml(topAllocText)}</div>
        <div class="exec-card-sub">Toplam ${sortedClasses.length} farklı varlık türü</div>
      </div>
    </div>

    <div class="exec-summary-box">
      <div>İçgörü · ${reportSentence}</div>
      <div class="exec-action-item">
        <span>⚖️ <strong>Çeşitlendirme Yorumu:</strong> ${riskNote}</span>
      </div>
    </div>
  `;
}

const PERFORMANCE_RANGE_LABELS = { "1m": "1 ay", "3m": "3 ay", "6m": "6 ay", ytd: "Yıl başından", "1y": "1 yıl", all: "Tüm geçmiş" };

function performanceRangeStart(range, now = new Date()) {
  if (range === "1m") return Core.localDateISO(calendarMonthsAgo(1, now));
  if (range === "3m") return Core.localDateISO(calendarMonthsAgo(3, now));
  if (range === "6m") return Core.localDateISO(calendarMonthsAgo(6, now));
  if (range === "ytd") return Core.localDateISO(new Date(now.getFullYear(), 0, 1));
  if (range === "1y") return Core.localDateISO(calendarYearsAgo(1, now));
  return null;
}

function portfolioPerformanceSnapshots() {
  return Core.selectPerformanceSnapshots(state).snapshots;
}

function performancePercent(value) {
  return Number.isFinite(value) ? signedPercent(value) : "—";
}

function performanceMoney(value, signed = false) {
  if (!Number.isFinite(value)) return "—";
  const amount = formatMoney(signed ? Math.abs(value) : value, state.settings.baseCurrency,
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return signed ? `${value >= 0 ? "+" : "−"}${amount}` : amount;
}

function performanceDate(value) {
  return new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${value}T12:00:00`));
}

function performanceStat(label, value, detail = "", tone = "") {
  return `<article class="performance-stat"><span>${label}</span><strong class="${tone}">${value}</strong><small>${detail}</small></article>`;
}

function hideTimelineTooltip(prefix) {
  const tooltip = $(`#${prefix}ChartTooltip`);
  if (tooltip) tooltip.hidden = true;
  $(`#${prefix}ChartHover`)?.setAttribute("visibility", "hidden");
}

function hidePortfolioChartTooltip() { hideTimelineTooltip("portfolio"); }

function performancePointSource(point, prefix = "portfolio") {
  if (!Number.isFinite(prefix === "profit" ? point.totalPnl : point.value)) return point.reason || "Bu gün için veri yok.";
  if (point.valuationSource === "historical-close") {
    const original = point.recordedUnverified ? `Eski kayıt (${performanceMoney(point.recordedValue)}) pozisyon dökümü içermediğinden yeniden hesaplandı. `
      : point.positionMismatch ? "İşlem adetleri değiştiği için yeniden hesaplandı. " : "";
    const allocations = (point.ipoValuations || []).map(item => `${item.symbol}: işlem başlangıcından (${performanceDate(item.firstTradeDate)}) önce halka arz alış fiyatı ${formatMoney(item.price, item.currency, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`).join("; ");
    return `${original}${point.priceDates?.length ? `Kullanılan kapanışlar: ${point.priceDates.join("; ")}. ` : ""}${allocations ? `${allocations}. ` : ""}${point.fxDate ? `Kur tarihi: ${point.fxDate}.` : ""}`.trim() || "Açık pozisyon yok.";
  }
  if (prefix === "profit" && point.profitSource === "historical-fx") return `${performanceDate(point.fxDate)} USD/TRY kapanış kuruyla yeniden hesaplandı (${formatNumber(point.fxUsdTry, 4)}).`;
  return point.valuationVerified ? "O gün kaydedilen portföy değeri; işlem adetleri kayıtla eşleşiyor." : "Eski günlük kayıt: o günün pozisyon dökümü yok; doğruluğu işlem adetleriyle teyit edilemiyor.";
}

function showTimelinePoint(prefix, view, index) {
  const rendered = view.rendered;
  if (!rendered?.points[index]) return;
  const point = rendered.points[index], coord = rendered.coords[index];
  const svg = $(`#${prefix}Chart`), tooltip = $(`#${prefix}ChartTooltip`);
  view.activeIndex = index;
  const line = $(`#${prefix}ChartHoverLine`), dot = $(`#${prefix}ChartHoverDot`);
  const xPosition = rendered.xs[index];
  if (!line || !dot) return;
  line.setAttribute("x1", xPosition); line.setAttribute("x2", xPosition);
  dot.setAttribute("visibility", coord ? "visible" : "hidden");
  if (coord) { dot.setAttribute("cx", coord.x); dot.setAttribute("cy", coord.y); }
  $(`#${prefix}ChartHover`).setAttribute("visibility", "visible");
  let detail = `<strong>Bu gün için veri yok</strong>`;
  if (prefix === "portfolio" && Number.isFinite(point.value)) {
    detail = `<strong>${performanceMoney(point.value)}</strong><small>İlk güne göre ${performancePercent(point.returnPct)}</small><small>Önceki güne göre ${point.dailyChange === null ? "—" : performanceMoney(point.dailyChange, true)} · ${performancePercent(point.dailyReturnPct)}</small>`;
  } else if (prefix === "profit" && Number.isFinite(point.totalPnl)) {
    detail = `<strong>Toplam ${performanceMoney(point.totalPnl, true)}</strong><small>Açık ${performanceMoney(point.unrealizedPnl, true)} · Kapalı ${performanceMoney(point.realizedPnl, true)}</small>`;
  }
  tooltip.innerHTML = `<span>${performanceDate(point.date)}</span>${detail}<small class="timeline-source">${escapeHtml(performancePointSource(point, prefix))}</small>`;
  tooltip.hidden = false;
  const rect = svg.getBoundingClientRect(), wrap = svg.parentElement, wrapRect = wrap.getBoundingClientRect();
  const tooltipWidth = Math.min(265, Math.max(170, wrapRect.width - 24));
  const pixelX = xPosition / rendered.width * rect.width + rect.left - wrapRect.left;
  tooltip.style.width = `${tooltipWidth}px`;
  tooltip.style.left = `${wrap.scrollLeft + Math.max(8, Math.min(wrapRect.width - tooltipWidth - 8, pixelX + (pixelX > wrapRect.width / 2 ? -tooltipWidth - 14 : 14)))}px`;
  tooltip.style.top = "8px";
}

function renderTimeline(prefix, view, points, field, options = {}) {
  const svg = $(`#${prefix}Chart`);
  if (!svg) return;
  hideTimelineTooltip(prefix);
  if (!svg.dataset.interactionBound) {
    svg.dataset.interactionBound = "true";
    const showNearest = event => {
      if (!view.rendered) return;
      const rect = svg.getBoundingClientRect();
      const x = (event.clientX - rect.left) / Math.max(rect.width, 1) * view.rendered.width;
      const nearest = view.rendered.xs.reduce((best, value, index, xs) => Math.abs(value - x) < Math.abs(xs[best] - x) ? index : best, 0);
      if (nearest !== view.activeIndex || $(`#${prefix}ChartTooltip`).hidden) showTimelinePoint(prefix, view, nearest);
    };
    svg.addEventListener("pointermove", showNearest);
    svg.addEventListener("click", showNearest);
    svg.addEventListener("pointerleave", () => hideTimelineTooltip(prefix));
    svg.addEventListener("blur", () => hideTimelineTooltip(prefix));
    svg.addEventListener("focus", () => { if (view.rendered) showTimelinePoint(prefix, view, view.rendered.points.length - 1); });
    svg.addEventListener("keydown", event => {
      if (!view.rendered || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      let index = Math.max(0, view.activeIndex);
      if (event.key === "Home") index = 0;
      if (event.key === "End") index = view.rendered.points.length - 1;
      if (event.key === "ArrowLeft") index = Math.max(0, index - 1);
      if (event.key === "ArrowRight") index = Math.min(view.rendered.points.length - 1, index + 1);
      showTimelinePoint(prefix, view, index);
    });
  }
  const seriesValues = points.map(point => point[field]).filter(Number.isFinite);
  const containerWidth = Math.floor(svg.parentElement.getBoundingClientRect().width) || 640;
  const left = containerWidth < 500 ? 82 : 96, right = 28, top = 32, bottom = 48, height = 310;
  const width = Math.max(340, containerWidth, points.length <= 62 ? points.length * 28 + left + right : containerWidth);
  svg.style.width = `${width}px`;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  if (!seriesValues.length) {
    view.rendered = null;
    const message = field === "returnPct" && points.some(point => point.value === 0) ? "Başlangıç değeri sıfır; yüzde hesaplanamaz"
      : performanceHistoryLoad.loading ? "Geçmiş fiyatlar ve kurlar alınıyor…"
      : prefix === "profit" ? "Kâr geçmişi için fiyat veya kur bilgisi gerekiyor" : "Bu dönem için değer kaydı bulunamadı";
    svg.setAttribute("aria-label", message);
    svg.innerHTML = `<text class="chart-empty-title" x="${width/2}" y="135" text-anchor="middle">${message}</text><text class="chart-empty-copy" x="${width/2}" y="160" text-anchor="middle">${performanceHistoryLoad.loading ? "Kayıtlar geldikçe grafik tamamlanacak." : "Geçmişi tamamla düğmesiyle yeniden deneyebilirsin."}</text>`;
    return;
  }
  const guides = (Array.isArray(options.guides) ? options.guides : []).filter(guide => Number.isFinite(Number(guide?.value)));
  const values = [...seriesValues, ...guides.map(guide => Number(guide.value))];
  const rawMin = Math.min(...values), rawMax = Math.max(...values);
  const padding = Math.max((rawMax - rawMin) * .16, field === "returnPct" ? .5 : Math.max(Math.abs(rawMax) * .02, 1));
  const min = rawMin - padding, max = rawMax + padding;
  const firstTime = Date.parse(points[0].date), lastTime = Date.parse(points.at(-1).date);
  const xFor = date => firstTime === lastTime ? (left + width - right) / 2 : left + (Date.parse(date) - firstTime) / (lastTime - firstTime) * (width - left - right);
  const yFor = value => top + (max - value) / (max - min) * (height - top - bottom);
  const xs = points.map(point => xFor(point.date));
  const coords = points.map((point, index) => Number.isFinite(point[field]) ? { x: xs[index], y: yFor(point[field]) } : null);
  const axis = value => field === "returnPct" ? `${formatNumber(value, 1)}%` : formatMoney(value, state.settings.baseCurrency, { maximumFractionDigits: 0 });
  let grids = "";
  for (let i = 0; i <= 4; i++) {
    const value = min + i / 4 * (max - min), y = yFor(value);
    grids += `<line class="chart-grid" x1="${left}" x2="${width - right}" y1="${y}" y2="${y}"/><text class="chart-axis-label" x="${left - 10}" y="${y + 4}" text-anchor="end">${escapeHtml(axis(value))}</text>`;
  }
  const path = Core.smoothTimelinePath(coords);
  const color = (prefix === "profit" ? seriesValues.at(-1) : seriesValues.at(-1) - seriesValues[0]) >= 0 ? "var(--green)" : "var(--red)";
  const segments = []; let segment = [];
  for (const coord of [...coords, null]) {
    if (coord) segment.push(coord);
    else if (segment.length) { segments.push(segment); segment = []; }
  }
  const areas = segments.filter(part => part.length > 1).map(part => `<path d="${Core.smoothTimelinePath(part)} L${part.at(-1).x},${height-bottom} L${part[0].x},${height-bottom} Z" fill="url(#${prefix}TimelineFill)"/>`).join("");
  const tickIndexes = Core.timelineTickIndexes(points, width - left - right);
  const labels = tickIndexes.map(index => {
    const date = points[index].date;
    const fullLabel = performanceDate(date).replace(/ \d{4}$/, "");
    const label = String(Number(date.slice(8)));
    const month = points.length > 62 || index === 0 || date.slice(8) === "01" || date.slice(8) === "31" ? `<tspan x="${xs[index]}" dy="13">${fullLabel.split(" ")[1]}</tspan>` : "";
    return `<line class="timeline-tick" x1="${xs[index]}" x2="${xs[index]}" y1="${height-bottom+4}" y2="${height-bottom+8}"/><text class="chart-axis-label timeline-date${coords[index] ? "" : " missing"}" x="${xs[index]}" y="${height - 25}" text-anchor="middle"><title>${performanceDate(date)}</title>${label}${month}</text>`;
  }).join("");
  const zero = min <= 0 && max >= 0 ? `<line class="chart-baseline" x1="${left}" x2="${width-right}" y1="${yFor(0)}" y2="${yFor(0)}"/>` : "";
  const referenceLines = guides.map(guide => {
    const y = yFor(Number(guide.value));
    const labelY = Math.max(top + 12, Math.min(height - bottom - 7, y - 7));
    return `<line class="timeline-reference ${escapeHtml(guide.tone || "base")}" x1="${left}" x2="${width-right}" y1="${y}" y2="${y}"/><text class="timeline-reference-label ${escapeHtml(guide.tone || "base")}" x="${left+8}" y="${labelY}">${escapeHtml(guide.label || axis(Number(guide.value)))}</text>`;
  }).join("");
  const dots = coords.map((coord, index) => {
    if (!coord) return `<circle class="timeline-missing-dot" cx="${xs[index]}" cy="${height-bottom+6}" r="2"><title>${performanceDate(points[index].date)}: veri yok</title></circle>`;
    const calculated = points[index].valuationSource === "historical-close" || (prefix === "profit" && points[index].profitSource === "historical-fx");
    return `<circle class="timeline-dot${calculated ? " calculated" : ""}" cx="${coord.x}" cy="${coord.y}" r="${seriesValues.length === 1 ? 5 : 3}" fill="${calculated ? "var(--surface)" : color}" stroke="${color}"><title>${performanceDate(points[index].date)}: ${escapeHtml(axis(points[index][field]))} · ${escapeHtml(performancePointSource(points[index], prefix))}</title></circle>`;
  }).join("");
  const onlyIndex = seriesValues.length === 1 ? coords.findIndex(Boolean) : -1;
  const singleton = onlyIndex >= 0 ? `<text class="timeline-single-value" x="${Math.max(left+65, Math.min(width-right-65, coords[onlyIndex].x))}" y="${coords[onlyIndex].y-20}" text-anchor="middle">${escapeHtml(axis(seriesValues[0]))}</text>` : "";
  svg.setAttribute("aria-label", `${prefix === "profit" ? "Kâr / zarar" : "Portföy değeri"}: ${points.length} takvim günü, ${seriesValues.length} değer. ${performanceDate(points[0].date)} – ${performanceDate(points.at(-1).date)}.`);
  svg.innerHTML = `<defs><linearGradient id="${prefix}TimelineFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity=".22"/><stop offset="100%" stop-color="${color}" stop-opacity=".01"/></linearGradient></defs>${grids}${zero}${referenceLines}<g class="timeline-curve">${areas}<path class="portfolio-chart-line" d="${path}" style="stroke:${color}"/>${dots}</g>${singleton}${labels}<g id="${prefix}ChartHover" visibility="hidden"><line id="${prefix}ChartHoverLine" class="portfolio-hover-line" y1="${top}" y2="${height-bottom}"/><circle id="${prefix}ChartHoverDot" class="portfolio-hover-dot" r="5"/></g>`;
  view.rendered = { points, coords, xs, width, height };
  view.activeIndex = -1;
}

function updatePerformanceHistoryStatus() {
  const status = $("#performanceHistoryStatus"), button = $("#completePerformanceHistory");
  if (button) { button.disabled = performanceHistoryLoad.loading; button.textContent = performanceHistoryLoad.loading ? "Geçmiş tamamlanıyor…" : "Geçmişi tamamla"; }
  if (status) {
    status.textContent = performanceHistoryLoad.loading ? `Geçmiş fiyatlar ve kurlar alınıyor · ${performanceHistoryLoad.completed}/${performanceHistoryLoad.total}`
      : performanceHistoryLoad.errors.length ? `Bazı geçmiş veriler alınamadı: ${performanceHistoryLoad.errors.join(", ")}. Yeniden deneyebilirsin.` : "";
    status.hidden = !status.textContent;
  }
}

async function completePerformanceHistory(force = false) {
  if (performanceHistoryLoad.loading || state.isDemo || location.protocol === "file:") return;
  const snapshots = portfolioPerformanceSnapshots();
  if (!snapshots.length) return;
  const calendar = Core.performanceCalendar(state, snapshots, performanceMarketHistory, { throughDate: today() });
  const symbols = new Set();
  if (calendar.some(point => point.valuationSource !== "recorded")) {
    const end = today();
    state.transactions.filter(tx => !tx.demo && tx.date <= end && Core.ASSET_TYPES.has(tx.type)).forEach(tx => symbols.add(tx.symbol));
  }
  const requiresFx = state.transactions.some(tx => Core.ASSET_TYPES.has(tx.type) && tx.currency !== state.settings.baseCurrency)
    || state.closedPositions.some(position => (position.currency || "TRY") !== state.settings.baseCurrency);
  if (requiresFx && (calendar.some(point => point.valuationSource !== "recorded") || snapshots.some(point => !(Number(point.fxUsdTry) > 0)))) symbols.add("USDTRY=X");
  if (!symbols.size) return;
  const age = (Date.now() - Date.parse(snapshots[0].date)) / 86400000;
  const period = age < 170 ? "6mo" : age < 350 ? "1y" : age < 710 ? "2y" : age < 1800 ? "5y" : "max";
  const symbolList = [...symbols].filter(Boolean).sort();
  const key = `${today()}|${period}|${symbolList.join(",")}`;
  if (!force && performanceHistoryLoad.key === key) return;
  performanceHistoryLoad.key = key;
  const periods = ["6mo", "1y", "2y", "5y", "max"];
  const requests = force ? symbolList : symbolList.filter(symbol => !performanceMarketHistory[symbol]
    || performanceHistoryLoadedOn[symbol] !== today()
    || periods.indexOf(performanceHistoryPeriods[symbol]) < periods.indexOf(period));
  if (!requests.length) return;
  Object.assign(performanceHistoryLoad, { loading: true, errors: [], completed: 0, total: requests.length });
  updatePerformanceHistoryStatus();
  let next = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(4, requests.length) }, async () => {
      while (next < requests.length) {
        const symbol = requests[next++];
        try {
          const response = await fetch(`/api/history?symbol=${encodeURIComponent(symbol)}&period=${period}`, { cache: "no-store", signal: AbortSignal.timeout(20000) });
          if (!response.ok) throw new Error("history");
          const payload = await response.json();
          if (payload.symbol !== symbol || !Array.isArray(payload.points) || !payload.points.length) throw new Error("history");
          performanceMarketHistory[symbol] = { points: payload.points, firstTradeDate: payload.firstTradeDate };
          performanceHistoryPeriods[symbol] = period;
          performanceHistoryLoadedOn[symbol] = today();
        } catch (_) { performanceHistoryLoad.errors.push(symbol); }
        finally { performanceHistoryLoad.completed++; updatePerformanceHistoryStatus(); }
      }
    }));
  } finally {
    performanceHistoryLoad.loading = false;
    updatePerformanceHistoryStatus();
    renderChart();
  }
}

function renderChart() {
  const { snapshots: allSnapshots, excluded } = Core.selectPerformanceSnapshots(state);
  const cutoff = performanceRangeStart(portfolioChartView.range);
  const snapshots = cutoff ? allSnapshots.filter(snapshot => snapshot.date >= cutoff) : allSnapshots;
  const fullCalendar = Core.performanceCalendar(state, allSnapshots, performanceMarketHistory, { throughDate: today() });
  const statusPoints = Core.buildValueSeries(fullCalendar).filter(point => Number.isFinite(point.value));
  const calendar = Core.performanceCalendar(state, allSnapshots, performanceMarketHistory, { fromDate: cutoff, throughDate: today() });
  const points = Core.buildValueSeries(calendar);
  const first = points.find(point => Number.isFinite(point.value)), last = points.findLast(point => Number.isFinite(point.value));
  const nowPoint = statusPoints.at(-1);
  const previousYear = new Date().getFullYear() - 1;
  const previousYearEnd = `${previousYear}-12-31`;
  const previousYearClose = statusPoints.findLast(point => point.date <= previousYearEnd);
  const athPoint = statusPoints.reduce((best, point) => !best || point.value > best.value ? point : best, null);
  const yearChange = nowPoint && previousYearClose && previousYearClose.value !== 0 ? (nowPoint.value / previousYearClose.value - 1) * 100 : null;
  const yearChangeAmount = nowPoint && previousYearClose ? nowPoint.value - previousYearClose.value : null;
  const athDistance = nowPoint && athPoint?.value ? (nowPoint.value / athPoint.value - 1) * 100 : null;
  $("#performanceSummary").innerHTML = nowPoint ? [
    performanceStat("Şimdi", performanceMoney(nowPoint.value), performanceDate(nowPoint.date)),
    performanceStat(`${previousYear} kapanışı`, previousYearClose ? performanceMoney(previousYearClose.value) : "—", previousYearClose ? performanceDate(previousYearClose.date) : "Bu tarihte portföy kaydı yok"),
    performanceStat("Değişim", Number.isFinite(yearChangeAmount) ? performanceMoney(yearChangeAmount, true) : "—", performancePercent(yearChange), Number.isFinite(yearChangeAmount) ? typeClass(yearChangeAmount) : ""),
    performanceStat("ATH'den uzaklık", performancePercent(athDistance), athPoint ? `${performanceMoney(athPoint.value)} · ${performanceDate(athPoint.date)}` : "—", Number.isFinite(athDistance) ? typeClass(athDistance) : "")
  ].join("") : ["Şimdi", `${previousYear} kapanışı`, "Değişim", "ATH'den uzaklık"].map(label => performanceStat(label, "—")).join("");
  $$("#portfolioChartModeGroup [data-chart-mode]").forEach(button => {
    const active = button.dataset.chartMode === portfolioChartView.mode;
    button.classList.toggle("active", active); button.setAttribute("aria-pressed", active);
  });
  $$("#portfolioChartRangeGroup [data-chart-range]").forEach(button => {
    const active = button.dataset.chartRange === portfolioChartView.range;
    button.classList.toggle("active", active); button.setAttribute("aria-pressed", active);
  });
  const portfolioGuides = portfolioChartView.mode === "value" ? [
    athPoint ? { value: athPoint.value, label: `ATH · ${performanceMoney(athPoint.value)}`, tone: "ath" } : null,
    previousYearClose ? { value: previousYearClose.value, label: `${previousYear} kapanışı`, tone: "base" } : null
  ].filter(Boolean) : [];
  renderTimeline("portfolio", portfolioChartView, points, portfolioChartView.mode === "return" ? "returnPct" : "value", { guides: portfolioGuides });
  const reconstructed = points.filter(point => point.valuationSource === "historical-close").length;
  const missing = points.filter(point => !Number.isFinite(point.value)).length;
  $("#portfolioChartDuration").textContent = `${points.length} gün · ${snapshots.length} kayıt`;
  $("#chartNote").textContent = `${PERFORMANCE_RANGE_LABELS[portfolioChartView.range]} · ${snapshots.length} kayıtlı gün${reconstructed ? ` · ${reconstructed} gün geçmiş kapanışlarla tamamlandı` : ""}${missing ? ` · ${missing} gün için veri bekleniyor` : ""}. ${portfolioChartView.mode === "value" ? `Kesikli çizgiler ATH ve ${previousYear} kapanışını gösterir. ` : ""}Çizginin yumuşatılması günlük değerleri değiştirmez.`;
  const legacy = points.filter(point => point.recordedUnverified && Number.isFinite(point.value)).length;
  $("#performanceDataNote").textContent = `Değer açık hisseleri ve işlem görmeyi bekleyen halka arzları içerir; nakit dahil değildir. Bu yüzde ilk güne göre değer değişimidir; alım/satım ve kur hareketlerinden etkilenir. Pozisyon dökümü olmayan veya işlem adetleri değişmiş eski günler tarihi fiyatlarla yeniden hesaplanır. İşlem görmeye başlamamış halka arzlar alış fiyatıyla değerlenir. İşlem başladıktan sonra eksik fiyat için en fazla 7 gün önceki kapanış kullanılır; tarihleri noktaya dokunarak görebilirsin.${excluded ? ` ${excluded} kapsamı belirsiz, uyumsuz veya deneme kaydı kapsam dışında.` : ""}${legacy ? ` ${legacy} eski günlük değer yeniden hesaplandı; orijinal kayıtlar korunuyor.` : ""}`;
  $("#performanceDailyRows").innerHTML = points.length ? points.map(point => {
    const known = Number.isFinite(point.value);
    const source = point.valuationSource === "recorded" ? "Kayıtlı" : known ? (point.ipoValuations?.length ? "Kapanış + halka arz bedeli" : "Tarihi kapanış") : "Veri yok";
    return `<tr><td>${performanceDate(point.date)}</td><td class="number">${known ? performanceMoney(point.value) : "—"}</td><td class="number">${point.dailyChange === null ? "—" : performanceMoney(point.dailyChange, true)}<small>${performancePercent(point.dailyReturnPct)}</small></td><td class="number">${known ? performanceMoney(point.value - first.value, true) : "—"}<small>${performancePercent(point.returnPct)}</small></td><td class="daily-source">${source}<small>${escapeHtml(performancePointSource(point))}</small></td></tr>`;
  }).join("") : `<tr><td colspan="5">Seçilen dönemde kayıt yok.</td></tr>`;
  const profitPoints = calendar.map(snapshot => ({ ...snapshot, ...Core.snapshotProfit(snapshot, state, performanceMarketHistory["USDTRY=X"]) }));
  const known = profitPoints.filter(point => Number.isFinite(point.totalPnl));
  const latest = profitPoints.at(-1), previous = profitPoints.at(-2);
  $("#profitSummary").innerHTML = latest && Number.isFinite(latest.totalPnl) ? [
    performanceStat("Toplam kâr / zarar", performanceMoney(latest.totalPnl, true), performanceDate(latest.date)),
    performanceStat("Açık pozisyonlar", performanceMoney(latest.unrealizedPnl, true), "Gerçekleşmemiş kâr / zarar"),
    performanceStat("Kapanmış pozisyonlar", performanceMoney(latest.realizedPnl, true), "O güne kadar gerçekleşmiş kâr / zarar"),
    performanceStat("Önceki güne göre", Number.isFinite(previous?.totalPnl) ? performanceMoney(latest.totalPnl - previous.totalPnl, true) : "—", previous ? performanceDate(previous.date) : "İkinci gün bekleniyor")
  ].join("") : ["Toplam kâr / zarar", "Açık pozisyonlar", "Kapanmış pozisyonlar", "Önceki güne göre"].map(label => performanceStat(label, "—")).join("");
  $$("[data-profit-mode]").forEach(button => {
    const active = button.dataset.profitMode === profitChartView.mode;
    button.classList.toggle("active", active); button.setAttribute("aria-pressed", active);
  });
  renderTimeline("profit", profitChartView, profitPoints, profitChartView.mode);
  $("#profitChartDuration").textContent = `${known.length} günlük değer`;
  const fxRestored = known.filter(point => point.profitSource === "historical-fx").length;
  $("#profitChartNote").textContent = `${PERFORMANCE_RANGE_LABELS[portfolioChartView.range]} · Açık kâr = hisse değeri − kalan maliyet. Toplam = açık kâr + gerçekleşmiş satış kârı; komisyon ve aile payı düşülür. Satışlar kendi tarihinden itibaren dahildir. Yabancı para sonuçları her günün kuruyla çevrilir; temettü bu grafiğe dahil değildir.${legacy ? ` ${legacy} eski gün, kayıtlı işlem adetleri ve tarihi fiyatlarla yeniden hesaplandı.` : ""}${fxRestored ? ` ${fxRestored} günde tarihi kapanış kuru kullanıldı.` : ""}${profitPoints.length > known.length ? ` ${profitPoints.length-known.length} gün için fiyat, kur veya işlem bilgisi eksik; Geçmişi tamamla ile yeniden deneyebilirsin.` : ""}`;
  updatePerformanceHistoryStatus();
  void completePerformanceHistory();
}


function updateDashboardGreeting() {
  if ($("#dashboardPage")?.classList.contains("active")) {
    $("#pageTitle").textContent = Core.greetingForUser(currentPortfolioUser || { username: state.settings.username });
  }
}

// The login layer can supply the active account without changing greeting logic.
window.setPortfolioUser = function(user) {
  currentPortfolioUser = user && typeof user === "object" ? user : null;
  updateDashboardGreeting();
};

function bindInformationButtons() {
  const dialog = $("#infoDialog"), title = $("#infoDialogTitle"), content = $("#infoDialogContent");
  $("#closeInfoDialog").addEventListener("click", () => dialog.close());
  document.addEventListener("click", event => {
    const button = event.target instanceof Element ? event.target.closest(".metric-help, .info-icon") : null;
    if (!button) return;
    event.preventDefault(); event.stopPropagation();
    const explanation = button.querySelector(".info-tooltip");
    title.textContent = explanation?.querySelector("strong")?.textContent || button.getAttribute("aria-label") || "Bilgi";
    if (explanation) content.innerHTML = explanation.innerHTML;
    else content.textContent = button.getAttribute("title") || button.dataset.help || "Bu gösterge için açıklama eklenmemiş.";
    dialog.showModal();
  }, true);
}


function getInsights(data) {
  if (!data.holdings.length) return ["<strong>İlk adım:</strong> İşlem ekleyerek portföyünü oluşturmaya başla.", "<strong>İpucu:</strong> Para yatırma ve çekme işlemlerini de kaydet; gerçek getiriyi ayırabilelim."];
  const largest = data.holdings[0];
  const largestPct = baseValue(largest.value, largest.currency) / Math.max(data.holdingsValue, 1) * 100;
  const delayed = data.holdings.filter(h => h.quote.delayed).length;
  return [
    `<strong>Konsantrasyon:</strong> ${largest.symbol}, yatırımlarının ${formatNumber(largestPct, 1)}%'ini oluşturuyor.`,
    `<strong>Günlük durum:</strong> Portföyün ${data.dayChange >= 0 ? "artıda" : "ekside"} · ${signedPercent(data.dayChangePct)}.`,
    delayed ? `<strong>Veri notu:</strong> ${delayed} BIST fiyatı gecikmeli örnek veri olarak işaretli.` : "<strong>Fiyat durumu:</strong> Tüm açık pozisyonlar için fiyat kaydı var."
  ];
}

function expenseMonthKey(date) {
  return /^\d{4}-\d{2}/.test(String(date || "")) ? String(date).slice(0, 7) : "";
}

function expenseAmountInTry(expense) {
  const amount = Number(expense?.amount) || 0;
  if (expense?.currency === "USD") return amount * (number(state.settings.fxUsdTry) || DEFAULT_FX);
  return amount;
}

function expenseMonthLabel(month, style = "long") {
  if (!/^\d{4}-\d{2}$/.test(String(month || ""))) return "—";
  const [year, monthNumber] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("tr-TR", { month: style, year: style === "long" ? "numeric" : undefined }).format(new Date(year, monthNumber - 1, 1));
}

function setExpenseMetric(selector, value) {
  const element = $(selector);
  if (!element || element.textContent === value) return;
  element.textContent = value;
}

function recentExpenseMonths(anchorMonth, count = 6) {
  const validAnchor = /^\d{4}-\d{2}$/.test(String(anchorMonth || "")) ? anchorMonth : today().slice(0, 7);
  const [year, month] = validAnchor.split("-").map(Number);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(year, month - count + index, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  });
}

function dominantExpenseMonth(expenses) {
  const counts = new Map();
  expenses.forEach(expense => {
    const month = expenseMonthKey(expense.date);
    if (month) counts.set(month, (counts.get(month) || 0) + 1);
  });
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || right[0].localeCompare(left[0]))[0]?.[0] || "";
}

function inferredExpenseStatementMonths(expenses) {
  const groups = new Map();
  expenses.forEach(expense => {
    if (/^\d{4}-\d{2}$/.test(String(expense.statementMonth || ""))) return;
    const statementName = String(expense.statementName || "").trim();
    if (!statementName) return;
    if (!groups.has(statementName)) groups.set(statementName, []);
    groups.get(statementName).push(expense);
  });
  return new Map([...groups].map(([statementName, records]) => [statementName, dominantExpenseMonth(records)]));
}

function expenseReportingMonth(expense, inferredMonths) {
  if (/^\d{4}-\d{2}$/.test(String(expense.statementMonth || ""))) return expense.statementMonth;
  const inferred = inferredMonths.get(String(expense.statementName || "").trim());
  return inferred || expenseMonthKey(expense.date);
}

function renderExpenseTrend(expenses, anchorMonth, inferredMonths) {
  const chart = $("#expenseTrendChart");
  if (!chart) return;
  const values = recentExpenseMonths(anchorMonth).map(month => {
    const records = expenses.filter(expense => expenseReportingMonth(expense, inferredMonths) === month);
    return {
      month,
      personal: records.filter(expense => !expense.family).reduce((sum, expense) => sum + expenseAmountInTry(expense), 0),
      family: records.filter(expense => expense.family).reduce((sum, expense) => sum + expenseAmountInTry(expense), 0)
    };
  });
  const maxTotal = Math.max(1, ...values.map(value => Math.max(0, value.personal + value.family)));
  chart.innerHTML = values.map((value, index) => {
    const personalWidth = Math.max(0, value.personal) / maxTotal * 100;
    const familyWidth = Math.max(0, value.family) / maxTotal * 100;
    const total = value.personal + value.family;
    return `<div class="expense-trend-row" style="--trend-index:${index}">
      <span>${escapeHtml(expenseMonthLabel(value.month, "short"))}</span>
      <div class="expense-trend-track" title="${escapeHtml(expenseMonthLabel(value.month))}: ${escapeHtml(formatMoney(total, "TRY", { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}">
        <i class="personal" style="width:${personalWidth}%"></i><i class="family" style="width:${familyWidth}%"></i>
      </div>
      <strong>${total ? formatMoney(total, "TRY", { maximumFractionDigits: 0 }) : "—"}</strong>
    </div>`;
  }).join("");
}

function expenseMedian(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function expenseMerchantKey(description) {
  return String(description || "").toLocaleLowerCase("tr-TR")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[ıİ]/g, "i").replace(/ş/g, "s").replace(/ğ/g, "g").replace(/ç/g, "c").replace(/ö/g, "o").replace(/ü/g, "u")
    .replace(/\b(sonradan|taksit|islemin|islemi|odemesi|odeme)\b/g, " ")
    .replace(/\b\d+[./-]?\d*\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim().split(" ").slice(0, 5).join(" ");
}

function analyzeExpenseAnomalies(expenses, selectedMonth, inferredMonths = inferredExpenseStatementMonths(expenses)) {
  const selected = expenses.filter(expense => expenseReportingMonth(expense, inferredMonths) === selectedMonth && expenseAmountInTry(expense) > 0);
  const history = expenses.filter(expense => {
    const month = expenseReportingMonth(expense, inferredMonths);
    return month && month < selectedMonth && expenseAmountInTry(expense) > 0;
  });
  const items = [];
  const recurringSeen = new Set();

  selected.forEach(expense => {
    const amount = Math.abs(expenseAmountInTry(expense));
    const merchantKey = expenseMerchantKey(expense.description);
    const merchantHistory = history.filter(item => expenseMerchantKey(item.description) === merchantKey && item.family === expense.family);
    const categoryHistory = history.filter(item => item.category === expense.category && item.family === expense.family);
    const ownerHistory = history.filter(item => item.family === expense.family);
    const baselinePool = merchantHistory.length >= 2 ? merchantHistory : categoryHistory.length >= 4 ? categoryHistory : ownerHistory;
    const baseline = expenseMedian(baselinePool.map(item => Math.abs(expenseAmountInTry(item))));
    const enoughHistory = merchantHistory.length >= 2 || categoryHistory.length >= 4 || ownerHistory.length >= 8;
    if (enoughHistory && baseline > 0 && amount > baseline * 2.4 && amount - baseline >= 500) {
      items.push({
        tone: "danger",
        expenseId: expense.id,
        date: expense.date,
        title: `${expense.description} normalden yüksek`,
        detail: `${formatMoney(amount, "TRY", { maximumFractionDigits: 0 })} · benzer geçmiş tutarın yaklaşık ${formatNumber(amount / baseline, 1)} katı`
      });
    }

    if (merchantKey && !recurringSeen.has(merchantKey)) {
      recurringSeen.add(merchantKey);
      const merchantRecords = expenses.filter(item => expenseMerchantKey(item.description) === merchantKey && expenseAmountInTry(item) > 0);
      const monthKeys = [...new Set(merchantRecords.map(item => expenseReportingMonth(item, inferredMonths)).filter(Boolean))];
      const amounts = merchantRecords.map(item => Math.abs(expenseAmountInTry(item)));
      const typical = expenseMedian(amounts);
      const stable = typical > 0 ? amounts.filter(value => Math.abs(value - typical) / typical <= 0.18).length / amounts.length : 0;
      if (monthKeys.length >= 3 && stable >= 0.75) {
        items.push({
          tone: "info",
          expenseId: expense.id,
          date: expense.date,
          title: `${expense.description} düzenli ödeme olabilir`,
          detail: `${monthKeys.length} farklı ayda benzer tutar · tipik ${formatMoney(typical, "TRY", { maximumFractionDigits: 0 })}`
        });
      }
    }
  });

  const previousMonths = recentExpenseMonths(selectedMonth, 4).slice(0, 3);
  const categories = [...new Set(selected.map(expense => expense.category))];
  categories.forEach(category => {
    const currentTotal = selected.filter(expense => expense.category === category).reduce((sum, expense) => sum + expenseAmountInTry(expense), 0);
    const previousTotals = previousMonths.map(month => expenses
      .filter(expense => expenseReportingMonth(expense, inferredMonths) === month && expense.category === category && expenseAmountInTry(expense) > 0)
      .reduce((sum, expense) => sum + expenseAmountInTry(expense), 0));
    const activeHistory = previousTotals.filter(value => value > 0);
    if (activeHistory.length < 2) return;
    const average = previousTotals.reduce((sum, value) => sum + value, 0) / previousTotals.length;
    if (average > 0 && currentTotal > average * 1.6 && currentTotal - average >= 750) {
      items.push({
        tone: "warn",
        title: `${category} harcamaları yükseldi`,
        detail: `Son üç ay ortalamasının %${formatNumber((currentTotal / average - 1) * 100, 0)} üzerinde`
      });
    }
  });

  const currentAll = selected.reduce((sum, expense) => sum + expenseAmountInTry(expense), 0);
  const currentFamily = selected.filter(expense => expense.family).reduce((sum, expense) => sum + expenseAmountInTry(expense), 0);
  const historicalShares = previousMonths.map(month => {
    const records = expenses.filter(expense => expenseReportingMonth(expense, inferredMonths) === month && expenseAmountInTry(expense) > 0);
    const total = records.reduce((sum, expense) => sum + expenseAmountInTry(expense), 0);
    const family = records.filter(expense => expense.family).reduce((sum, expense) => sum + expenseAmountInTry(expense), 0);
    return total > 0 ? family / total * 100 : null;
  }).filter(Number.isFinite);
  if (currentAll > 0 && historicalShares.length >= 2) {
    const currentShare = currentFamily / currentAll * 100;
    const previousShare = historicalShares.reduce((sum, value) => sum + value, 0) / historicalShares.length;
    if (Math.abs(currentShare - previousShare) >= 20) {
      items.push({
        tone: "warn",
        title: "Aile harcaması oranı belirgin değişti",
        detail: `Bu ay %${formatNumber(currentShare, 0)} · önceki dönem ortalaması %${formatNumber(previousShare, 0)}`
      });
    }
  }

  const priority = { danger: 0, warn: 1, info: 2 };
  items.sort((left, right) => priority[left.tone] - priority[right.tone] || String(right.date || "").localeCompare(String(left.date || "")));
  return { items: items.slice(0, 8), selectedCount: selected.length, historyCount: history.length };
}

function renderExpenseAnomalies(result, selectedMonth) {
  const target = $("#expenseAnomalyList");
  const badge = $("#expenseAnomalyCount");
  if (!target || !badge) return;
  if (!result.selectedCount) {
    badge.className = "status-chip neutral";
    badge.textContent = "Veri bekleniyor";
    target.innerHTML = `<div class="expense-anomaly-empty"><span>◇</span><div><strong>${expenseMonthLabel(selectedMonth)} için analiz edilecek harcama yok.</strong><p>Ekstre eklediğinde olağandışı tutarlar ve düzenli ödemeler burada görünür.</p></div></div>`;
    return;
  }
  if (!result.items.length) {
    badge.className = "status-chip live";
    badge.textContent = "Belirgin sinyal yok";
    target.innerHTML = `<div class="expense-anomaly-empty is-clear"><span>✓</span><div><strong>Belirgin bir sapma bulunmadı.</strong><p>${result.historyCount ? "Bu ayki harcamalar geçmiş düzenle uyumlu görünüyor." : "Daha güvenilir karşılaştırma için birkaç aylık ekstre gerekir."}</p></div></div>`;
    return;
  }
  badge.className = "status-chip warn";
  badge.textContent = `${result.items.length} bulgu`;
  target.innerHTML = result.items.map(item => {
    const content = `<span class="expense-anomaly-icon" aria-hidden="true">${item.tone === "danger" ? "!" : item.tone === "warn" ? "↗" : "↻"}</span><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail)}</small></span>${item.expenseId ? '<span class="expense-anomaly-arrow" aria-hidden="true">→</span>' : ""}`;
    return item.expenseId
      ? `<button class="expense-anomaly-item ${item.tone}" type="button" data-expense-anomaly-id="${escapeHtml(item.expenseId)}">${content}</button>`
      : `<div class="expense-anomaly-item ${item.tone}">${content}</div>`;
  }).join("");
}

function renderExpenses({ preserveRows = false } = {}) {
  const table = $("#expenseTable");
  if (!table) return;
  const expenses = Array.isArray(state.expenses) ? state.expenses : [];
  const inferredMonths = inferredExpenseStatementMonths(expenses);
  const availableMonths = [...new Set(expenses.map(expense => expenseReportingMonth(expense, inferredMonths)).filter(Boolean))].sort();
  if (!expenseView.month) expenseView.month = availableMonths.at(-1) || today().slice(0, 7);
  const monthPicker = $("#expenseMonthPicker");
  if (monthPicker && document.activeElement !== monthPicker) monthPicker.value = expenseView.month;

  const selected = expenses.filter(expense => expenseReportingMonth(expense, inferredMonths) === expenseView.month);
  const personalTotal = selected.filter(expense => !expense.family).reduce((sum, expense) => sum + expenseAmountInTry(expense), 0);
  const familyTotal = selected.filter(expense => expense.family).reduce((sum, expense) => sum + expenseAmountInTry(expense), 0);
  const monthTotal = personalTotal + familyTotal;
  const monthlyPersonalTotals = availableMonths.map(month => expenses
    .filter(expense => expenseReportingMonth(expense, inferredMonths) === month && !expense.family)
    .reduce((sum, expense) => sum + expenseAmountInTry(expense), 0));
  const personalAverage = monthlyPersonalTotals.length
    ? monthlyPersonalTotals.reduce((sum, value) => sum + value, 0) / monthlyPersonalTotals.length
    : 0;

  setExpenseMetric("#expenseMonthTotal", formatMoney(monthTotal, "TRY", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  setExpenseMetric("#expensePersonalTotal", formatMoney(personalTotal, "TRY", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  setExpenseMetric("#expenseFamilyTotal", formatMoney(familyTotal, "TRY", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  setExpenseMetric("#expensePersonalAverage", formatMoney(personalAverage, "TRY", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  $("#expenseMonthTotalNote").textContent = selected.length ? `${expenseMonthLabel(expenseView.month)} · ${selected.length} harcama` : `${expenseMonthLabel(expenseView.month)} için kayıt yok`;
  $("#expensePersonalShare").textContent = `Toplamın %${monthTotal ? formatNumber(personalTotal / monthTotal * 100, 0) : "0"}'ı`;
  $("#expenseFamilyShare").textContent = `Toplamın %${monthTotal ? formatNumber(familyTotal / monthTotal * 100, 0) : "0"}'ı`;
  $("#expenseAverageNote").textContent = availableMonths.length ? `${availableMonths.length} kayıtlı ay üzerinden` : "Kayıtlı ay bekleniyor";

  renderExpenseTrend(expenses, expenseView.month, inferredMonths);
  renderExpenseAnomalies(analyzeExpenseAnomalies(expenses, expenseView.month, inferredMonths), expenseView.month);
  const filtered = selected
    .filter(expense => expenseView.filter === "all" || (expenseView.filter === "family" ? expense.family : !expense.family))
    .sort((a, b) => b.date.localeCompare(a.date) || Number(b.importedAt) - Number(a.importedAt));
  $("#expenseRowCount").textContent = `${filtered.length} kayıt`;
  $$("[data-expense-filter]").forEach(button => {
    const active = button.dataset.expenseFilter === expenseView.filter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  if (preserveRows && table.querySelectorAll("tr.expense-row").length === filtered.length) return;

  table.innerHTML = filtered.length ? filtered.map((expense, index) => `
    <tr class="expense-row ${expense.family ? "is-family" : ""}" data-expense-row-id="${escapeHtml(expense.id)}" style="--expense-row-index:${Math.min(index, 12)}">
      <td data-label="Aile"><label class="family-toggle" title="${expense.family ? "Aile harcaması" : "Kişisel harcama"}"><input type="checkbox" data-expense-family="${escapeHtml(expense.id)}" ${expense.family ? "checked" : ""} aria-label="${escapeHtml(expense.description)} aile harcaması" /><span aria-hidden="true"></span><small>Aile</small></label></td>
      <td data-label="Tarih"><time datetime="${escapeHtml(expense.date)}">${new Intl.DateTimeFormat("tr-TR", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${expense.date}T12:00:00`))}</time></td>
      <td data-label="Harcama"><strong>${escapeHtml(expense.description)}</strong><small class="expense-source">${expense.statementName ? escapeHtml(expense.statementName) : "Ekstre"}</small></td>
      <td data-label="Kategori"><span class="expense-category">${escapeHtml(expense.category)}</span></td>
      <td data-label="Tutar" class="number expense-amount ${expense.amount < 0 ? "refund" : ""}">${formatMoney(expense.amount, expense.currency, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      <td data-label="Eylem"><button class="icon-button expense-delete" type="button" data-expense-delete="${escapeHtml(expense.id)}" aria-label="${escapeHtml(expense.description)} harcamasını sil" title="Harcama kaydını sil">×</button></td>
    </tr>`).join("") : `<tr><td colspan="6" class="empty-state"><strong>${selected.length ? "Bu filtrede harcama yok" : "Bu ay için harcama yok"}</strong><span>${selected.length ? "Diğer filtrelerden birini seçebilirsin." : "Kart ekstresini yüklediğinde harcamalar burada otomatik listelenir."}</span></td></tr>`;
}

function setExpenseImportStatus(message, stateName = "idle") {
  const status = $("#expenseImportStatus");
  const dropzone = $("#expenseDropzone");
  if (status) { status.textContent = message; status.dataset.state = stateName; }
  if (dropzone) {
    dropzone.classList.toggle("is-loading", stateName === "loading");
    dropzone.classList.toggle("is-success", stateName === "success");
    dropzone.classList.toggle("is-error", stateName === "error");
    dropzone.setAttribute("aria-busy", String(stateName === "loading"));
  }
}

function pdfPageLines(textContent) {
  const groups = [];
  (textContent?.items || []).forEach(item => {
    const text = String(item?.str || "").trim();
    if (!text) return;
    const x = Number(item?.transform?.[4]) || 0;
    const y = Number(item?.transform?.[5]) || 0;
    let group = groups.find(candidate => Math.abs(candidate.y - y) < 2.5);
    if (!group) { group = { y, items: [] }; groups.push(group); }
    group.items.push({ x, text });
  });
  return groups.sort((a, b) => b.y - a.y).map(group => group.items.sort((a, b) => a.x - b.x).map(item => item.text).join(" "));
}

async function expensesFromPdf(file) {
  if (!globalThis.pdfjsLib) throw new Error("PDF okuma bileşeni yüklenemedi. İnternet bağlantısını kontrol edip yeniden deneyin.");
  globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
  const pdf = await globalThis.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const lines = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    lines.push(...pdfPageLines(await page.getTextContent()));
  }
  return ExpenseCore.parseStatementLines(lines);
}

async function expensesFromSpreadsheet(file) {
  if (typeof XLSX === "undefined") throw new Error("Excel okuma bileşeni yüklenemedi. Dosyayı CSV olarak kaydedip yeniden deneyin.");
  const workbook = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array", cellDates: true });
  return workbook.SheetNames.flatMap(sheetName => ExpenseCore.parseRows(XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "", raw: false })));
}

async function extractExpensesFromFile(file) {
  const name = file.name.toLocaleLowerCase("tr-TR");
  if (file.type === "application/pdf" || name.endsWith(".pdf")) return expensesFromPdf(file);
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) return expensesFromSpreadsheet(file);
  const text = await file.text();
  if (name.endsWith(".csv")) return ExpenseCore.parseRows(ExpenseCore.parseDelimited(text));
  return ExpenseCore.parseStatementLines(text.split(/\r?\n/));
}

async function importExpenseStatement(file) {
  if (!file || expenseView.importing) return;
  expenseView.importing = true;
  setExpenseImportStatus(`${file.name} okunuyor…`, "loading");
  try {
    const extracted = await extractExpensesFromFile(file);
    if (!extracted.length) throw new Error("Dosyada okunabilir harcama satırı bulunamadı. Taranmış PDF yerine bankanın metin tabanlı PDF, Excel veya CSV ekstresini deneyin.");
    const known = new Set((state.expenses || []).map(expense => expense.fingerprint || ExpenseCore.fingerprint(expense)));
    const occurrences = new Map();
    const importedAt = Date.now();
    const statementMonth = dominantExpenseMonth(extracted) || today().slice(0, 7);
    const additions = [];
    let duplicateCount = 0;
    extracted.forEach((expense, index) => {
      const baseFingerprint = ExpenseCore.fingerprint(expense);
      const occurrence = (occurrences.get(baseFingerprint) || 0) + 1;
      occurrences.set(baseFingerprint, occurrence);
      const fingerprint = ExpenseCore.fingerprint(expense, occurrence);
      if (known.has(fingerprint)) { duplicateCount += 1; return; }
      known.add(fingerprint);
      additions.push({ ...expense, id: uid("expense"), family: false, source: "statement", statementName: file.name, statementMonth, importedAt: importedAt + index, fingerprint });
    });
    if (!additions.length) {
      setExpenseImportStatus(`Yeni kayıt yok · ${duplicateCount} harcama daha önce eklenmiş`, "success");
      showToast("Bu ekstredeki harcamalar zaten kayıtlı.", { undo: false });
      return;
    }
    state.expenses = [...(state.expenses || []), ...additions];
    state.onboardingCompleted = true;
    const importedMonthCounts = additions.reduce((counts, expense) => {
      const month = expense.statementMonth || expenseMonthKey(expense.date);
      if (month) counts.set(month, (counts.get(month) || 0) + 1);
      return counts;
    }, new Map());
    expenseView.month = [...importedMonthCounts.entries()]
      .sort((left, right) => right[1] - left[1] || right[0].localeCompare(left[0]))[0]?.[0]
      || expenseView.month;
    expenseView.filter = "all";
    saveState();
    renderExpenses();
    const duplicateNote = duplicateCount ? ` · ${duplicateCount} tekrar atlandı` : "";
    setExpenseImportStatus(`${additions.length} harcama eklendi${duplicateNote}`, "success");
    showToast(`${additions.length} harcama eklendi. Aile harcamalarını satırdan işaretleyebilirsin.`);
  } catch (error) {
    setExpenseImportStatus(error?.message || "Ekstre okunamadı. Farklı bir dosya deneyin.", "error");
    showToast(error?.message || "Ekstre okunamadı.", { undo: false, duration: 7000 });
  } finally {
    expenseView.importing = false;
  }
}

function toggleExpenseFamily(expenseId, family) {
  const expense = (state.expenses || []).find(item => item.id === expenseId);
  if (!expense || expense.family === family) return;
  expense.family = family;
  const checkbox = $$("[data-expense-family]").find(input => input.dataset.expenseFamily === expenseId);
  const row = checkbox?.closest("tr.expense-row");
  if (checkbox) checkbox.checked = family;
  if (row) {
    row.classList.toggle("is-family", family);
    const toggle = checkbox.closest(".family-toggle");
    if (toggle) toggle.title = family ? "Aile harcaması" : "Kişisel harcama";
    const remainsVisible = expenseView.filter === "all" || (expenseView.filter === "family" ? family : !family);
    if (!remainsVisible) row.remove();
  }
  saveState();
  renderExpenses({ preserveRows: true });
  setExpenseImportStatus(family ? "Aile harcaması olarak kaydedildi" : "Kişisel harcama olarak kaydedildi", "success");
}

function deleteExpense(expenseId) {
  const index = (state.expenses || []).findIndex(expense => expense.id === expenseId);
  if (index < 0) return;
  const [removed] = state.expenses.splice(index, 1);
  saveState();
  renderExpenses();
  showToast(`${removed.description} harcaması silindi.`);
}


function renderTransactions() {
  const rows = Core.sortTransactions(state.transactions).reverse();
  $("#transactionTable").innerHTML = rows.length ? rows.map(tx => {
    const gross = number(tx.quantity) * number(tx.price);
    const fee = number(tx.fee);
    const profitShare = tx.type === "SELL" ? number(tx.profitShare) : 0;
    const total = (tx.type === "BUY" || tx.type === "IPO_BUY" || tx.type === "WITHDRAWAL")
      ? gross + fee
      : gross - fee - profitShare;
    const quote = state.prices[tx.symbol];
    let symbolDisplay = `<strong>${escapeHtml(tx.symbol || "—")}</strong><div class="security-name">${escapeHtml(tx.name || "Nakit hareketi")}</div>`;
    if (tx.symbol) {
      const logo = companyLogo(tx.symbol, quote, tx.name);
      symbolDisplay = `<div class="symbol-wrapper">${logo}<div>${symbolDisplay}</div></div>`;
    }
    return `<tr><td data-label="Tarih">${new Intl.DateTimeFormat("tr-TR", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${tx.date}T12:00:00`))}</td><td data-label="İşlem">${transactionLabel(tx.type)}</td><td data-label="Sembol">${symbolDisplay}</td><td data-label="Adet" class="number">${formatNumber(number(tx.quantity), 9)}</td><td data-label="Birim fiyat" class="number">${formatMoney(number(tx.quotedPrice ?? tx.price), tx.currency, { maximumFractionDigits: 6 })}</td><td data-label="Komisyon" class="number">${formatMoney(fee, tx.currency, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td><td data-label="Kâr paylaşımı" class="number">${profitShare > 0 ? formatMoney(profitShare, tx.currency, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"}</td><td data-label="Kişisel net tutar" class="number">${formatMoney(total, tx.currency, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td><td data-label="Eylem" class="card-actions"><button class="button small secondary" type="button" onclick="openTransaction('BUY', '${tx.id}')">Düzenle</button><details class="row-actions-menu"><summary class="button small secondary" aria-label="İşlemin diğer eylemleri">•••</summary><div class="row-actions-popover"><button class="menu-action danger-text" type="button" onclick="deleteTransaction('${tx.id}')">İşlemi sil</button></div></details></td></tr>`;
  }).join("") : `<tr><td colspan="9" class="empty-state">Henüz işlem yok.</td></tr>`;
}
function renderSettings() {
  if ($("#usernameInput") && document.activeElement !== $("#usernameInput")) $("#usernameInput").value = state.settings.username || "";
  $("#baseCurrencySelect").value = state.settings.baseCurrency;
  $("#fxRateInput").value = state.settings.fxUsdTry;
  $("#refreshIntervalSelect").value = String(state.settings.refreshInterval);
  renderMarketHealth();
  loadAiSettings();
}

async function loadSecSettings() {
  if (location.protocol === "file:") return;
  try {
    const response = await fetch("/api/sec-status", { cache: "no-store" });
    const data = await readJsonResponse(response, "sec");
    if (!response.ok) throw serviceError("sec");
    const badge = $("#secContactBadge");
    const input = $("#secContactEmailInput");
    if (badge) {
      badge.className = `status-badge ${data.hasContactEmail ? "active" : "inactive"}`;
      badge.textContent = data.hasContactEmail ? "✓ Tanımlı" : "E-posta gerekli";
    }
    if (input && data.hasContactEmail && !input.value) input.placeholder = "Kayıtlı — değiştirmek için yeni adres girin";
  } catch (_) { /* Optional status does not block the rest of Settings. */ }
}

async function saveSecSettings() {
  const input = $("#secContactEmailInput");
  const status = $("#secSettingsStatus");
  const contactEmail = input?.value?.trim() || "";
  if (!contactEmail || !input.checkValidity()) {
    if (status) { status.textContent = "Geçerli bir iletişim e-postası girin."; status.style.color = "var(--red)"; }
    return;
  }
  try {
    const response = await fetch("/api/save-sec-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contactEmail }),
    });
    const payload = await readJsonResponse(response, "sec");
    if (!response.ok) throw serviceError("sec");
    input.value = "";
    if (status) {
      status.textContent = payload.recoveredPreviousConfig
        ? "✓ SEC ayarı kaydedildi. Önceki okunamayan şifreli dosya yedeğe ayrıldı; eski Telegram/Gemini ayarlarını gerekirse yeniden girin."
        : "✓ SEC erişim tanımı güvenli bulut ayarlarına kaydedildi.";
      status.style.color = payload.recoveredPreviousConfig ? "var(--yellow)" : "var(--green)";
    }
    await loadSecSettings();
    showToast(payload.recoveredPreviousConfig ? "SEC ayarı onarıldı ve kaydedildi." : "SEC erişimi yapılandırıldı.");
  } catch (error) {
    const message = friendlyError("sec", error);
    if (status) { status.textContent = message; status.style.color = "var(--red)"; }
    showServiceError("sec", { retry: saveSecSettings });
  }
}

async function refreshQuotes({ quiet = false } = {}) {
  if (location.protocol === "file:") {
    showToast("Güncel fiyat için uygulamayı Baslat.cmd ile aç.");
    return;
  }
  const holdings = calculatePortfolio().holdings;
  const txClosed = typeof getClosedPositionsFromTransactions === "function" ? getClosedPositionsFromTransactions() : [];
  const allSymbols = new Set([
    ...holdings.filter(h => !h.tickerPending).map(h => h.symbol),
    ...(state.watchlist || []).map(item => item.symbol),
    ...txClosed.map(c => c.symbol),
    ...(state.closedPositions || []).map(c => c.symbol)
  ].filter(Boolean));

  if (!allSymbols.size) { if (!quiet) showToast("Fiyat sorgusu için pozisyon veya takip listesine hisse ekle."); return; }
  const symbolMap = new Map();
  allSymbols.forEach(symbol => {
    const isBist = symbol.toUpperCase().endsWith(".IS");
    const providerSymbol = isBist && !symbol.endsWith(".IS") ? `${symbol}.IS` : symbol;
    symbolMap.set(providerSymbol, symbol);
  });
  const button = $("#refreshButton");
  button.disabled = true;
  const originalHtml = button.innerHTML;
  button.innerHTML = `<span aria-hidden="true">↻</span><span>Güncelleniyor…</span>`;
  try {
    const response = await fetch(`/api/quotes?symbols=${encodeURIComponent([...symbolMap.keys()].join(","))}`, { cache: "no-store" });
    const payload = await readJsonResponse(response, "price", { hasCached: Object.keys(state.prices || {}).length > 0 });
    if (!response.ok) throw serviceError("price");
    if (payload.marketStatus && typeof payload.marketStatus === "object") marketHealth = payload.marketStatus;
    if (payload.fxUsdTry && Number.isFinite(Number(payload.fxUsdTry))) {
      state.settings.fxUsdTry = Number(payload.fxUsdTry);
    }
    if (payload.benchmarks && typeof payload.benchmarks === "object") {
      state.benchmarks = Object.fromEntries(Object.entries(payload.benchmarks).filter(([, benchmark]) => (
        Number.isFinite(Number(benchmark?.price)) && Number(benchmark.price) > 0
      )));
    }
    let updated = 0;
    payload.quotes.forEach(quote => {
      const stateSymbol = symbolMap.get(quote.symbol) || quote.symbol;
      if (!Number.isFinite(Number(quote.price)) || Number(quote.price) <= 0) return;
      state.prices[stateSymbol] = {
        price: Number(quote.price),
        changePct: Number.isFinite(Number(quote.changePct)) ? Number(quote.changePct) : 0,
        currency: quote.currency || state.prices[stateSymbol]?.currency || "USD",
        updatedAt: new Date(quote.asOf || Date.now()).getTime(),
        delayed: quote.delayed !== false,
        source: quote.source || "tradingview",
        session: quote.session || "regular",
        regularClose: Number.isFinite(Number(quote.regularClose)) ? Number(quote.regularClose) : null,
        extendedChangePct: Number.isFinite(Number(quote.extendedChangePct)) ? Number(quote.extendedChangePct) : null,
        priceType: quote.priceType || "last-trade",
        logoid: quote.logoid || state.prices[stateSymbol]?.logoid || null,
        cacheState: quote.cacheState || "live",
        retrievedAt: quote.retrievedAt ? Date.parse(quote.retrievedAt) : Date.now()
      };
      updated += 1;
    });
    saveState({ recordUndo: false }); render();
    technicalHistoryCache.clear();
    void refreshTechnicalAlertStatuses(!quiet);
    if (!quiet) {
      const staleCount = Array.isArray(payload.warnings) ? payload.warnings.length : 0;
      showToast(updated
        ? `${updated} fiyat işlendi.${staleCount ? ` ${staleCount} sembolde son başarılı kayıt kullanıldı.` : ""}${payload.errors?.length ? ` ${payload.errors.length} sembol alınamadı.` : ""}`
        : "Geçerli fiyat alınamadı.");
    }
  } catch (error) {
    if (Object.keys(state.prices || {}).length > 0) {
      marketHealth = { ...marketHealth, cache: { ...(marketHealth.cache || {}), status: "stale" } };
      renderHeader();
      renderMarketHealth();
    }
    if (!quiet) showServiceError("price", {
      hasCached: Object.keys(state.prices || {}).length > 0,
      retry: () => refreshQuotes({ quiet: false }),
    });
  } finally {
    button.disabled = false;
    button.innerHTML = originalHtml;
  }
}

function loadPendingUndo() {
  if (pendingUndo?.expiresAt > Date.now()) return pendingUndo;
  try {
    const saved = JSON.parse(sessionStorage.getItem(UNDO_STORAGE_KEY) || "null");
    pendingUndo = saved?.expiresAt > Date.now() ? saved : null;
  } catch (_) { pendingUndo = null; }
  return pendingUndo;
}

function undoLastChange() {
  const undo = loadPendingUndo();
  if (!undo) return;
  pendingUndo = null;
  try { sessionStorage.removeItem(UNDO_STORAGE_KEY); } catch (_) {}
  state = migrateState(JSON.parse(undo.previous));
  document.documentElement.setAttribute("data-theme", state.settings.theme);
  saveState({ recordUndo: false });
  render();
  renderClosedPositions();
  showToast("Son değişiklik geri alındı.", { undo: false });
}

function showToast(message, { undo = true, duration = 3200, actionLabel = "", action = null } = {}) {
  const toast = $("#toast");
  const messageNode = $("#toastMessage");
  const actionButton = $("#toastUndoButton");
  if (!toast) return;
  if (messageNode) messageNode.textContent = message;
  else toast.textContent = message;
  const candidate = undo ? loadPendingUndo() : null;
  const showUndo = candidate && Date.now() - candidate.createdAt < 1800;
  const showAction = typeof action === "function" && Boolean(actionLabel);
  if (actionButton) {
    actionButton.hidden = !showUndo && !showAction;
    actionButton.textContent = showAction ? actionLabel : "Geri al";
    actionButton.onclick = showAction
      ? () => { toast.classList.remove("visible"); action(); }
      : showUndo ? undoLastChange : null;
  }
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), (showUndo || showAction) ? 12000 : duration);
}
function scheduleRefresh() {
  clearInterval(refreshTimer);
  if (location.protocol !== "file:") refreshTimer = setInterval(() => refreshQuotes({ quiet: true }), number(state.settings.refreshInterval) || 30000);
}

function openTransaction(defaultType = "BUY", editTxId = null) {
  $("#transactionForm").reset();
  currentEditingTxId = editTxId;

  if (editTxId) {
    const tx = state.transactions.find(t => t.id === editTxId);
    if (tx) {
      $("#transactionDialogTitle").textContent = "İşlemi Düzenle";
      $("#transactionType").value = tx.type || "BUY";
      $("#transactionMarket").value = tx.market || (tx.symbol && tx.symbol.endsWith(".IS") ? "BIST" : "ABD");
      updateTransactionForm();

      $("#transactionDate").value = tx.date || today();
      $("#transactionMarket").value = tx.market || (tx.symbol && tx.symbol.endsWith(".IS") ? "BIST" : "ABD");
      $("#transactionCurrency").value = tx.currency || (tx.symbol && !tx.symbol.endsWith(".IS") ? "USD" : "TRY");
      $("#transactionSymbol").value = tx.symbol || "";
      $("#transactionName").value = tx.name || "";
      $("#transactionPrice").value = tx.quotedPrice ?? tx.price ?? "";
      $("#transactionQuantity").value = tx.quantity !== undefined ? tx.quantity : "";
      const totalVal = number(tx.total) || transactionDisplayedTotal(tx.type, number(tx.quantity) * number(tx.price), number(tx.fee));
      $("#transactionTotal").value = totalVal > 0 ? totalVal.toFixed(2).replace(/\.?0+$/, "") : "";
      $("#transactionFee").value = tx.fee !== undefined ? tx.fee : 0;
      $("#transactionProfitShare").value = tx.profitShare !== undefined ? tx.profitShare : 0;

      $("#transactionDialog").showModal();
      return;
    }
  }

  $("#transactionType").value = defaultType;
  $("#transactionDate").value = today();
  $("#transactionFee").value = "0";
  $("#transactionProfitShare").value = "0";
  $("#transactionDialogTitle").textContent = defaultType === "IPO_BUY" ? "Halka arz işlemi" : "Yeni işlem";
  updateTransactionForm();
  $("#transactionDialog").showModal();
}
function updateTransactionForm() {
  const type = $("#transactionType").value;
  const marketEl = $("#transactionMarket");
  const currEl = $("#transactionCurrency");
  const isAssetTransaction = Core.ASSET_TYPES.has(type);
  const isSell = type === "SELL";
  ["#transactionMarketLabel", "#transactionSymbolLabel", "#transactionNameLabel", "#transactionPriceLabel", "#transactionQuantityLabel"]
    .forEach(selector => { const element = $(selector); if (element) element.hidden = !isAssetTransaction; });
  const totalLabel = $("#transactionTotalLabelText");
  if (totalLabel) totalLabel.textContent = isSell ? "Net satış tutarı" : (isAssetTransaction ? "Toplam ödeme" : "Tutar");
  const profitShareLabel = $("#transactionProfitShareLabel");
  if (profitShareLabel) profitShareLabel.hidden = !isSell;
  if (!isSell) $("#transactionProfitShare").value = "0";
  const help = $("#transactionFormHelp");
  if (help) help.textContent = isAssetTransaction
    ? (isSell
      ? "Komisyon aracı kurum masrafıdır. Aileye verdiğin payı ayrı alana gir; kişisel net kârından düşülür."
      : "Toplam ödeme ve birim fiyattan adet otomatik hesaplanabilir.")
    : "Nakit hareketinin toplam tutarını girin; hisse kodu ve adet gerekmez.";
  $("#transactionSymbol").required = isAssetTransaction;
  if (currEl && !currentEditingTxId) {
    currEl.value = marketEl.value === "ABD" ? "USD" : "TRY";
  }
}
function transactionDisplayedTotal(type, gross, fee) {
  if (type === "SELL") return Math.max(0, gross - fee);
  if (type === "BUY" || type === "IPO_BUY") return gross + fee;
  return gross;
}
function transactionGrossFromDisplayedTotal(type, total, fee) {
  if (type === "SELL") return total + fee;
  if (type === "BUY" || type === "IPO_BUY") return Math.max(0, total - fee);
  return total;
}
function handleTransactionCalculation(source) {
  const type = $("#transactionType").value;
  const isAssetTransaction = Core.ASSET_TYPES.has(type);
  const price = number($("#transactionPrice").value);
  const total = number($("#transactionTotal").value);
  const qty = number($("#transactionQuantity").value);
  const fee = number($("#transactionFee").value);
  const grossFromTotal = isAssetTransaction ? transactionGrossFromDisplayedTotal(type, total, fee) : total;

  if (source === "total") {
    if (price > 0 && total > 0) {
      const computedQty = grossFromTotal / price;
      $("#transactionQuantity").value = computedQty.toFixed(9).replace(/\.?0+$/, "");
    } else if (qty > 0 && total > 0 && price === 0) {
      const computedPrice = grossFromTotal / qty;
      $("#transactionPrice").value = computedPrice.toFixed(6).replace(/\.?0+$/, "");
    }
  } else if (source === "price") {
    if (qty > 0 && price > 0) {
      const computedTotal = transactionDisplayedTotal(type, qty * price, fee);
      $("#transactionTotal").value = computedTotal.toFixed(2).replace(/\.?0+$/, "");
    } else if (total > 0 && price > 0) {
      const computedQty = grossFromTotal / price;
      $("#transactionQuantity").value = computedQty.toFixed(9).replace(/\.?0+$/, "");
    }
  } else if (source === "quantity") {
    if (price > 0 && qty > 0) {
      const computedTotal = transactionDisplayedTotal(type, qty * price, fee);
      $("#transactionTotal").value = computedTotal.toFixed(2).replace(/\.?0+$/, "");
    } else if (total > 0 && qty > 0 && price === 0) {
      const computedPrice = grossFromTotal / qty;
      $("#transactionPrice").value = computedPrice.toFixed(6).replace(/\.?0+$/, "");
    }
  }
}
function handleSymbolAutoFill() {
  let symbol = $("#transactionSymbol").value.trim().toUpperCase();
  if (!symbol) return;

  const selectedMarket = $("#transactionMarket").value;

  // Kullanıcı ABD seçmişse: .IS ekleme, piyasayı değiştirme
  if (selectedMarket === "ABD") {
    // .IS varsa kaldır (yanlışlıkla girilmiş olabilir)
    if (symbol.endsWith(".IS")) {
      symbol = symbol.replace(/\.IS$/, "");
      $("#transactionSymbol").value = symbol;
    }
    $("#transactionCurrency").value = "USD";
    const quote = state.prices[symbol];
    if (quote && quote.price && !number($("#transactionPrice").value)) {
      $("#transactionPrice").value = quote.price;
      handleTransactionCalculation("price");
    }
    return;
  }

  // Kullanıcı BIST seçmişse: .IS ekle
  if (selectedMarket === "BIST") {
    if (!symbol.endsWith(".IS")) {
      symbol += ".IS";
      $("#transactionSymbol").value = symbol;
    }
    $("#transactionCurrency").value = "TRY";
    const quote = state.prices[symbol] || state.prices[symbol.replace(".IS", "")];
    if (quote && quote.price && !number($("#transactionPrice").value)) {
      $("#transactionPrice").value = quote.price;
      handleTransactionCalculation("price");
    }
    return;
  }

  // Piyasa seçilmemişse: sembole göre tahmin et
  const usTickers = new Set(["NVDA", "AAPL", "MSFT", "VOO", "TSLA", "AMZN", "GOOGL", "META", "QQQ", "SPY", "NFLX", "AMD", "AVGO", "PLTR", "HOOD", "COIN", "MSTR", "MARA", "RIOT"]);
  const cleanSym = symbol.replace(/\.IS$/, "");

  if (usTickers.has(cleanSym) || symbol.includes(".") && !symbol.endsWith(".IS")) {
    $("#transactionMarket").value = "ABD";
    $("#transactionCurrency").value = "USD";
    if (symbol.endsWith(".IS")) {
      symbol = cleanSym;
      $("#transactionSymbol").value = symbol;
    }
  } else {
    $("#transactionMarket").value = "BIST";
    $("#transactionCurrency").value = "TRY";
    if (!symbol.endsWith(".IS")) {
      symbol += ".IS";
      $("#transactionSymbol").value = symbol;
    }
  }

  const quote = state.prices[symbol] || state.prices[symbol.replace(".IS", "")];
  if (quote && quote.price && !number($("#transactionPrice").value)) {
    $("#transactionPrice").value = quote.price;
    handleTransactionCalculation("price");
  }
}
function saveTransaction(event) {
  event.preventDefault();
  const type = $("#transactionType").value;
  const isAssetTransaction = Core.ASSET_TYPES.has(type);
  let price = number($("#transactionPrice").value);
  let total = number($("#transactionTotal").value);
  let quantity = number($("#transactionQuantity").value);
  const fee = number($("#transactionFee").value);
  const profitShare = type === "SELL" ? number($("#transactionProfitShare").value) : 0;
  let quotedPrice = price;
  let symbol = $("#transactionSymbol").value.trim().toUpperCase();
  let market = $("#transactionMarket").value;
  const existingTx = currentEditingTxId ? state.transactions.find(t => t.id === currentEditingTxId) : null;
  const keepingPendingIpoCode = Boolean(existingTx?.tickerPending && symbol === existingTx.symbol);

  if (isAssetTransaction && market === "BIST" && symbol && !symbol.endsWith(".IS") && !keepingPendingIpoCode) {
    symbol = `${symbol}.IS`;
  }

  if (!isAssetTransaction) {
    const amount = total > 0 ? total : price * quantity;
    price = amount;
    quantity = 1;
    total = amount;
    symbol = "";
    market = "NAKİT";
  } else if (total > 0 && price > 0 && (!quantity || quantity <= 0)) {
    quantity = transactionGrossFromDisplayedTotal(type, total, fee) / price;
    $("#transactionQuantity").value = quantity.toFixed(9).replace(/\.?0+$/, "");
  } else if (total > 0 && quantity > 0 && (!price || price <= 0)) {
    price = transactionGrossFromDisplayedTotal(type, total, fee) / quantity;
    quotedPrice = price;
    $("#transactionPrice").value = price.toFixed(6).replace(/\.?0+$/, "");
  } else if (quantity > 0 && price > 0 && (!total || total <= 0)) {
    total = transactionDisplayedTotal(type, quantity * price, fee);
    $("#transactionTotal").value = total.toFixed(2).replace(/\.?0+$/, "");
  }

  if (isAssetTransaction && quantity > 0 && price > 0) {
    const financials = Core.brokerTransactionFinancials({ type, quantity, price, quotedPrice, fee, total });
    price = financials.price;
    total = financials.total;
    quotedPrice = financials.quotedPrice;
  }
  if (type === "SELL" && profitShare > total + 1e-8) {
    showToast("Kâr paylaşımı aracı kurumdan gelen net satış tutarını aşamaz.");
    return;
  }

  const candidate = Core.normalizeTransaction({
    ...(existingTx || {}),
    id: existingTx?.id || uid("tx"),
    createdAt: existingTx?.createdAt || Date.now(),
    type,
    date: $("#transactionDate").value,
    market,
    currency: $("#transactionCurrency").value,
    symbol,
    name: isAssetTransaction ? ($("#transactionName").value.trim() || symbol) : transactionLabel(type),
    quantity,
    price,
    quotedPrice: isAssetTransaction ? quotedPrice : undefined,
    total: isAssetTransaction ? total : undefined,
    fee,
    profitShare,
    tickerPending: isAssetTransaction && keepingPendingIpoCode
  });
  const validationErrors = Core.validateTransaction(candidate);
  if (validationErrors.length) { showToast(validationErrors[0]); return; }

  const nextTransactions = currentEditingTxId
    ? state.transactions.map(tx => tx.id === currentEditingTxId ? candidate : tx)
    : [...state.transactions, candidate];
  const auditSignature = error => `${error.txId}|${error.code}|${error.requested}|${error.available}`;
  const currentAuditKeys = new Set(Core.auditTransactions(state.transactions).map(auditSignature));
  const newLedgerError = Core.auditTransactions(nextTransactions)
    .find(error => !currentAuditKeys.has(auditSignature(error)));
  if (newLedgerError) { showToast(newLedgerError.message); return; }

  if (currentEditingTxId) {
    const idx = state.transactions.findIndex(t => t.id === currentEditingTxId);
    if (idx !== -1) {
      state.transactions[idx] = candidate;
      if (!saveState()) return;
      render();
      $("#transactionDialog").close();
      showToast("İşlem başarıyla güncellendi.");
      currentEditingTxId = null;
      if (document.getElementById("positionTxDialog")?.open) {
        document.getElementById("positionTxDialog").close();
      }
      if (isAssetTransaction) refreshQuotes({ quiet: true });
      return;
    }
  }

  if (isAssetTransaction && !state.prices[symbol]) state.prices[symbol] = { price, changePct: 0, currency: candidate.currency, updatedAt: Date.now(), delayed: true, source: "local-entry" };
  state.transactions.push(candidate);
  if (!saveState()) { state.transactions.pop(); return; }
  render(); $("#transactionDialog").close(); showToast("İşlem deftere kaydedildi.");
  if (isAssetTransaction) refreshQuotes({ quiet: true });
}

function appendValidatedTransaction(rawTransaction) {
  const normalized = Core.normalizeTransaction({
    ...rawTransaction,
    id: rawTransaction?.id || uid("tx"),
    createdAt: rawTransaction?.createdAt || Date.now()
  });
  const reconciled = Core.reconcileSellQuantity(state.transactions, normalized);
  const transaction = reconciled.transaction;
  const validationErrors = Core.validateTransaction(transaction);
  if (validationErrors.length) {
    showToast(validationErrors[0]);
    return null;
  }
  const auditError = Core.auditTransactions([...state.transactions, transaction])
    .find(error => error.txId === transaction.id);
  if (auditError) {
    showToast(auditError.message);
    return null;
  }
  state.transactions.push(transaction);
  if (!saveState()) {
    state.transactions.pop();
    return null;
  }
  return { transaction, adjustment: reconciled.adjustment };
}

window.deleteTransaction = function(id) {
  if (!confirm("Bu işlemi silmek istediğine emin misin?")) return;
  state.transactions = state.transactions.filter(tx => tx.id !== id);
  saveState();
  render();
  showToast("İşlem silindi.");
};
function saveSettings() {
  state.settings.username = ($("#usernameInput")?.value || "").trim().slice(0, 80);
  state.settings.baseCurrency = $("#baseCurrencySelect").value;
  state.settings.fxUsdTry = number($("#fxRateInput").value) || DEFAULT_FX;
  state.settings.refreshInterval = number($("#refreshIntervalSelect").value) || 30000;
  state.settings.includeCash = false;
  saveState(); scheduleRefresh(); render(); showToast("Ayarlar kaydedildi.");
}

function hasPortfolioContent() {
  return state.isDemo
    || state.transactions.length > 0
    || state.watchlist.length > 0
    || state.closedPositions.length > 0
    || state.journal.length > 0;
}

function updateExperiencePrompts() {
  const banner = $("#demoBanner");
  if (banner) banner.hidden = !state.isDemo;
  const clearButton = $("#clearDemoButton");
  if (clearButton) clearButton.hidden = !state.isDemo;
  if (!onboardingReady) return;
  const dialog = $("#onboardingDialog");
  const needsOnboarding = !state.onboardingCompleted && !hasPortfolioContent();
  if (needsOnboarding) {
    setCloudImportGuideVisible(false);
    if (dialog && !dialog.open) dialog.showModal();
  } else if (dialog?.open) {
    dialog.close();
  }
}

function startDemoMode() {
  const settings = { ...state.settings };
  state = migrateState({ ...clone(sampleState), settings, onboardingCompleted: true });
  saveState();
  render();
  $("#onboardingDialog")?.close();
  showToast("Örnek portföy açıldı. Tüm örnek fiyatlar canlı olmayan veri olarak işaretlendi.");
}

function completeOnboardingEmpty() {
  state.onboardingCompleted = true;
  saveState();
  $("#onboardingDialog")?.close();
  render();
  showToast("Boş portföy hazır. İlk işlemini dilediğinde ekleyebilirsin.");
}

function clearDemo() {
  if (state.isDemo || state.transactions.some(tx => tx.demo)) {
    state.dailySnapshots = (state.dailySnapshots || []).map(snapshot => ({ ...snapshot, isDemo: snapshot.isDemo ?? true }));
  }
  const demoSymbols = new Set(sampleState.transactions.filter(tx => tx.symbol).map(tx => tx.symbol));
  const retainedTransactions = state.transactions.filter(tx => !tx.demo);
  const retainedSymbols = new Set(retainedTransactions.map(tx => tx.symbol).filter(Boolean));
  const retainedPrices = Object.fromEntries(Object.entries(state.prices).filter(([symbol]) => !demoSymbols.has(symbol) || retainedSymbols.has(symbol)));
  state.transactions = retainedTransactions;
  state.closedPositions = state.closedPositions.filter(position => !position.demo);
  state.journal = state.journal.filter(entry => !entry.demo);
  state.prices = retainedPrices;
  state.history = [];
  state.isDemo = false;
  state.onboardingCompleted = true;
  saveState(); render(); showToast("Örnek veriler temizlendi; kendi kayıtların korundu.");
}
function resetAll() {
  if (!confirm("Tüm yerel işlem, harcama, yatırım tezi, bütçe, not ve ayarlar silinecek. Devam etmek istiyor musun?")) return;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(STORAGE_BACKUP_KEY);
  localStorage.removeItem(STORAGE_RECOVERY_KEY);
  state = migrateState(createEmptyState());
  saveState({ recordUndo: false });
  render(); renderClosedPositions(); showToast("Yerel veriler sıfırlandı.", { undo: false });
}
function exportCsv() {
  const headings = ["Tarih", "İşlem", "Piyasa", "Sembol", "Ad", "Para birimi", "Adet", "Birim fiyat", "Komisyon", "Kâr paylaşımı / aile payı"];
  const rows = state.transactions.map(tx => [tx.date, transactionLabel(tx.type), tx.market, tx.symbol, tx.name, tx.currency, tx.quantity, tx.quotedPrice ?? tx.price, tx.fee, tx.profitShare || 0]);
  const csv = [headings, ...rows].map(row => row.map(value => `"${String(value ?? "").replace(/"/g, '""')}"`).join(";")).join("\r\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `yatirim-defteri-${today()}.csv`; a.click(); URL.revokeObjectURL(url); showToast("İşlem defteri CSV olarak indirildi.");
}
function activatePage(page) {
  $$(".page").forEach(el => el.classList.toggle("active", el.id === `${page}Page`));
  $$(".nav-item[data-page]").forEach(el => el.classList.toggle("active", el.dataset.page === page));
  const primaryMobilePages = ["dashboard", "portfolio", "expenses", "transactions"];
  $$(".mobile-nav-item").forEach(el => {
    const isMore = el.id === "mobileMoreButton";
    el.classList.toggle("active", isMore ? !primaryMobilePages.includes(page) : el.dataset.mobilePage === page);
  });
  const titles = { dashboard: ["GENEL BAKIŞ", Core.greetingForUser(currentPortfolioUser || { username: state.settings.username })], expenses: ["AYLIK HARCAMA TAKİBİ", "Harcamaların"], decision: ["KARAR MERKEZİ", "Bütçen ve yatırım tezlerin"], portfolio: ["PORTFÖY", "Pozisyonların"], trendCheck: ["TREND CHECK", "Trendin dayanıklılığı"], calendar: ["FİNANSAL TAKVİM", "Önemli tarihler"], watchlist: ["TAKİP LİSTESİ", "İzlediğin hisseler"], closed: ["KAPANMIŞ POZİSYONLAR", "Gerçekleşen kâr/zarar ve işlem geçmişi"], transactions: ["İŞLEM DEFTERİ", "Tüm hareketler"], ipo: ["HALKA ARZLAR", "Tavan serilerini izle"], journal: ["YATIRIM GÜNLÜĞÜ", "Kararlarını kaydet"], settings: ["AYARLAR", "Uygulamanı düzenle"], stockDetail: ["ABD HİSSE DETAYI", stockDetailView.symbol || "Hisse Detay Merkezi"], fundamentalAnalysis: ["TEMEL ANALİZ", `${stockDetailView.symbol || "Hisse"} · Finansal sağlık ve değerleme`] };
  const title = titles[page] || titles.dashboard;
  $("#pageEyebrow").textContent = title[0]; $("#pageTitle").textContent = title[1];
  updateDashboardGreeting();
  window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  if (page === "calendar") void refreshAutomaticFinancialCalendar();
}

function setSidebarCollapsed(collapsed, { persist = true } = {}) {
  const desktop = !window.matchMedia("(max-width: 780px)").matches;
  const active = Boolean(collapsed) && desktop;
  document.documentElement.classList.toggle("sidebar-collapsed", active);

  const sidebar = $("#appSidebar");
  const button = $("#sidebarToggle");
  const label = button?.querySelector(".sidebar-toggle-label");
  const icon = button?.querySelector(".sidebar-toggle-icon");
  sidebar?.setAttribute("aria-hidden", String(active));
  if (button) {
    button.setAttribute("aria-expanded", String(!active));
    button.setAttribute("aria-label", active ? "Kenar çubuğunu aç" : "Kenar çubuğunu gizle");
    button.title = active ? "Kenar çubuğunu aç" : "Kenar çubuğunu gizle";
  }
  if (label) label.textContent = active ? "Menüyü aç" : "Menüyü gizle";
  if (icon) icon.textContent = active ? "☰" : "←";

  if (persist) {
    try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0"); } catch (_) {}
  }
}

function initializeSidebarToggle() {
  const readPreference = () => {
    try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1"; }
    catch (_) { return document.documentElement.classList.contains("sidebar-collapsed"); }
  };
  const media = window.matchMedia("(max-width: 780px)");
  setSidebarCollapsed(readPreference(), { persist: false });
  $("#sidebarToggle")?.addEventListener("click", () => {
    setSidebarCollapsed(!document.documentElement.classList.contains("sidebar-collapsed"));
  });
  const syncWithViewport = () => setSidebarCollapsed(readPreference(), { persist: false });
  if (typeof media.addEventListener === "function") media.addEventListener("change", syncWithViewport);
  else if (typeof media.addListener === "function") media.addListener(syncWithViewport);
}

function bindEvents() {
  initializeSidebarToggle();
  bindInformationButtons();
  $("#completePerformanceHistory")?.addEventListener("click", () => void completePerformanceHistory(true));
  $("#refreshEtfMarketButton")?.addEventListener("click", () => void loadEtfMarketOverview(true));
  if (typeof ResizeObserver !== "undefined") {
    const widths = new WeakMap();
    let resizeFrame;
    const chartResize = new ResizeObserver(entries => {
      const changed = entries.some(entry => {
        const width = Math.round(entry.contentRect.width);
        if (width <= 0 || widths.get(entry.target) === width) return false;
        widths.set(entry.target, width); return true;
      });
      if (changed) { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(() => renderChart()); }
    });
    $$(".performance-chart-wrap").forEach(element => chartResize.observe(element));
  }
  setInterval(updateDashboardGreeting, 60000);
  document.addEventListener("visibilitychange", updateDashboardGreeting);
  window.addEventListener("focus", updateDashboardGreeting);
  document.addEventListener("click", event => {
    const button = event.target instanceof Element ? event.target.closest("[data-chart-mode], [data-chart-range], [data-profit-mode]") : null;
    if (!button) return;
    if (button.dataset.chartMode) portfolioChartView.mode = button.dataset.chartMode;
    if (button.dataset.chartRange) portfolioChartView.range = button.dataset.chartRange;
    if (button.dataset.profitMode) profitChartView.mode = button.dataset.profitMode;
    renderChart();
  });
  $$(".nav-item[data-page]").forEach(button => button.addEventListener("click", () => activatePage(button.dataset.page)));
  $$("[data-page-target]").forEach(button => button.addEventListener("click", () => activatePage(button.dataset.pageTarget)));
  document.addEventListener("click", event => {
    if (!(event.target instanceof Element)) return;
    const etfOpen = event.target.closest("[data-etf-open]");
    if (etfOpen) { openStockDetail(etfOpen.dataset.etfOpen); return; }
    const watchlistRemove = event.target.closest("[data-watchlist-remove]");
    if (watchlistRemove) { removeWatchlistSymbol(watchlistRemove.dataset.watchlistRemove); return; }
    const watchlistOpen = event.target.closest("[data-watchlist-open]");
    if (watchlistOpen) { openStockDetail(watchlistOpen.dataset.watchlistOpen); return; }
    const deleteButton = event.target.closest("[data-delete-technical-alert]");
    if (deleteButton) { deleteTechnicalAlert(deleteButton.dataset.deleteTechnicalAlert); return; }
    const restoreVersion = event.target.closest("[data-restore-cloud-revision]");
    if (restoreVersion) { void restoreCloudHistoryVersion(restoreVersion.dataset.restoreCloudRevision); return; }
    const expenseDelete = event.target.closest("[data-expense-delete]");
    if (expenseDelete) { deleteExpense(expenseDelete.dataset.expenseDelete); return; }
    const expenseAnomaly = event.target.closest("[data-expense-anomaly-id]");
    if (expenseAnomaly) {
      const expense = (state.expenses || []).find(item => item.id === expenseAnomaly.dataset.expenseAnomalyId);
      if (!expense) return;
      expenseView.month = expenseReportingMonth(expense, inferredExpenseStatementMonths(state.expenses || []));
      expenseView.filter = "all";
      renderExpenses();
      requestAnimationFrame(() => {
        const row = $$('[data-expense-row-id]').find(item => item.dataset.expenseRowId === expense.id);
        row?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
        row?.classList.add("is-highlighted");
        setTimeout(() => row?.classList.remove("is-highlighted"), 1500);
      });
      return;
    }
    const expenseFilter = event.target.closest("[data-expense-filter]");
    if (expenseFilter) { expenseView.filter = expenseFilter.dataset.expenseFilter; renderExpenses(); return; }
    const thesisEdit = event.target.closest("[data-thesis-edit]");
    if (thesisEdit) { populateThesisForm((state.stockTheses || []).find(item => item.id === thesisEdit.dataset.thesisEdit)); return; }
    const thesisDelete = event.target.closest("[data-thesis-delete]");
    if (thesisDelete) { deleteStockThesis(thesisDelete.dataset.thesisDelete); return; }
    const thesisTechnical = event.target.closest("[data-thesis-technical]");
    if (thesisTechnical) { openTechnicalAnalysis(thesisTechnical.dataset.thesisTechnical); return; }
    const thesisCalendar = event.target.closest("[data-thesis-calendar]");
    if (thesisCalendar) {
      const symbol = thesisCalendar.dataset.thesisCalendar || "";
      activatePage("calendar");
      if ($("#calendarEventType")) $("#calendarEventType").value = "earnings";
      if ($("#calendarEventSymbol")) $("#calendarEventSymbol").value = symbol;
      if ($("#calendarEventTitle")) $("#calendarEventTitle").value = `${decisionSymbolKey(symbol)} bilançosu`;
      $("#calendarEventDate")?.focus();
      return;
    }
    const briefPage = event.target.closest("[data-brief-page]");
    if (briefPage) { activatePage(briefPage.dataset.briefPage); return; }
    const calendarDay = event.target.closest("[data-calendar-day]");
    if (calendarDay) { selectCalendarDay(calendarDay.dataset.calendarDay); return; }
    const calendarShift = event.target.closest("[data-calendar-shift]");
    if (calendarShift) { shiftFinancialCalendar(Number(calendarShift.dataset.calendarShift) || 0); return; }
    if (event.target.closest("[data-calendar-today]")) { calendarView.month = today().slice(0, 7); selectCalendarDay(today()); return; }
    const calendarOpenDate = event.target.closest("[data-calendar-open-date]");
    if (calendarOpenDate) { selectCalendarDay(calendarOpenDate.dataset.calendarOpenDate); return; }
    if (event.target.closest("[data-calendar-refresh]")) { void refreshAutomaticFinancialCalendar({ force: true }); return; }
    const calendarDelete = event.target.closest("[data-calendar-delete]");
    if (calendarDelete) { deleteCalendarEvent(calendarDelete.dataset.calendarDelete); return; }
    const trendSymbol = event.target.closest("[data-trend-symbol]");
    if (trendSymbol) {
      $("#trendCheckSymbol").value = trendSymbol.dataset.trendSymbol || "";
      $("#trendCheckMarket").value = trendSymbol.dataset.trendMarket || Core.normalizeMarket("", trendSymbol.dataset.trendSymbol);
      $("#trendCheckCost").value = trendSymbol.dataset.trendCost || "";
      $("#trendCheckForm")?.requestSubmit();
      return;
    }
    if (event.target.closest("[data-trend-retry]")) { void runTrendCheck(); return; }
    const retryService = event.target.closest("[data-retry-service]");
    if (retryService?.dataset.retryService === "technical") { void loadTechnicalHistory(); return; }
    if (retryService?.dataset.retryService === "cloud-history") { void openCloudHistory(); return; }
    if (event.target.closest("[data-check-connection]")) {
      $("#technicalDialog")?.close();
      activatePage("settings");
      void loadRuntimeHealth({ notify: true });
      return;
    }
    const holdingRow = event.target.closest(".holding-row[data-holding-symbol]");
    if (holdingRow && !event.target.closest("button, a, summary, details, input, select, textarea")) { openStockDetail(holdingRow.dataset.holdingSymbol); return; }
    const watchlistRow = event.target.closest(".watchlist-row[data-watchlist-symbol]");
    if (watchlistRow) openStockDetail(watchlistRow.dataset.watchlistSymbol);
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (!(event.target instanceof Element)) return;
    const row = event.target.closest(".holding-row[data-holding-symbol], .watchlist-row[data-watchlist-symbol]");
    if (!row || event.target !== row) return;
    event.preventDefault(); openStockDetail(row.dataset.holdingSymbol || row.dataset.watchlistSymbol);
  });
  $("#refreshButton").addEventListener("click", refreshQuotes);
  $("#expenseStatementInput")?.addEventListener("change", event => {
    const file = event.target.files?.[0];
    event.target.value = "";
    void importExpenseStatement(file);
  });
  $("#expenseMonthPicker")?.addEventListener("change", event => {
    if (!/^\d{4}-\d{2}$/.test(event.target.value)) return;
    expenseView.month = event.target.value;
    renderExpenses();
  });
  $("#expenseTable")?.addEventListener("change", event => {
    const checkbox = event.target.closest("[data-expense-family]");
    if (checkbox) toggleExpenseFamily(checkbox.dataset.expenseFamily, checkbox.checked);
  });
  const expenseDropzone = $("#expenseDropzone");
  expenseDropzone?.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    $("#expenseStatementInput")?.click();
  });
  ["dragenter", "dragover"].forEach(type => expenseDropzone?.addEventListener(type, event => {
    event.preventDefault();
    expenseDropzone.classList.add("is-dragover");
  }));
  ["dragleave", "drop"].forEach(type => expenseDropzone?.addEventListener(type, event => {
    event.preventDefault();
    expenseDropzone.classList.remove("is-dragover");
  }));
  expenseDropzone?.addEventListener("drop", event => void importExpenseStatement(event.dataTransfer?.files?.[0]));
  const totalValueElement = $("#totalValue");
  if (totalValueElement) {
    const toggleTotalValueCurrency = () => {
      renderDashboard._showingAlternateCurrency = !renderDashboard._showingAlternateCurrency;
      renderDashboard(calculatePortfolio());
    };
    totalValueElement.addEventListener("click", toggleTotalValueCurrency);
    totalValueElement.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleTotalValueCurrency();
    });
  }
  $("#stockDetailBackButton")?.addEventListener("click", () => activatePage(stockDetailView.returnPage || "portfolio"));
  $("#stockDetailRefreshButton")?.addEventListener("click", async () => {
    await refreshQuotes({ quiet: true });
    await loadStockDetail({ force: true });
  });
  $("#stockDetailWatchlistButton")?.addEventListener("click", toggleStockDetailWatchlist);
  $("#openStockTechnicalButton")?.addEventListener("click", () => {
    if (stockDetailView.symbol) openTechnicalAnalysis(stockDetailView.symbol);
  });
  $("#openStockFundamentalButton")?.addEventListener("click", openFundamentalAnalysis);
  $("#fundamentalBackButton")?.addEventListener("click", () => {
    activatePage("stockDetail");
    renderStockDetail();
  });
  $("#fundamentalRefreshButton")?.addEventListener("click", async () => {
    await refreshQuotes({ quiet: true });
    await loadStockDetail({ force: true });
  });
  $("#themeToggle").addEventListener("click", () => {
    state.settings.theme = state.settings.theme === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", state.settings.theme);
    saveState();
  });
  $("#addTransactionButton").addEventListener("click", () => openTransaction());
  $("#closeDialogButton").addEventListener("click", () => $("#transactionDialog").close());
  $("#cancelDialogButton").addEventListener("click", () => $("#transactionDialog").close());
  $("#transactionType").addEventListener("change", () => {
    updateTransactionForm();
    handleTransactionCalculation("quantity");
  });
  $("#transactionForm").addEventListener("submit", saveTransaction);
  $("#watchlistForm")?.addEventListener("submit", saveWatchlistItem);
  $("#trendCheckForm")?.addEventListener("submit", event => { event.preventDefault(); void runTrendCheck(); });
  $("#investmentBudgetForm")?.addEventListener("submit", saveInvestmentBudget);
  $("#stockThesisForm")?.addEventListener("submit", saveStockThesis);
  $("#cancelThesisEdit")?.addEventListener("click", () => { resetThesisForm(); renderDecisionCenter(calculatePortfolio()); });
  $("#calendarEventForm")?.addEventListener("submit", saveCalendarEvent);
  
  $("#saveSettingsButton").addEventListener("click", saveSettings);
  $("#runHealthCheckButton")?.addEventListener("click", () => loadRuntimeHealth({ notify: true }));
  $("#clearDemoButton").addEventListener("click", clearDemo);
  $("#exitDemoButton")?.addEventListener("click", clearDemo);
  $("#onboardingDemoButton")?.addEventListener("click", startDemoMode);
  $("#onboardingEmptyButton")?.addEventListener("click", completeOnboardingEmpty);
  $("#onboardingAddButton")?.addEventListener("click", () => {
    state.onboardingCompleted = true;
    saveState();
    $("#onboardingDialog")?.close();
    openTransaction();
  });
  $("#onboardingImportButton")?.addEventListener("click", () => $("#backupFileInput")?.click());
  $("#conflictKeepLocal")?.addEventListener("click", () => void resolveCloudConflict("local"));
  $("#conflictMerge")?.addEventListener("click", () => void resolveCloudConflict("merge"));
  $("#conflictUseCloud")?.addEventListener("click", () => void resolveCloudConflict("cloud"));
  $("#conflictDecideLater")?.addEventListener("click", () => $("#cloudConflictDialog")?.close());
  $("#cloudHistoryButton")?.addEventListener("click", openCloudHistory);
  $("#closeCloudHistoryButton")?.addEventListener("click", () => $("#cloudHistoryDialog")?.close());
  $$('[data-mobile-page]').forEach(button => button.addEventListener("click", () => {
    activatePage(button.dataset.mobilePage);
    $("#mobileMoreDialog")?.close();
  }));
  $("#mobileMoreButton")?.addEventListener("click", () => $("#mobileMoreDialog")?.showModal());
  $("#closeMobileMoreButton")?.addEventListener("click", () => $("#mobileMoreDialog")?.close());
  $("#mobileDataManagementButton")?.addEventListener("click", () => {
    activatePage("settings");
    $("#mobileMoreDialog")?.close();
    setTimeout(() => $(".danger-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }), 120);
  });
  $("#resetAllButton").addEventListener("click", resetAll);
  $("#exportButton").addEventListener("click", exportCsv);
  $("#exportBackupButton")?.addEventListener("click", exportFullBackup);
  $("#importBackupButton")?.addEventListener("click", () => $("#backupFileInput")?.click());
  $("#cloudImportButton")?.addEventListener("click", () => $("#backupFileInput")?.click());
  $("#backupFileInput")?.addEventListener("change", importFullBackup);
  $("#openDangerZoneButton")?.addEventListener("click", openPortfolioDangerDialog);
  $("#confirmClearPortfolioButton")?.addEventListener("click", window.clearAllHoldings);
  $("#closeDangerActionsButton")?.addEventListener("click", () => $("#dangerActionsDialog")?.close());
  $("#cancelDangerActionsButton")?.addEventListener("click", () => $("#dangerActionsDialog")?.close());
  [["#executiveReportToggle", ".executive-report-panel"], ["#benchmarkPanelToggle", ".benchmark-panel"]].forEach(([buttonSelector, panelSelector]) => {
    $(buttonSelector)?.addEventListener("click", event => {
      const panel = $(panelSelector);
      const expanded = panel?.classList.toggle("is-collapsed") === false;
      event.currentTarget.setAttribute("aria-expanded", String(expanded));
      event.currentTarget.textContent = expanded ? "Gizle" : "Göster";
    });
  });
  $("#closeTechnicalDialogButton").addEventListener("click", () => $("#technicalDialog").close());
  $$("#technicalPeriodGroup button[data-technical-period]").forEach(button => button.addEventListener("click", () => {
    technicalView.period = button.dataset.technicalPeriod;
    technicalView.points = [];
    loadTechnicalHistory();
  }));
  [["#toggleSma20", "sma20"], ["#toggleSma50", "sma50"], ["#toggleSma200", "sma200"], ["#toggleChannel", "channel"]].forEach(([selector, key]) => {
    $(selector).addEventListener("change", event => { technicalView.indicators[key] = event.target.checked; renderTechnicalAnalysis(); });
  });
  $("#technicalAlertType").addEventListener("change", updateTechnicalAlertForm);
  $("#technicalAlertForm").addEventListener("submit", saveTechnicalAlert);
  updateTechnicalAlertForm();

  // AI Butonları
  $("#aiAnalyzeButton").addEventListener("click", () => {
    technicalView.aiResult = null;
    technicalView.aiError = "";
    callGeminiAI();
  });
  $("#saveAiSettingsButton")?.addEventListener("click", saveAiSettings);
  $("#saveSecSettingsButton")?.addEventListener("click", saveSecSettings);
  $("#toggleApiKeyVisibility")?.addEventListener("click", () => {
    const input = $("#geminiApiKeyInput");
    if (input) input.type = input.type === "password" ? "text" : "password";
  });
  $("#saveTgSettingsButton")?.addEventListener("click", saveTelegramSettings);
  $("#toggleTgTokenVisibility")?.addEventListener("click", () => {
    const input = $("#tgBotTokenInput");
    if (input) input.type = input.type === "password" ? "text" : "password";
  });


  $("#transactionTotal").addEventListener("input", () => handleTransactionCalculation("total"));
  $("#transactionPrice").addEventListener("input", () => handleTransactionCalculation("price"));
  $("#transactionQuantity").addEventListener("input", () => handleTransactionCalculation("quantity"));
  $("#transactionFee").addEventListener("input", () => handleTransactionCalculation("quantity"));
  $("#transactionSymbol").addEventListener("change", handleSymbolAutoFill);
  $("#transactionSymbol").addEventListener("blur", handleSymbolAutoFill);

  $$("#allocationModeGroup button[data-alloc-mode]").forEach(button => {
    button.addEventListener("click", () => {
      allocationMode = button.dataset.allocMode;
      renderAllocation(calculatePortfolio());
    });
  });

  $("#aiReportRefreshBtn")?.addEventListener("click", () => {
    showToast("Aylık ve genel özet güncellendi.");
    renderExecutiveReport(calculatePortfolio());
  });

  // Closed Positions & Excel Import Events
  $("#importExcelBtn")?.addEventListener("click", () => $("#excelFileInput").click());
  $("#excelFileInput")?.addEventListener("change", handleFileUpload);
  $("#addClosedPosBtn")?.addEventListener("click", openClosedPosModal);
  $("#closedPosForm")?.addEventListener("submit", saveClosedPos);
  $("#closeClosedPosDialogBtn")?.addEventListener("click", () => $("#closedPosDialog").close());
  $("#cancelClosedPosBtn")?.addEventListener("click", () => $("#closedPosDialog").close());
  $("#closeImportDialogBtn")?.addEventListener("click", () => $("#importDialog").close());
  $("#cancelImportBtn")?.addEventListener("click", () => $("#importDialog").close());

  ["#closedSearchInput", "#closedFilterType", "#closedSortBy"].forEach(sel => {
    $(sel)?.addEventListener("change", renderClosedPositions);
    $(sel)?.addEventListener("input", renderClosedPositions);
  });

  $$("#benchmarkTimeframeGroup button[data-period]").forEach(button => {
    button.addEventListener("click", () => {
      $$("#benchmarkTimeframeGroup button").forEach(b => b.classList.remove("active"));
      button.classList.add("active");
      benchmarkPeriod = button.dataset.period;
      renderBenchmark(calculatePortfolio());
    });
  });
}

function renderChartOverlayLines(metrics, currency) {
  const svg = document.getElementById("technicalChart");
  if (!svg) return;

  // Temizle
  svg.querySelectorAll(".overlay-line, .overlay-hit-area, .overlay-label, .overlay-leader, .sr-breakout-marker, .sl-line-overlay, .sl-line-label, .sr-line, .sr-label").forEach(el => el.remove());
  
  let tooltip = document.getElementById("chartOverlayTooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "chartOverlayTooltip";
    tooltip.className = "chart-overlay-tooltip";
    document.body.appendChild(tooltip);
  }
  tooltip.style.display = "none";

  const levels = calculateLevels(metrics, null);
  const breakout = technicalView.breakoutAnalysis || analyzeBreakouts(metrics, technicalView.points);
  const width = 720, height = 300, left = 52, right = 14, top = 18, bottom = 25;

  const closes = metrics.closes;
  const shown = [closes,
    technicalView.indicators.sma20  ? metrics.sma20Array  : [],
    technicalView.indicators.sma50  ? metrics.sma50Array  : [],
    technicalView.indicators.sma200 ? metrics.sma200Array : [],
    technicalView.indicators.channel ? metrics.priceChannel.lower : [],
    technicalView.indicators.channel ? metrics.priceChannel.upper : [],
  ];
  const allVals = shown.flat().filter(Number.isFinite);
  if (!allVals.length) return;

  const rawMin = Math.min(...allVals), rawMax = Math.max(...allVals);
  const padding = Math.max((rawMax - rawMin) * 0.08, rawMax * 0.01, 0.01);
  const minValue = rawMin - padding, maxValue = rawMax + padding;
  const yFor = v => top + ((maxValue - v) / (maxValue - minValue || 1)) * (height - top - bottom);
  const fmt = v => formatMoney(v, currency, { maximumFractionDigits: 2 });
  const price = metrics.price;

  const candidateLines = [
    {
      id: "stopBalanced",
      label: "Dengeli Stop-Loss",
      shortLabel: "Dengeli Stop",
      val: levels.stops && levels.stops.balanced ? levels.stops.balanced.val : null,
      pct: levels.stops && levels.stops.balanced ? levels.stops.balanced.pct : null,
      color: "#f97316", // Turuncu (Orange)
      dash: "none",
      width: 2,
      desc: "2.5×ATR + Pivot Destek eşiği",
      active: technicalView.overlays.stopBalanced,
      type: "stop"
    },
    {
      id: "stopConservative",
      label: "Muhafazakâr Stop-Loss",
      shortLabel: "Muh. Stop",
      val: levels.stops && levels.stops.conservative ? levels.stops.conservative.val : null,
      pct: levels.stops && levels.stops.conservative ? levels.stops.conservative.pct : null,
      color: "#ef4444", // Kırmızı (Red)
      dash: "2 3",
      width: 1.5,
      desc: "1.5×ATR volatilite bazı",
      active: technicalView.overlays.stopConservative,
      type: "stop"
    },
    {
      id: "stopAggressive",
      label: "Agresif Stop-Loss",
      shortLabel: "Agresif Stop",
      val: levels.stops && levels.stops.aggressive ? levels.stops.aggressive.val : null,
      pct: levels.stops && levels.stops.aggressive ? levels.stops.aggressive.pct : null,
      color: "#a855f7", // Mor (Purple)
      dash: "6 3",
      width: 1.5,
      desc: "SMA50 / 40g swing bazı",
      active: technicalView.overlays.stopAggressive,
      type: "stop"
    },
    {
      id: "res1",
      label: "Direnç 1",
      shortLabel: "D1",
      val: breakout.resistances && breakout.resistances[0] ? breakout.resistances[0].price : null,
      pct: breakout.resistances && breakout.resistances[0] ? (breakout.resistances[0].price - price) / price * 100 : null,
      color: "#f43f5e", // Koral (Coral)
      dash: "8 4",
      width: 2,
      desc: breakout.resistances && breakout.resistances[0] ? `${breakout.resistances[0].strength} direnç (${breakout.resistances[0].testCount}× test)` : "En yakın direnç",
      active: technicalView.overlays.res1,
      type: "res"
    },
    {
      id: "res2",
      label: "Direnç 2",
      shortLabel: "D2",
      val: breakout.resistances && breakout.resistances[1] ? breakout.resistances[1].price : null,
      pct: breakout.resistances && breakout.resistances[1] ? (breakout.resistances[1].price - price) / price * 100 : null,
      color: "#e11d48", // Koyu Kırmızı (Crimson)
      dash: "4 4",
      width: 1.5,
      desc: breakout.resistances && breakout.resistances[1] ? `${breakout.resistances[1].strength} direnç (${breakout.resistances[1].testCount}× test)` : "İkinci direnç",
      active: technicalView.overlays.res2,
      type: "res"
    },
    {
      id: "sup1",
      label: "Destek 1",
      shortLabel: "S1",
      val: breakout.supports && breakout.supports[0] ? breakout.supports[0].price : null,
      pct: breakout.supports && breakout.supports[0] ? (breakout.supports[0].price - price) / price * 100 : null,
      color: "#10b981", // Zümrüt Yeşili (Emerald)
      dash: "8 4",
      width: 2,
      desc: breakout.supports && breakout.supports[0] ? `${breakout.supports[0].strength} destek (${breakout.supports[0].testCount}× test)` : "En yakın destek",
      active: technicalView.overlays.sup1,
      type: "sup"
    },
    {
      id: "sup2",
      label: "Destek 2",
      shortLabel: "S2",
      val: breakout.supports && breakout.supports[1] ? breakout.supports[1].price : null,
      pct: breakout.supports && breakout.supports[1] ? (breakout.supports[1].price - price) / price * 100 : null,
      color: "#14b8a6", // Turkuaz (Teal)
      dash: "4 4",
      width: 1.5,
      desc: breakout.supports && breakout.supports[1] ? `${breakout.supports[1].strength} destek (${breakout.supports[1].testCount}× test)` : "İkinci destek",
      active: technicalView.overlays.sup2,
      type: "sup"
    }
  ];

  const activeLines = candidateLines.filter(line => line.active && line.val !== null && line.val >= minValue && line.val <= maxValue);

  activeLines.forEach(line => {
    line.rawY = yFor(line.val);
  });

  activeLines.sort((a, b) => a.rawY - b.rawY);

  const MIN_GAP = 14;
  activeLines.forEach((line, idx) => {
    if (idx === 0) {
      line.adjustedY = line.rawY;
    } else {
      const prevY = activeLines[idx - 1].adjustedY;
      if (line.rawY - prevY < MIN_GAP) {
        line.adjustedY = prevY + MIN_GAP;
      } else {
        line.adjustedY = line.rawY;
      }
    }
  });

  activeLines.forEach(line => {
    const rawYStr = line.rawY.toFixed(1);
    const adjYStr = line.adjustedY.toFixed(1);

    const lineEl = document.createElementNS("http://www.w3.org/2000/svg", "line");
    lineEl.setAttribute("class", "overlay-line");
    lineEl.setAttribute("x1", left);
    lineEl.setAttribute("x2", width - right);
    lineEl.setAttribute("y1", rawYStr);
    lineEl.setAttribute("y2", rawYStr);
    lineEl.setAttribute("stroke", line.color);
    lineEl.setAttribute("stroke-width", line.width.toString());
    if (line.dash !== "none") lineEl.setAttribute("stroke-dasharray", line.dash);
    lineEl.setAttribute("opacity", "0.75");
    svg.appendChild(lineEl);

    if (Math.abs(line.adjustedY - line.rawY) > 2) {
      const leader = document.createElementNS("http://www.w3.org/2000/svg", "line");
      leader.setAttribute("class", "overlay-leader");
      leader.setAttribute("x1", width - right - 2);
      leader.setAttribute("x2", width - right + 4);
      leader.setAttribute("y1", rawYStr);
      leader.setAttribute("y2", adjYStr);
      leader.setAttribute("stroke", line.color);
      leader.setAttribute("stroke-width", "1");
      leader.setAttribute("opacity", "0.5");
      svg.appendChild(leader);
    }

    const textEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
    textEl.setAttribute("class", "overlay-label");
    textEl.setAttribute("x", width - right - 5);
    textEl.setAttribute("y", (parseFloat(adjYStr) + 3).toFixed(1));
    textEl.setAttribute("font-size", "11");
    textEl.setAttribute("text-anchor", "end");
    textEl.setAttribute("font-weight", "600");
    textEl.setAttribute("fill", line.color);
    textEl.textContent = line.shortLabel;
    svg.appendChild(textEl);

    const hitEl = document.createElementNS("http://www.w3.org/2000/svg", "line");
    hitEl.setAttribute("class", "overlay-hit-area");
    hitEl.setAttribute("x1", left);
    hitEl.setAttribute("x2", width - right + 40);
    hitEl.setAttribute("y1", rawYStr);
    hitEl.setAttribute("y2", rawYStr);
    hitEl.setAttribute("stroke", "transparent");
    hitEl.setAttribute("stroke-width", "14");
    hitEl.setAttribute("cursor", "pointer");

    const showTooltip = (e) => {
      lineEl.setAttribute("opacity", "1");
      lineEl.setAttribute("stroke-width", (line.width + 1).toString());
      
      handleChartHover(e, 52, 654);

      const pctStr = line.pct !== null ? `${line.pct >= 0 ? "+" : ""}${line.pct.toFixed(1)}% fiyattan` : "";
      tooltip.innerHTML = `
        <div class="overlay-tt-header" style="color:${line.color}">● ${escapeHtml(line.label)}</div>
        <div class="overlay-tt-price">${fmt(line.val)} <span class="overlay-tt-pct">${pctStr}</span></div>
        <div class="overlay-tt-desc">${escapeHtml(line.desc)}</div>
      `;
      tooltip.style.display = "block";
      tooltip.style.left = `${e.pageX + 12}px`;
      tooltip.style.top = `${e.pageY - 28}px`;
    };

    const hideTooltip = (e) => {
      lineEl.setAttribute("opacity", "0.75");
      lineEl.setAttribute("stroke-width", line.width.toString());
      tooltip.style.display = "none";
      if (e && e.clientX) {
        const svgRect = svg.getBoundingClientRect();
        if (e.clientX < svgRect.left + 52 || e.clientX > svgRect.right - 14 || e.clientY < svgRect.top + 18 || e.clientY > svgRect.bottom - 25) {
          hideCrosshair();
        }
      }
    };

    hitEl.addEventListener("mousemove", showTooltip);
    hitEl.addEventListener("mouseleave", hideTooltip);
    hitEl.addEventListener("touchstart", (e) => {
      showTooltip(e.touches[0]);
    }, { passive: true });

    svg.appendChild(hitEl);
  });

  if (breakout.event && breakout.event.type !== 'whipsaw' && breakout.event.type !== 'bounce') {
    const { event } = breakout;
    if (event.price >= minValue && event.price <= maxValue) {
      const y = yFor(event.price);
      const isUp = event.type === 'breakout';
      const marker = document.createElementNS("http://www.w3.org/2000/svg", "text");
      marker.setAttribute("class", "sr-breakout-marker");
      marker.setAttribute("x", (width - right - 20).toFixed(1));
      marker.setAttribute("y", (y + (isUp ? 4 : -4)).toFixed(1));
      marker.setAttribute("font-size", "12");
      marker.setAttribute("fill", isUp ? "#10b981" : "#ef4444");
      marker.setAttribute("text-anchor", "middle");
      marker.textContent = isUp ? "▲" : "▼";
      svg.appendChild(marker);
    }
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// ÖZET KART (TECHNICAL OVERVIEW SUMMARY CARD)
// ═══════════════════════════════════════════════════════════════════════════════

function renderTechnicalOverviewCard(metrics, currency) {
  const el = document.getElementById("technicalOverviewContent");
  if (!el) return;

  const holding = calculatePortfolio().holdings.find(h => h.symbol === technicalView.symbol);
  const avgCost = holding ? holding.avgCost : null;
  const levels  = calculateLevels(metrics, avgCost);
  const breakout = technicalView.breakoutAnalysis || analyzeBreakouts(metrics, technicalView.points);

  const fmt = v => formatMoney(v, currency, { maximumFractionDigits: 2 });
  const price = metrics.price;
  const event = breakout?.event || null;
  const nearestSup = breakout?.nearestSupport || null;
  const nearestRes = breakout?.nearestResistance || null;
  const lastMacd = latestFinite(metrics.macdLine);
  const lastSignal = latestFinite(metrics.macdSignal);
  const lastHistogram = latestFinite(metrics.macdHist);
  const previousHistogram = latestFinite(metrics.macdHist.slice(0, -1));
  const previousClose = metrics.closes.at(-2);
  const lastMove = Number.isFinite(previousClose) && previousClose > 0 ? (price - previousClose) / previousClose * 100 : 0;
  const volumeWindow = metrics.volumes.slice(-20);
  const hasVolume = volumeWindow.some(value => value > 0);
  const averageVolume = hasVolume ? volumeWindow.reduce((sum, value) => sum + value, 0) / volumeWindow.length : 0;
  const latestVolume = metrics.volumes.at(-1) || 0;
  const volumeRatio = averageVolume > 0 ? latestVolume / averageVolume : null;
  const signals = [];
  const addSignal = (name, direction, weight = 1) => {
    if (!direction) return;
    signals.push({ name, direction, weight });
  };
  const addPriceComparison = (name, reference, weight) => {
    if (Number.isFinite(reference)) addSignal(name, price >= reference ? 1 : -1, weight);
  };

  addPriceComparison("SMA20", metrics.sma20, 1);
  addPriceComparison("SMA50", metrics.sma50, 1.25);
  addPriceComparison("SMA200", metrics.sma200, 1.5);
  if (Number.isFinite(metrics.sma20) && Number.isFinite(metrics.sma50)) addSignal("SMA20/SMA50 sıralaması", metrics.sma20 >= metrics.sma50 ? 1 : -1, 1);
  if (Number.isFinite(metrics.rsi)) {
    if (metrics.rsi >= 50 && metrics.rsi < 70) addSignal("RSI(14)", 1, .8);
    else if (metrics.rsi < 40) addSignal("RSI(14)", -1, .8);
  }
  if (Number.isFinite(lastMacd) && Number.isFinite(lastSignal)) addSignal("MACD", lastMacd >= lastSignal ? 1 : -1, 1.2);
  if (metrics.priceChannel?.code !== "insufficient" && metrics.priceChannel?.fit >= .2) {
    addSignal("Trend kanalı", metrics.priceChannel.direction === "up" ? 1 : metrics.priceChannel.direction === "down" ? -1 : 0, 1.1);
  }
  if (event?.type === "breakout") addSignal("Direnç kırılımı", 1, 1.5);
  if (event?.type === "breakdown") addSignal("Destek kırılımı", -1, 1.5);
  if (event?.type === "bounce") addSignal("Destekten tepki", 1, .6);
  if (event?.type === "whipsaw") addSignal("Yalancı kırılım", -1, .6);
  if (Number.isFinite(volumeRatio) && volumeRatio >= 1.2 && Math.abs(lastMove) >= .15) addSignal("Hacim teyidi", lastMove >= 0 ? 1 : -1, .8);

  const positiveWeight = signals.filter(item => item.direction > 0).reduce((sum, item) => sum + item.weight, 0);
  const negativeWeight = signals.filter(item => item.direction < 0).reduce((sum, item) => sum + item.weight, 0);
  const directionalWeight = positiveWeight + negativeWeight;
  const balance = directionalWeight ? (positiveWeight - negativeWeight) / directionalWeight : 0;
  const agreement = directionalWeight ? Math.round(Math.max(positiveWeight, negativeWeight) / directionalWeight * 100) : 0;
  let statusKey = signals.length < 3 ? "NEUTRAL" : balance >= .22 ? "POSITIVE" : balance <= -.22 ? "NEGATIVE" : "NEUTRAL";

  const periodLabels = { "1d": "1 günlük", "1w": "1 haftalık", "1mo": "1 aylık", "3mo": "3 aylık", "6mo": "6 aylık", ytd: "yılbaşından bugüne", "1y": "1 yıllık" };
  const periodLabel = periodLabels[technicalView.period] || "seçili dönem";
  const status = {
    POSITIVE: { label: "OLUMLU", icon: "●", badgeClass: "status-positive", tone: "positive" },
    NEUTRAL: { label: "KARARSIZ — BEKLE", icon: "●", badgeClass: "status-caution", tone: "neutral" },
    NEGATIVE: { label: "OLUMSUZ", icon: "●", badgeClass: "status-risky", tone: "negative" }
  }[statusKey];

  const trendPositive = Number.isFinite(metrics.sma20) && Number.isFinite(metrics.sma50) && price > metrics.sma20 && price > metrics.sma50;
  const trendNegative = Number.isFinite(metrics.sma20) && Number.isFinite(metrics.sma50) && price < metrics.sma20 && price < metrics.sma50;
  const trendTone = trendPositive ? "positive" : trendNegative ? "negative" : "neutral";
  const trendLabel = trendPositive ? "Olumlu" : trendNegative ? "Olumsuz" : "Kararsız";
  const smaParts = [];
  if (Number.isFinite(metrics.sma20)) smaParts.push(`SMA20'nin ${price >= metrics.sma20 ? "üzerinde" : "altında"}`);
  if (Number.isFinite(metrics.sma50)) smaParts.push(`SMA50'nin ${price >= metrics.sma50 ? "üzerinde" : "altında"}`);
  if (Number.isFinite(metrics.sma200)) smaParts.push(`SMA200'ün ${price >= metrics.sma200 ? "üzerinde" : "altında"}`);
  const trendText = smaParts.length
    ? `Fiyat ${smaParts.join(", ")}. ${Number.isFinite(metrics.sma20) && Number.isFinite(metrics.sma50) ? `SMA20 ${metrics.sma20 >= metrics.sma50 ? "SMA50'nin üzerinde; kısa ve orta vadeli yön birbiriyle uyumlu" : "SMA50'nin altında; kısa vadeli yön orta vadeden daha zayıf"}.` : ""}${!Number.isFinite(metrics.sma200) ? " SMA200 için yeterli veri olmadığından uzun vadeli yorum sınırlı." : ""}`
    : "SMA (Basit Hareketli Ortalama) değerleri için yeterli fiyat geçmişi yok.";

  let rsiDirection = 0;
  let rsiText = "RSI(14) için yeterli veri yok.";
  if (Number.isFinite(metrics.rsi)) {
    if (metrics.rsi >= 70) rsiText = `RSI(14) ${formatNumber(metrics.rsi, 1)}: alım momentumu güçlü fakat aşırı alım bölgesinde; kısa süreli düzeltme riski arttı.`;
    else if (metrics.rsi >= 50) { rsiDirection = 1; rsiText = `RSI(14) ${formatNumber(metrics.rsi, 1)}: momentum alıcıların lehine ve henüz aşırı alımda değil.`; }
    else if (metrics.rsi >= 40) rsiText = `RSI(14) ${formatNumber(metrics.rsi, 1)}: momentum nötr, belirgin üstünlük yok.`;
    else if (metrics.rsi > 30) { rsiDirection = -1; rsiText = `RSI(14) ${formatNumber(metrics.rsi, 1)}: momentum zayıf ve satıcılar daha etkili.`; }
    else { rsiDirection = -1; rsiText = `RSI(14) ${formatNumber(metrics.rsi, 1)}: aşırı satım bölgesinde. Tepki gelebilir fakat bu tek başına olumlu sinyal değildir.`; }
  }
  const macdDirection = Number.isFinite(lastMacd) && Number.isFinite(lastSignal) ? (lastMacd >= lastSignal ? 1 : -1) : 0;
  const macdText = macdDirection
    ? `MACD ${macdDirection > 0 ? "sinyal çizgisinin üzerinde; yükseliş ivmesini destekliyor" : "sinyal çizgisinin altında; düşüş ivmesine işaret ediyor"}${Number.isFinite(lastHistogram) && Number.isFinite(previousHistogram) ? ` ve histogram ${lastHistogram >= previousHistogram ? "güçleniyor" : "zayıflıyor"}` : ""}.`
    : "MACD (trend ivmesi) için yeterli veri yok.";
  const momentumBalance = rsiDirection + macdDirection;
  const momentumTone = momentumBalance > 0 ? "positive" : momentumBalance < 0 ? "negative" : "neutral";
  const momentumLabel = momentumBalance > 0 ? "Olumlu" : momentumBalance < 0 ? "Olumsuz" : "Nötr";

  let volumeTone = "neutral";
  let volumeLabel = "Teyit zayıf";
  let volumeText = "Hacim verisi bulunamadığı için fiyat hareketinin gücü doğrulanamıyor.";
  if (Number.isFinite(volumeRatio)) {
    const ratioPct = Math.round((volumeRatio - 1) * 100);
    const comparison = ratioPct >= 0 ? `%${ratioPct} üzerinde` : `%${Math.abs(ratioPct)} altında`;
    if (volumeRatio >= 1.2 && lastMove > 0) { volumeTone = "positive"; volumeLabel = "Yükselişi teyit ediyor"; }
    else if (volumeRatio >= 1.2 && lastMove < 0) { volumeTone = "negative"; volumeLabel = "Satışı teyit ediyor"; }
    volumeText = `Son işlem hacmi, 20 dönemlik hacim ortalamasının ${comparison}. ${volumeRatio >= 1.2 ? (lastMove >= 0 ? "Yükseliş daha güçlü katılımla gerçekleşiyor." : "Düşüş daha güçlü satış katılımıyla gerçekleşiyor.") : "Hareket güçlü bir hacim teyidi almıyor."}`;
  }

  const supportCandidates = [nearestSup?.price, ...(levels?.supportLevels || []).map(item => item.val)].filter(value => Number.isFinite(value) && value < price).sort((a, b) => b - a);
  const resistanceCandidates = [nearestRes?.price, ...(levels?.resistanceLevels || []).map(item => item.val)].filter(value => Number.isFinite(value) && value > price).sort((a, b) => a - b);
  const defenseLevel = supportCandidates[0] || null;
  const confirmationLevel = resistanceCandidates[0] || null;
  const balancedStop = levels?.stops?.balanced?.val || null;
  const invalidationLevel = Number.isFinite(defenseLevel) && Number.isFinite(balancedStop) ? Math.min(defenseLevel * .99, balancedStop) : balancedStop || (defenseLevel ? defenseLevel * .99 : null);
  const supportDistance = defenseLevel ? (price - defenseLevel) / price * 100 : null;
  const resistanceDistance = confirmationLevel ? (confirmationLevel - price) / price * 100 : null;
  const atrPct = levels?.atrPct || 0;
  const riskHigh = event?.type === "breakdown" || atrPct > 4 || (Number.isFinite(supportDistance) && supportDistance > 8);
  const riskMedium = !riskHigh && (atrPct > 2.5 || (Number.isFinite(resistanceDistance) && resistanceDistance < 2.5) || (Number.isFinite(supportDistance) && supportDistance > 5));
  const riskTone = riskHigh ? "negative" : riskMedium ? "neutral" : "positive";
  const riskLabel = riskHigh ? "Yüksek" : riskMedium ? "Orta" : "Düşük";
  const riskText = `ATR(14), fiyatın son 14 periyottaki olağan hareket aralığını ölçüyor; şu an yaklaşık %${formatNumber(atrPct, 1)}. ${Number.isFinite(supportDistance) ? `İlk desteğe uzaklık %${formatNumber(supportDistance, 1)}.` : "Yakın destek bulunamadı."}${Number.isFinite(resistanceDistance) && resistanceDistance < 3 ? ` Direnç yalnızca %${formatNumber(resistanceDistance, 1)} yukarıda; yeni giriş için hareket alanı dar.` : ""}`;

  let headline = `${periodLabel} teknik görünüm kararsız.`;
  let summary = "SMA, RSI ve MACD aynı yönü göstermiyor; daha net bir fiyat teyidi beklemek anlamlı.";
  if (statusKey === "POSITIVE") {
    headline = `${periodLabel} teknik görünüm olumlu.`;
    summary = `SMA trendi ile RSI/MACD momentumu çoğunlukla yükselişi destekliyor.${Number.isFinite(resistanceDistance) && resistanceDistance < 3 ? " Ancak fiyat dirence yakın olduğu için yeni giriş riski artmış durumda." : ""}`;
  } else if (statusKey === "NEGATIVE") {
    headline = `${periodLabel} teknik görünüm olumsuz.`;
    summary = "SMA trendi ve RSI/MACD momentumu çoğunlukla zayıflığa işaret ediyor; risk kontrolü öncelikli.";
  }

  const defenseText = defenseLevel ? fmt(defenseLevel) : "—";
  const confirmationText = confirmationLevel ? fmt(confirmationLevel) : "—";
  const invalidationText = invalidationLevel ? fmt(invalidationLevel) : "—";
  let holdingAction = `Elindeyse: ${defenseLevel ? `${defenseText} ilk savunma seviyesi; ${invalidationText} altındaki seçili periyot kapanışı teknik risk uyarısıdır.` : "yakın destek oluşana kadar oynaklığı ve pozisyon büyüklüğünü dikkatle izle."}`;
  let entryAction = confirmationLevel
    ? `Yeni almayı düşünüyorsan: ${confirmationText} üzerinde kapanış ve hacim teyidi ya da ${defenseText} civarında belirgin destek tepkisi beklemek daha anlaşılır bir plan sağlar.`
    : "Yeni almayı düşünüyorsan: Yakın direnç ve destek oluşmadan yalnızca tek bir göstergeye dayanma.";
  if (statusKey === "POSITIVE" && Number.isFinite(resistanceDistance) && resistanceDistance >= 3) {
    entryAction = `Yeni almayı düşünüyorsan: Görünüm destekleyici; yine de girişten önce ${invalidationText} teknik bozulma seviyesine göre alabileceğin riski belirle.`;
  } else if (statusKey === "NEGATIVE") {
    holdingAction = `Elindeyse: ${invalidationText} altındaki kapanışlarda tezi ve pozisyon riskini yeniden değerlendir; yalnızca fiyat düştü diye ekleme yapma.`;
    entryAction = `Yeni almayı düşünüyorsan: Fiyat ${defenseText} seviyesini geri almadan ve MACD/RSI toparlanmadan bekle-gör yaklaşımı daha temkinli.`;
  }

  const thesis = (state.stockTheses || []).find(item => decisionSymbolKey(item.symbol) === decisionSymbolKey(technicalView.symbol));
  const thesisAlert = thesis ? thesisReviewAlert(thesis) : null;
  let thesisHtml = `<div class="ti-thesis-alert info"><strong>Yatırım tezi:</strong> Karar Merkezi'nde bu hisse için tez kaydı yok. Teknik sonuç tek başına yatırım gerekçesi değildir.</div>`;
  if (thesis?.status === "broken") {
    thesisHtml = `<div class="ti-thesis-alert danger"><strong>Tez bozuldu:</strong> Teknik görünüm olumlu olsa bile kayıtlı yatırım gerekçen bozulmuş durumda. Önce tezi yeniden değerlendir.</div>`;
  } else if (thesisAlert && !thesisAlert.passive) {
    thesisHtml = `<div class="ti-thesis-alert warn"><strong>Tez kontrolü gerekli:</strong> ${escapeHtml(thesisAlert.detail)}</div>`;
  } else if (thesis) {
    thesisHtml = `<div class="ti-thesis-alert ok"><strong>Yatırım tezi:</strong> ${escapeHtml(THESIS_STATUS_META[thesis.status]?.label || "Kayıtlı")}. Teknik görünümden ayrı olarak izleniyor.</div>`;
  }

  const pillarCard = (title, label, tone, text) => `<article class="ti-pillar ${tone}"><div><span>${title}</span><strong>${label}</strong></div><p>${text}</p></article>`;

  el.innerHTML = `
    <div class="ti-result-hero ${status.tone}">
      <div class="ov-header">
        <div>
          <span class="ti-result-kicker">NET TEKNİK SONUÇ</span>
          <h3>${escapeHtml(headline)}</h3>
        </div>
        <div class="ov-status-badge ${status.badgeClass}">
        <span class="ov-status-icon">${status.icon}</span>
        <span class="ov-status-label">${status.label}</span>
        </div>
      </div>
      <p class="ti-result-summary">${escapeHtml(summary)}</p>
      <div class="ti-result-meta">
        <div class="ti-agreement-copy"><span>Sinyal uyumu</span><strong>%${agreement}</strong><small>${signals.length} teknik okuma birlikte değerlendirildi · kazanma olasılığı değildir</small></div>
        <div class="ti-agreement-track" role="progressbar" aria-label="Teknik sinyal uyumu" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${agreement}"><span style="width:${agreement}%"></span></div>
        <div class="ov-price-tag"><span class="ov-price-lbl">Güncel fiyat</span><span class="ov-price-val">${fmt(price)}</span></div>
      </div>
    </div>
    <div class="ti-section-heading"><div><span>NEDEN BÖYLE?</span><h3>Göstergelerin sade açıklaması</h3></div><small>İsimleri gör; anlamını hemen altında öğren.</small></div>
    <div class="ti-pillar-grid">
      ${pillarCard("Trend · SMA20 / SMA50 / SMA200", trendLabel, trendTone, trendText)}
      ${pillarCard("Momentum · RSI(14) / MACD", momentumLabel, momentumTone, `${rsiText} ${macdText}`)}
      ${pillarCard("Hacim · 20 dönem ortalaması", volumeLabel, volumeTone, volumeText)}
      ${pillarCard("Risk · ATR(14) / seviyeler", riskLabel, riskTone, riskText)}
    </div>
    <div class="ti-section-heading compact"><div><span>KRİTİK FİYATLAR</span><h3>Görünüm ne zaman değişir?</h3></div><small>Seçili periyodun kapanışı esas alınır.</small></div>
    <div class="ti-level-grid">
      <article class="confirm"><span>Olumlu teyit</span><strong>${confirmationText}</strong><p>${confirmationLevel ? "Bu seviyenin üzerinde kapanış yükseliş isteğini güçlendirir." : "Yakın direnç henüz oluşmadı."}</p></article>
      <article class="defense"><span>İlk savunma</span><strong>${defenseText}</strong><p>${defenseLevel ? "Bu seviyenin üzerinde kaldıkça mevcut fiyat yapısı korunur." : "Yakın destek henüz oluşmadı."}</p></article>
      <article class="invalidate"><span>Teknik görünüm bozulur</span><strong>${invalidationText}</strong><p>${invalidationLevel ? "Altındaki kapanış risk görünümünü olumsuza çevirir." : "Bozulma eşiği için yeterli veri yok."}</p></article>
    </div>
    <div class="ti-action-grid">
      <article><span>PORTFÖYÜNDE VARSA</span><p>${holdingAction}</p></article>
      <article><span>YENİ ALMAYI DÜŞÜNÜYORSAN</span><p>${entryAction}</p></article>
    </div>
    ${thesisHtml}
    <p class="ov-disclaimer">Bu sonuç geçmiş fiyat, hacim ve göstergelerin anlaşılır yorumudur; kesin al/sat emri veya getiri garantisi değildir. Şirket haberleri, bilanço ve yatırım tezini ayrıca değerlendir.</p>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PWA (SERVICE WORKER & ANA EKRANA EKLE DESTEĞİ)
// ═══════════════════════════════════════════════════════════════════════════════

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      console.log("ServiceWorker kaydı başarısız:", err);
    });
  });
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPwaPrompt = e;
  const installBtn = document.getElementById("pwaInstallBtn");
  if (installBtn) installBtn.style.display = "inline-flex";
});

document.getElementById("pwaInstallBtn")?.addEventListener("click", async () => {
  if (!deferredPwaPrompt) return;
  deferredPwaPrompt.prompt();
  const { outcome } = await deferredPwaPrompt.userChoice;
  if (outcome === "accepted") {
    showToast("Yatırım Defterim ana ekrana eklendi!");
  }
  deferredPwaPrompt = null;
  const installBtn = document.getElementById("pwaInstallBtn");
  if (installBtn) installBtn.style.display = "none";
});

// ═══════════════════════════════════════════════════════════════════════════════
// KAPANMIŞ POZİSYONLAR & EXCEL/CSV İÇE AKTARMA MOTORU
// ═══════════════════════════════════════════════════════════════════════════════

function calculateHoldingDays(buyDateStr, sellDateStr) {
  if (!buyDateStr || !sellDateStr) return "—";
  try {
    const d1 = new Date(`${buyDateStr}T12:00:00`);
    const d2 = new Date(`${sellDateStr}T12:00:00`);
    const diffTime = d2.getTime() - d1.getTime();
    if (isNaN(diffTime) || diffTime < 0) return "—";
    const days = Math.round(diffTime / (1000 * 3600 * 24));
    return `${days} gün`;
  } catch { return "—"; }
}

function getClosedPositionsFromTransactions() {
  return calculatePortfolio().closedFromTransactions;
}

function exportFullBackup() {
  const payload = {
    format: "yatirim-defterim-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    state
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `yatirim-defterim-tam-yedek-${today()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  showToast("Tam portföy yedeği indirildi.");
}

async function importFullBackup(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error("Yedek dosyası 10 MB sınırını aşıyor.");
    const payload = JSON.parse(await file.text());
    if (payload?.format !== "yatirim-defterim-backup" || !payload.state) throw new Error("Bu dosya geçerli bir Yatırım Defterim yedeği değil.");
    const restored = migrateState(payload.state);
    const auditErrors = Core.auditTransactions(restored.transactions);
    if (auditErrors.length) throw new Error(`Yedekte tutarsız işlem var: ${auditErrors[0].message}`);
    if (!confirm(`${restored.transactions.length} işlem içeren yedek mevcut tarayıcı verisinin yerini alacak. Devam edilsin mi?`)) return;
    const previousState = state;
    state = restored;
    if (!saveState()) { state = previousState; return; }
    document.documentElement.setAttribute("data-theme", state.settings.theme);
    render();
    scheduleRefresh();
    showToast("Tam yedek başarıyla geri yüklendi.");
  } catch (error) {
    showToast(`Yedek açılamadı: ${error.message}`);
  }
}

function renderClosedPositions() {
  const tableEl = document.getElementById("closedPositionsTable");
  if (!tableEl) return;

  const txClosed = getClosedPositionsFromTransactions();
  const manualClosed = state.closedPositions || [];
  const positions = [...txClosed, ...manualClosed];

  const search = ($("#closedSearchInput")?.value || "").trim().toLowerCase();
  const filterType = $("#closedFilterType")?.value || "all";
  const sortBy = $("#closedSortBy")?.value || "sellDateDesc";

  let filtered = positions.filter(p => {
    const sym = (p.symbol || "").toLowerCase();
    const name = (p.name || "").toLowerCase();
    const matchSearch = !search || sym.includes(search) || name.includes(search);
    if (!matchSearch) return false;

    if (filterType === "profit") return p.profit > 0;
    if (filterType === "loss") return p.profit < 0;
    if (filterType === "TRY") return p.currency === "TRY";
    if (filterType === "USD") return p.currency === "USD";
    return true;
  });

  const compareClosedPositions = (a, b) => {
    if (sortBy === "sellDateDesc") return (b.sellDate || "").localeCompare(a.sellDate || "");
    if (sortBy === "sellDateAsc") return (a.sellDate || "").localeCompare(b.sellDate || "");
    if (sortBy === "profitDesc") return baseValue(b.profit || 0, b.currency || "TRY") - baseValue(a.profit || 0, a.currency || "TRY");
    if (sortBy === "profitAsc") return baseValue(a.profit || 0, a.currency || "TRY") - baseValue(b.profit || 0, b.currency || "TRY");
    if (sortBy === "pctDesc") return (b.profitPercent || 0) - (a.profitPercent || 0);
    if (sortBy === "symbol") return (a.symbol || "").localeCompare(b.symbol || "");
    return 0;
  };
  const groupedPositions = Core.groupClosedPositionsForDisplay(filtered);
  groupedPositions.sort((a, b) => compareClosedPositions(a.summary, b.summary));
  groupedPositions.forEach(group => group.items.sort(compareClosedPositions));

  const totalTry = positions.filter(p => p.currency === "TRY").reduce((s, p) => s + (p.profit || 0), 0);
  const totalUsd = positions.filter(p => p.currency === "USD").reduce((s, p) => s + (p.profit || 0), 0);
  const totalCombinedTry = positions.reduce((s, p) => s + baseValue(p.profit || 0, p.currency || "TRY"), 0);
  const totalCostCombined = positions.reduce((s, p) => s + baseValue(p.cost || 0, p.currency || "TRY"), 0);
  const avgPct = totalCostCombined > 0 ? totalCombinedTry / totalCostCombined * 100 : 0;

  const symbolPerformance = Core.aggregateClosedPositionsBySymbol(positions, state.settings);
  const best = symbolPerformance[0] || null;
  const worst = symbolPerformance.at(-1) || null;

  
if ($("#closedTotalPnlCombined")) {
    $("#closedTotalPnlCombined").textContent = signedMoney(totalCombinedTry, "TRY");
    $("#closedTotalPnlCombined").className = `exec-card-val ${typeClass(totalCombinedTry)}`;
  }
  if ($("#closedTotalPnlTry")) {
    $("#closedTotalPnlTry").textContent = signedMoney(totalTry, "TRY");
    $("#closedTotalPnlTry").className = `exec-card-val ${typeClass(totalTry)}`;
  }
  if ($("#closedTotalPnlUsd")) {
    const usdTryText = `<div style="font-size: 0.75em; font-weight: normal; opacity: 0.8; margin-top: 2px;">(${signedMoney(baseValue(totalUsd, "USD"), "TRY")})</div>`;
    $("#closedTotalPnlUsd").innerHTML = `${totalUsd >= 0 ? "+" : ""}${formatMoney(totalUsd, "USD")} ${totalUsd !== 0 ? usdTryText : ""}`;
    $("#closedTotalPnlUsd").className = `exec-card-val ${typeClass(totalUsd)}`;
  }
  if ($("#closedAvgReturn")) {
    $("#closedAvgReturn").textContent = signedPercent(avgPct);
    $("#closedAvgReturn").className = `exec-card-val ${typeClass(avgPct)}`;
  }
  if ($("#closedCountSub")) {
    const summaryCount = Core.groupClosedPositionsForDisplay(positions).length;
    $("#closedCountSub").textContent = summaryCount < positions.length
      ? `${positions.length} kapanmış işlem · ${summaryCount} özet satır`
      : `${positions.length} kapanmış işlem`;
  }
  if ($("#closedBestWorst")) {
    if (best && worst) {
      const saleCountText = item => `${item.saleCount} satış`;
      $("#closedBestWorst").innerHTML = `
        <span class="ok">▲ ${escapeHtml(best.symbol)} (${signedMoney(best.profit)}) · ${saleCountText(best)}</span><br/>
        <span class="err">▼ ${escapeHtml(worst.symbol)} (${signedMoney(worst.profit)}) · ${saleCountText(worst)}</span>
      `;
    } else {
      $("#closedBestWorst").textContent = "—";
    }
  }

  if (!filtered.length) {
    tableEl.innerHTML = `<tr class="closed-empty-row"><td colspan="13" class="empty-state">Henüz kayıtlı kapanmış pozisyon bulunmuyor.</td></tr>`;
    return;
  }

  const displayRows = groupedPositions.flatMap(group => {
    if (group.items.length === 1) return [{ p: group.items[0], groupKey: group.key, groupCount: 1, isGroup: false, isDetail: false, expanded: false }];
    const expanded = expandedClosedPositionGroups.has(group.key);
    return [
      { p: group.summary, groupKey: group.key, groupCount: group.items.length, isGroup: true, isDetail: false, expanded },
      ...(expanded ? group.items.map(p => ({ p, groupKey: group.key, groupCount: group.items.length, isGroup: false, isDetail: true, expanded })) : [])
    ];
  });

  tableEl.innerHTML = displayRows.map(({ p, groupKey, groupCount, isGroup, isDetail, expanded }) => {
    const isUs = p.currency === "USD";
    const curr = p.currency || (isUs ? "USD" : "TRY");
    const fmt = v => formatMoney(v, curr, { maximumFractionDigits: 2 });
    const holdingDays = calculateHoldingDays(p.buyDate, p.sellDate);
    const pnlClass = typeClass(p.profit || 0);
    const saleDeductions = [
      number(p.fee) > 0 ? `Komisyon −${fmt(number(p.fee))}` : "",
      number(p.profitShare) > 0 ? `Aile payı −${fmt(number(p.profitShare))}` : ""
    ].filter(Boolean).join(" · ");

    const lookupSymbol = p.symbol;
    const quote = state.prices[lookupSymbol] || state.prices[lookupSymbol.replace(".IS", "")];
    const logo = companyLogo(lookupSymbol, quote, p.name);

    const pnlTryText = curr !== "TRY" ? `<div class="security-name ${pnlClass}">(${p.profit >= 0 ? "+" : "−"}${formatMoney(Math.abs(baseValue(p.profit || 0, curr)), "TRY", { maximumFractionDigits: 2 })})</div>` : "";

    const currentPriceVal = quote && Number.isFinite(Number(quote.price)) ? Number(quote.price) : null;
    const currentPriceText = currentPriceVal !== null ? fmt(currentPriceVal) : "—";
          let theoreticalChangePct = null;
      let currentChangeText = "";
      if (currentPriceVal !== null && p.buyPrice && p.buyPrice > 0) {
        theoreticalChangePct = ((currentPriceVal - p.buyPrice) / p.buyPrice) * 100;
        currentChangeText = signedPercent(theoreticalChangePct);
      }

    return `
      <tr class="closed-position-row${isGroup ? " closed-position-group-row" : ""}${isDetail ? " closed-position-detail-row" : ""}"${isGroup ? ` data-closed-group="${escapeHtml(groupKey)}" tabindex="0" role="button" aria-expanded="${expanded}"` : ""}>
        <td class="closed-symbol-cell" data-label="Varlık">
          <div class="symbol-wrapper">
            ${logo}
            <div>
              <strong>${escapeHtml(lookupSymbol)}</strong>
              <div class="security-name">${escapeHtml(p.name || lookupSymbol)}</div>
              ${isGroup ? `<div class="closed-group-summary-note">${groupCount} kayıt birleştirildi · Ayrıntılar için tıkla</div>` : (isDetail ? `<div class="closed-group-detail-note">Özgün kayıt</div>` : "")}
            </div>
          </div>
        </td>
        <td class="closed-buy-date-cell" data-label="Alış tarihi">${escapeHtml(p.buyDate || "—")}</td>
        <td class="closed-sell-date-cell" data-label="Satış tarihi"><strong>${escapeHtml(p.sellDate || "—")}</strong></td>
        <td class="number closed-lot-cell" data-label="Lot">${formatNumber(p.lot || 0, 9)}${isGroup ? `<div class="security-name">${groupCount} kayıt toplamı</div>` : ""}</td>
        <td class="number closed-buy-price-cell" data-label="Alış fiyatı">${fmt(p.buyPrice || 0)}</td>
        <td class="number closed-sell-price-cell" data-label="Satış fiyatı"><strong>${fmt(p.sellPrice || 0)}</strong></td>
        <td class="number closed-current-price-cell" data-label="Güncel fiyat">
          <strong>${currentPriceText}</strong>
          ${currentChangeText ? `<div class="security-name ${typeClass(theoreticalChangePct)}">${currentChangeText}</div>` : ""}
        </td>
        <td class="number closed-cost-cell" data-label="Toplam maliyet">${fmt(p.cost || 0)}</td>
        <td class="number closed-revenue-cell" data-label="Toplam gelir">${fmt(p.revenue || 0)}${saleDeductions ? `<div class="security-name">${saleDeductions}</div>` : ""}</td>
        <td class="number closed-pnl-cell ${pnlClass}" data-label="Gerçekleşen K/Z">
          <strong>${p.profit >= 0 ? "+" : "−"}${fmt(Math.abs(p.profit || 0))}</strong>
          ${pnlTryText}
        </td>
        <td class="number closed-return-cell ${pnlClass}" data-label="Getiri">
          <strong>${signedPercent(p.profitPercent || 0)}</strong>
        </td>
        <td class="number closed-holding-cell" data-label="Elde tutma"><span class="holding-days-badge">${holdingDays}</span></td>
        <td class="closed-actions-cell" data-label="Eylemler">
          ${isGroup
            ? `<button class="button small secondary closed-group-toggle" type="button">${expanded ? "Detayları gizle" : `${groupCount} kaydı göster`}</button>`
            : `${p.sourceTransactionId ? "" : `<button class="button small secondary" type="button" onclick="openClosedPosModal('${p.id}')">Düzenle</button>`}<details class="row-actions-menu"><summary class="button small secondary" aria-label="Kapanmış pozisyonun diğer eylemleri">•••</summary><div class="row-actions-popover"><button class="menu-action danger-text" type="button" onclick="deleteClosedPosition('${p.id}')">Kaydı sil</button></div></details>`}
        </td>
      </tr>
    `;
  }).join("");

  tableEl.querySelectorAll(".closed-position-group-row").forEach(row => {
    const toggleGroup = () => {
      const key = row.dataset.closedGroup;
      if (!key) return;
      if (expandedClosedPositionGroups.has(key)) expandedClosedPositionGroups.delete(key);
      else expandedClosedPositionGroups.add(key);
      renderClosedPositions();
    };
    row.addEventListener("click", event => {
      if (event.target.closest("button, a, input, select, details")) return;
      toggleGroup();
    });
    row.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleGroup();
    });
    row.querySelector(".closed-group-toggle")?.addEventListener("click", toggleGroup);
  });
}

window.deleteClosedPosition = function(id) {
  if (String(id).startsWith("tx_cp_")) {
    if (!confirm("Bu kapanış işlem defterindeki satıştan oluşuyor. Satış işlemi silinecek ve ilgili adet tekrar açık pozisyona dönebilir. Devam edilsin mi?")) return;
    const txId = id.replace("tx_cp_", "");
    state.transactions = state.transactions.filter(t => t.id !== txId);
  } else {
    if (!confirm("Bu elle eklenmiş kapanmış pozisyon kaydı silinecek. Devam edilsin mi?")) return;
    state.closedPositions = (state.closedPositions || []).filter(p => p.id !== id);
  }
  saveState();
  render();
  showToast("Pozisyon silindi.");
};

function openClosedPosModal(editId = null) {
  $("#closedPosForm").reset();
  currentEditingClosedId = editId;

  if (editId) {
    const pos = (state.closedPositions || []).find(p => p.id === editId);
    if (pos) {
      $("#closedPosDialogTitle").textContent = "Kapanmış Pozisyonu Düzenle";
      if ($("#closedMarketSelect")) $("#closedMarketSelect").value = pos.market || (pos.currency === "USD" ? "ABD" : "BIST");
      $("#closedSymbolInput").value = pos.symbol || "";
      $("#closedNameInput").value = pos.name || "";
      $("#closedCurrencySelect").value = pos.currency || "TRY";
      $("#closedLotInput").value = pos.lot || "";
      $("#closedBuyPriceInput").value = pos.buyPrice || "";
      $("#closedSellPriceInput").value = pos.sellPrice || "";
      $("#closedBuyDateInput").value = pos.buyDate || "";
      $("#closedSellDateInput").value = pos.sellDate || "";
      $("#closedPosDialog").showModal();
      return;
    }
  }
  $("#closedPosDialogTitle").textContent = "Kapanmış Pozisyon Ekle";
  $("#closedSellDateInput").value = today();
  $("#closedPosDialog").showModal();
}

function saveClosedPos(e) {
  e.preventDefault();
  const market = $("#closedMarketSelect")?.value || "BIST";
  const symbol = Core.normalizeSymbol($("#closedSymbolInput").value, market);
  const currency = $("#closedCurrencySelect").value;
  const lot = number($("#closedLotInput").value);
  const buyPrice = number($("#closedBuyPriceInput").value);
  const sellPrice = number($("#closedSellPriceInput").value);
  const buyDate = $("#closedBuyDateInput").value;
  const sellDate = $("#closedSellDateInput").value;

  if (!symbol || lot <= 0 || buyPrice <= 0 || sellPrice <= 0 || !sellDate) {
    showToast("Lütfen zorunlu alanları doldurun.");
    return;
  }
  if (buyDate && buyDate > sellDate) {
    showToast("Alış tarihi satış tarihinden sonra olamaz.");
    return;
  }

  const cost = lot * buyPrice;
  const revenue = lot * sellPrice;
  const profit = revenue - cost;
  const profitPercent = cost ? (profit / cost) * 100 : 0;

  const pos = {
    id: currentEditingClosedId || uid("cp"), symbol, name: $("#closedNameInput").value.trim() || symbol,
    lot, buyPrice, sellPrice, cost, revenue, profit, profitPercent, buyDate, sellDate, currency,
    market, status: "closed"
  };

  if (currentEditingClosedId) {
    const index = state.closedPositions.findIndex(item => item.id === currentEditingClosedId);
    if (index >= 0) state.closedPositions[index] = pos;
  } else {
    state.closedPositions.push(pos);
  }
  if (!saveState()) return;
  renderClosedPositions();
  $("#closedPosDialog").close();
  showToast(currentEditingClosedId ? "Pozisyon güncellendi." : "Pozisyon eklendi.");
  currentEditingClosedId = null;
}

// ── EXCEL / CSV IMPORT SIHIRBAZI ───────────────────────────────────────────

function parseExcelDate(val) {
  if (!val) return "";
  if (typeof val === "number") {
    const dateObj = new Date(Math.round((val - 25569) * 86400 * 1000));
    if (!isNaN(dateObj.getTime())) return dateObj.toISOString().slice(0, 10);
  }
  const str = String(val).trim();
  if (str.match(/^\d{4}-\d{2}-\d{2}/)) return str.slice(0, 10);
  const parts = str.split(/[\.\/\-]/);
  if (parts.length === 3) {
    if (parts[0].length === 4) return `${parts[0]}-${parts[1].padStart(2, "0")}-${parts[2].padStart(2, "0")}`;
    if (parts[2].length === 4) return `${parts[2]}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`;
  }
  return str;
}

function processExcelRows(rows) {
  parsedImportData = [];
  if (!rows || !rows.length) return;

  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const rowStr = (rows[i] || []).map(cell => String(cell || "").toLowerCase()).join(" ");
    if (
      rowStr.includes("kodu") || rowStr.includes("symbol") || rowStr.includes("sembol") ||
      rowStr.includes("hisse") || rowStr.includes("ticker") || rowStr.includes("varlık") ||
      rowStr.includes("lot") || rowStr.includes("maliyet") || rowStr.includes("satış") ||
      rowStr.includes("alış") || rowStr.includes("adet") || rowStr.includes("miktar")
    ) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) headerIdx = 0;
  const headers = (rows[headerIdx] || []).map(h => String(h || "").trim());

  const map = {
    symbol: -1, lot: -1, buyPrice: -1, sellPrice: -1,
    cost: -1, revenue: -1, profit: -1, profitPercent: -1,
    sellDate: -1, profitTry: -1, currency: -1
  };

  headers.forEach((h, i) => {
    const norm = h.toLowerCase().replace(/\s+/g, "");
    if (norm.includes("kodu") || norm.includes("hisse") || norm.includes("sembol") || norm.includes("symbol") || norm.includes("ticker") || norm.includes("varlık") || norm.includes("enstrüman")) {
      if (map.symbol === -1) map.symbol = i;
    }
    else if (norm.includes("lot") || norm.includes("adet") || norm.includes("miktar") || norm.includes("qty") || norm.includes("quantity")) {
      if (map.lot === -1) map.lot = i;
    }
    else if (norm.includes("alışfiyat") || norm.includes("alışf") || norm.includes("buyprice") || norm.includes("birimalış") || (norm.includes("alış") && !norm.includes("tarih") && !norm.includes("maliyet"))) {
      if (map.buyPrice === -1) map.buyPrice = i;
    }
    else if (norm.includes("satışfiyat") || norm.includes("satışf") || norm.includes("sellprice") || norm.includes("birimsatış") || (norm.includes("satış") && !norm.includes("tarih") && !norm.includes("gelir"))) {
      if (map.sellPrice === -1) map.sellPrice = i;
    }
    else if (norm.includes("maliyet") || norm.includes("toplammaliyet") || norm === "cost") {
      if (map.cost === -1) map.cost = i;
    }
    else if (norm.includes("gelir($)") || norm.includes("gelirusd")) {
      map.revenue = i; map.currency = i;
    }
    else if (norm.includes("gelir") || norm.includes("toplamgelir") || norm === "revenue") {
      if (map.revenue === -1) map.revenue = i;
    }
    else if (norm.includes("tlkar") || norm.includes("tlkâr") || norm.includes("kartry") || norm.includes("kârtry")) {
      map.profitTry = i;
    }
    else if (norm.includes("kar") || norm.includes("kâr") || norm.includes("profit") || norm.includes("kazanç")) {
      if (map.profit === -1 && !norm.includes("oran") && !norm.includes("%")) map.profit = i;
    }
    else if (norm.includes("oran") || norm.includes("%") || norm.includes("yüzde")) {
      if (map.profitPercent === -1) map.profitPercent = i;
    }
    else if (norm.includes("tarih") || norm.includes("date")) {
      if (map.sellDate === -1) map.sellDate = i;
    }
    else if (norm.includes("parabirimi") || norm.includes("döviz") || norm.includes("currency")) {
      if (map.currency === -1) map.currency = i;
    }
  });

  if (map.symbol === -1 && headers.length > 0) map.symbol = 0;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length || r.every(cell => cell === null || cell === undefined || String(cell).trim() === "")) continue;

    let symbol = map.symbol !== -1 ? String(r[map.symbol] || "").trim().toUpperCase() : "";
    if (!symbol || symbol === "KODU" || symbol === "TOPLAM" || symbol === "SEMBOL" || symbol === "SYMBOL") continue;

    let lot = map.lot !== -1 ? number(r[map.lot]) : 0;
    let buyPrice = map.buyPrice !== -1 ? number(r[map.buyPrice]) : 0;
    let sellPrice = map.sellPrice !== -1 ? number(r[map.sellPrice]) : 0;
    let cost = map.cost !== -1 ? number(r[map.cost]) : (lot * buyPrice);
    let revenue = map.revenue !== -1 ? number(r[map.revenue]) : (lot * sellPrice);
    let profit = map.profit !== -1 ? number(r[map.profit]) : (revenue - cost);
    let profitPercent = map.profitPercent !== -1 ? number(r[map.profitPercent]) : (cost ? (profit / cost) * 100 : 0);
    let sellDate = map.sellDate !== -1 ? parseExcelDate(r[map.sellDate]) : today();
    let profitTry = map.profitTry !== -1 ? number(r[map.profitTry]) : null;

    let currency = "TRY";
    if (map.currency !== -1 && String(headers[map.currency] || "").includes("$")) {
      currency = "USD";
    }

    const computedProfit = revenue - cost;
    const computedPct = cost ? (computedProfit / cost) * 100 : 0;
    let isMismatch = Math.abs(profit - computedProfit) > 2.0;
    let isIncomplete = !symbol || !lot || !sellPrice || !sellDate;

    parsedImportData.push({
      symbol,
      lot,
      buyPrice: buyPrice || (lot ? cost / lot : 0),
      sellPrice: sellPrice || (lot ? revenue / lot : 0),
      cost,
      revenue,
      profit: profit || computedProfit,
      profitPercent: profitPercent || computedPct,
      sellDate,
      profitTry,
      currency,
      isIncomplete,
      isMismatch
    });
  }
  renderImportPreview();
}

function renderImportPreview() {
  const tableEl = document.getElementById("importPreviewTable");
  const summaryEl = document.getElementById("importValidationSummary");
  if (!tableEl) return;

  const incompleteCount = parsedImportData.filter(d => d.isIncomplete).length;
  const mismatchCount = parsedImportData.filter(d => d.isMismatch).length;

  if (summaryEl) {
    if (incompleteCount || mismatchCount) {
      summaryEl.innerHTML = `<strong>Kontrol gerekli · ${parsedImportData.length} satır bulundu:</strong> ${incompleteCount ? `${incompleteCount} eksik veri` : ""} ${mismatchCount ? `· ${mismatchCount} hesap uyuşmazlığı (otomatik doğrulandı)` : ""}. Tablodan kontrol edip onaylayabilirsiniz.`;
      summaryEl.style.display = "block";
    } else {
      summaryEl.innerHTML = `<strong>Hazır · ${parsedImportData.length} satır başarıyla doğrulandı.</strong> Veriler aktarılmaya hazır.`;
      summaryEl.style.display = "block";
    }
  }

  if (!parsedImportData.length) {
    tableEl.innerHTML = `<tr><td colspan="12" class="empty-state">Dosyada uygun veri satırı bulunamadı. Lütfen Excel başlıklarınızın Kodu/Sembol, Lot, Satış Fiyatı içerdiğinden emin olun.</td></tr>`;
    $("#confirmImportBtn").disabled = true;
    return;
  }

  $("#confirmImportBtn").disabled = false;

  tableEl.innerHTML = parsedImportData.map((d, i) => {
    const statusTag = d.isIncomplete
      ? `<span class="status-tag err">Eksik</span>`
      : d.isMismatch
        ? `<span class="status-tag warn">Fark</span>`
        : `<span class="status-tag ok">Hazır</span>`;

    return `
      <tr>
        <td>${statusTag}</td>
        <td><input class="editable-cell" value="${escapeHtml(d.symbol)}" onchange="updateParsedItem(${i}, 'symbol', this.value)"/></td>
        <td class="number"><input class="editable-cell" type="number" step="any" value="${d.lot}" onchange="updateParsedItem(${i}, 'lot', this.value)"/></td>
        <td class="number"><input class="editable-cell" type="number" step="any" value="${d.buyPrice}" onchange="updateParsedItem(${i}, 'buyPrice', this.value)"/></td>
        <td class="number"><input class="editable-cell" type="number" step="any" value="${d.sellPrice}" onchange="updateParsedItem(${i}, 'sellPrice', this.value)"/></td>
        <td class="number">${formatNumber(d.cost, 2)}</td>
        <td class="number">${formatNumber(d.revenue, 2)}</td>
        <td class="number ${typeClass(d.profit)}">${formatNumber(d.profit, 2)}</td>
        <td class="number ${typeClass(d.profitPercent)}">%${d.profitPercent.toFixed(1)}</td>
        <td><input class="editable-cell" type="date" value="${d.sellDate}" onchange="updateParsedItem(${i}, 'sellDate', this.value)"/></td>
        <td>
          <select class="editable-cell" onchange="updateParsedItem(${i}, 'currency', this.value)">
            <option value="TRY" ${d.currency === "TRY" ? "selected" : ""}>TRY</option>
            <option value="USD" ${d.currency === "USD" ? "selected" : ""}>USD</option>
          </select>
        </td>
        <td>
          <button type="button" class="button small danger" onclick="removeParsedItem(${i})" title="Bu satırı listeden tamamen kaldır">✕</button>
        </td>
      </tr>
    `;
  }).join("");
}

window.updateParsedItem = function(index, field, value) {
  if (!parsedImportData[index]) return;
  const item = parsedImportData[index];
  if (field === "lot" || field === "buyPrice" || field === "sellPrice") {
    item[field] = number(value);
    item.cost = item.lot * item.buyPrice;
    item.revenue = item.lot * item.sellPrice;
    item.profit = item.revenue - item.cost;
    item.profitPercent = item.cost ? (item.profit / item.cost) * 100 : 0;
  } else {
    item[field] = value;
  }
  item.isIncomplete = !item.symbol || !item.lot || !item.sellPrice || !item.sellDate;
  renderImportPreview();
};

window.removeParsedItem = function(index) {
  if (index >= 0 && index < parsedImportData.length) {
    const removed = parsedImportData.splice(index, 1)[0];
    renderImportPreview();
    showToast(`${removed.symbol || "Satır"} önizleme listesinden kaldırıldı.`);
  }
};

// Application initialization
loadAutomaticCalendarCache();
bindEvents();
render();
updateCloudSyncUi();
$("#offlineQueueRetryButton")?.addEventListener("click", () => {
  if (cloudSync.enabled) void pushCloudState();
  else void initializeCloudSync();
});
window.addEventListener("online", () => {
  cloudSync.phase = "syncing";
  cloudSync.detail = transactionOutbox.count() > 0
    ? `${transactionOutbox.count()} bekleyen işlem değişikliği gönderilmeye hazırlanıyor`
    : "Bulut bağlantısı yeniden denetleniyor";
  updateCloudSyncUi();
  if (cloudSync.enabled) void pushCloudState();
  else void initializeCloudSync();
});
window.addEventListener("offline", () => {
  cloudSync.phase = "error";
  cloudSync.detail = transactionOutbox.count() > 0
    ? `${transactionOutbox.count()} işlem değişikliği bağlantı gelene kadar bu cihazda korunuyor`
    : "İnternet bağlantısı yok; yeni işlemler bu cihazda korunacak";
  updateCloudSyncUi();
});
void loadRuntimeHealth();
renderClosedPositions();
void migrateLegacyBrowserSecrets().then(() => {
  aiSecretStatus.loaded = false;
  void loadAiSettings();
  void loadTelegramSettings();
  void loadSecSettings();
});
void initializeCloudSync().finally(() => {
  onboardingReady = true;
  updateExperiencePrompts();
  scheduleRefresh();
  void refreshQuotes({ quiet: true });
});
if (startupWarnings.length) setTimeout(() => showToast(startupWarnings[0]), 100);
const startupIntegrityError = calculatePortfolio().integrityErrors[0];
if (startupIntegrityError) setTimeout(() => showToast(`İşlem defterinde tutarsızlık: ${startupIntegrityError.message}`), 300);


// ============================================================
// TELEGRAM BEKLEYen İŞLEM POLLING
// ============================================================
(function initTelegramPolling() {
  const POLL_INTERVAL = 6000; // 6 saniye
  let knownPendingIds = new Set();

  const banner = document.createElement("div");
  banner.id = "telegramPendingBanner";
  banner.className = "tg-pending-banner";
  banner.style.display = "none";
  banner.innerHTML = `
    <span class="tg-pending-icon" aria-hidden="true">◇</span>
    <span class="tg-pending-text"></span>
    <button class="button primary small" id="tgPendingReviewBtn">İncele ve Ekle</button>
    <button class="icon-button tg-pending-close" id="tgPendingDismissBtn" type="button" title="Kapat" aria-label="Telegram bildirimini kapat">×</button>
  `;
  document.body.appendChild(banner);

  document.getElementById("tgPendingDismissBtn")?.addEventListener("click", () => {
    banner.style.display = "none";
  });

  document.getElementById("tgPendingReviewBtn")?.addEventListener("click", () => {
    // AI Asistanı aç — mevcut pending işlemleri önizleme alanına yükle
    openTelegramPendingInPanel();
  });

  async function poll() {
    try {
      const resp = await fetch("/api/pending-transactions", { cache: "no-store" });
      const data = await readJsonResponse(resp, "telegram");
      if (!resp.ok) throw serviceError("telegram");
      const pending = data.pending || [];

      if (pending.length === 0) {
        banner.style.display = "none";
        knownPendingIds.clear();
        return;
      }

      // Yeni gelen varsa banner göster
      const newOnes = pending.filter(p => !knownPendingIds.has(p.id));
      if (newOnes.length > 0) {
        newOnes.forEach(p => knownPendingIds.add(p.id));
        const totalTx = pending.reduce((n, p) => n + (p.transactions || []).length, 0);
        banner.querySelector(".tg-pending-text").textContent =
          `Telegram'dan ${totalTx} bekleyen işlem var`;
        banner.style.display = "flex";
        showToast(`Telegram'dan ${totalTx} yeni işlem geldi`);
      }
    } catch (_) {
      // Sunucu kapalıysa sessizce geç
    }
  }

  function openTelegramPendingInPanel() {
    // Panel ve önizleme alanını aç
    const panel   = document.getElementById("aiAssistantPanel");
    const overlay = document.getElementById("aiAssistantOverlay");
    const previewArea = document.getElementById("aiPreviewArea");
    const previewList = document.getElementById("aiPreviewList");
    const errorEl = document.getElementById("aiAssistantError");
    if (!panel || !previewList) return;

    document.getElementById("aiAssistantBtn")?.click();
    if (errorEl) errorEl.style.display = "none";

    // Mevcut bekleyen işlemleri çek ve render et
    fetch("/api/pending-transactions", { cache: "no-store" })
      .then(async response => {
        const data = await readJsonResponse(response, "telegram");
        if (!response.ok) throw serviceError("telegram");
        return data;
      })
      .then(data => {
        const pending = data.pending || [];
        if (!pending.length) {
          if (previewArea) previewArea.style.display = "none";
          return;
        }

        // Tüm pending gruplarındaki tüm transaction'ları topla
        const allTx = [];
        pending.forEach(group => {
          (group.transactions || []).forEach((tx, transactionIndex) => {
            allTx.push({
              ...tx,
              _pendingGroupId: group.id,
              _pendingTransactionId: tx._pendingTransactionId || `${group.id}_${transactionIndex}`
            });
          });
        });

        previewList.innerHTML = "";
        allTx.forEach((tx, idx) => {
          const isIpo = tx.type === "IPO_BUY";
          const isBuy = (tx.type || "BUY") === "BUY" || isIpo;
          const tickerPending = Boolean(tx.tickerPending);
          let storeSymbol = (tx.symbol || "").toUpperCase();
          if (!tickerPending && tx.market === "BIST" && !storeSymbol.endsWith(".IS")) storeSymbol += ".IS";
          const displaySymbol = tickerPending ? "KOD BEKLENİYOR" : storeSymbol;

          const financials = Core.brokerTransactionFinancials(tx);
          const qty   = financials.quantity > 0 ? formatNumber(financials.quantity, 9) : null;
          const price = financials.quotedPrice > 0 ? formatMoney(financials.quotedPrice, tx.currency || "TRY", { maximumFractionDigits: 4 }) : null;
          const fee   = formatMoney(financials.fee, tx.currency || "TRY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          const total = financials.total > 0 ? formatMoney(financials.total, tx.currency || "TRY", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : null;
          const profitShare = financials.profitShare > 0
            ? formatMoney(financials.profitShare, tx.currency || "TRY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            : null;

          const card = document.createElement("div");
          card.className = "ai-tx-card";
          card.innerHTML = `
            <div class="ai-tx-card-header">
              <span class="ai-tx-badge ${isBuy ? "buy" : "sell"}">${isIpo ? "HALKA ARZ" : (isBuy ? "ALIŞ" : "SATIŞ")}</span>
              <span class="ai-tx-symbol">${escapeHtml(displaySymbol)}</span>
              <span class="ai-tx-market">${escapeHtml(tx.market || "—")}</span>
              <span class="ai-tx-source">Telegram</span>
            </div>
            <div class="ai-tx-fields">
              <div class="ai-tx-field">
                <span class="ai-tx-field-label">Adet (Lot)</span>
                <span class="ai-tx-field-value${qty ? "" : " missing"}">${qty || "Belirtilmedi"}</span>
              </div>
              <div class="ai-tx-field">
                <span class="ai-tx-field-label">Birim Fiyat</span>
                <span class="ai-tx-field-value${price ? "" : " missing"}">${price || "Belirtilmedi"}</span>
              </div>
              <div class="ai-tx-field">
                <span class="ai-tx-field-label">${isBuy ? "Toplam Ödeme" : "Net Satış Tutarı"}</span>
                <span class="ai-tx-field-value">${total || "—"}</span>
              </div>
              <div class="ai-tx-field">
                <span class="ai-tx-field-label">İşlem Ücreti</span>
                <span class="ai-tx-field-value">${fee}</span>
              </div>
              <div class="ai-tx-field">
                <span class="ai-tx-field-label">Tarih</span>
                <span class="ai-tx-field-value">${escapeHtml(tx.date || today())}</span>
              </div>
              ${profitShare ? `<div class="ai-tx-field"><span class="ai-tx-field-label">Kâr paylaşımı / aile payı</span><span class="ai-tx-field-value">${profitShare}</span></div>` : ""}
            </div>
            <div class="ai-tx-edit-grid" id="tgEditFields_${idx}" hidden>
              <label>İşlem türü
                <select id="tgType_${idx}">
                  <option value="BUY" ${(tx.type || "BUY") === "BUY" ? "selected" : ""}>Alış</option>
                  <option value="SELL" ${tx.type === "SELL" ? "selected" : ""}>Satış</option>
                  <option value="IPO_BUY" ${tx.type === "IPO_BUY" ? "selected" : ""}>Halka arz alımı</option>
                </select>
              </label>
              <label>Piyasa
                <select id="tgMarket_${idx}">
                  <option value="BIST" ${(tx.market || "BIST") === "BIST" ? "selected" : ""}>BIST</option>
                  <option value="ABD" ${tx.market === "ABD" ? "selected" : ""}>ABD</option>
                </select>
              </label>
              <label>Hisse kodu<input id="tgSymbol_${idx}" type="text" value="${tickerPending ? "" : escapeHtml((tx.symbol || "").replace(/\.IS$/i, ""))}" placeholder="Örn. INTET veya NVDA" /></label>
              <label>Adet (Lot)<input id="tgQuantity_${idx}" type="number" min="0" step="0.000000001" value="${financials.quantity || ""}" /></label>
              <label>Birim fiyat<input id="tgPrice_${idx}" type="number" min="0" step="0.000001" value="${financials.quotedPrice || ""}" /></label>
              <label>İşlem ücreti<input id="tgFee_${idx}" type="number" min="0" step="0.01" value="${financials.fee || 0}" /></label>
              <label id="tgTotalLabel_${idx}">${isBuy ? "Toplam ödeme" : "Net satış tutarı"}<input id="tgTotal_${idx}" type="number" min="0" step="0.000001" value="${financials.total > 0 ? financials.total.toFixed(6).replace(/\.?0+$/, "") : ""}" /></label>
              <label id="tgProfitShareLabel_${idx}" ${tx.type === "SELL" ? "" : "hidden"}>Kâr paylaşımı / aile payı<input id="tgProfitShare_${idx}" type="number" min="0" step="0.01" value="${financials.profitShare || 0}" /></label>
              <label>Tarih<input id="tgDate_${idx}" type="date" value="${escapeHtml(tx.date || today())}" /></label>
            </div>
            <div class="ai-tx-actions">
              <button class="button danger small" id="tgRejectBtn_${idx}">Reddet</button>
              <button class="button secondary small" id="tgEditBtn_${idx}">Düzenle</button>
              <button class="button primary" id="tgConfirmBtn_${idx}">Portföye ekle</button>
            </div>
          `;
          previewList.appendChild(card);

          const editFields = card.querySelector(`#tgEditFields_${idx}`);
          const editButton = card.querySelector(`#tgEditBtn_${idx}`);
          const typeInput = card.querySelector(`#tgType_${idx}`);
          const totalInputLabel = card.querySelector(`#tgTotalLabel_${idx}`);
          const profitShareLabel = card.querySelector(`#tgProfitShareLabel_${idx}`);
          let addedTransactionId = null;
          const syncProfitShareVisibility = () => {
            const isSellDraft = typeInput.value === "SELL";
            profitShareLabel.hidden = !isSellDraft;
            if (totalInputLabel) totalInputLabel.firstChild.textContent = isSellDraft ? "Net satış tutarı" : "Toplam ödeme";
            if (!isSellDraft) card.querySelector(`#tgProfitShare_${idx}`).value = "0";
          };
          typeInput.addEventListener("change", syncProfitShareVisibility);
          editButton.addEventListener("click", () => {
            if (addedTransactionId) {
              openTransaction("BUY", addedTransactionId);
              return;
            }
            editFields.hidden = !editFields.hidden;
            editButton.textContent = editFields.hidden ? "Düzenle" : "Düzenlemeyi kapat";
          });

          const readTelegramDraft = () => {
            const type = typeInput.value;
            const market = card.querySelector(`#tgMarket_${idx}`).value;
            const enteredSymbol = card.querySelector(`#tgSymbol_${idx}`).value.trim().toUpperCase();
            const originalSymbol = String(tx.symbol || "").replace(/\.IS$/i, "").toUpperCase();
            const draftTickerPending = tickerPending && !enteredSymbol;
            let symbol = enteredSymbol || storeSymbol;
            if (!draftTickerPending && market === "BIST" && symbol && !symbol.endsWith(".IS")) symbol += ".IS";
            if (market === "ABD" && symbol.endsWith(".IS")) symbol = symbol.slice(0, -3);
            return {
              ...tx,
              type,
              market,
              currency: market === "ABD" ? "USD" : "TRY",
              symbol,
              name: enteredSymbol && enteredSymbol !== originalSymbol
                ? enteredSymbol.replace(/\.IS$/i, "")
                : (tx.name || symbol),
              quantity: number(card.querySelector(`#tgQuantity_${idx}`).value),
              price: number(card.querySelector(`#tgPrice_${idx}`).value),
              quotedPrice: number(card.querySelector(`#tgPrice_${idx}`).value),
              fee: number(card.querySelector(`#tgFee_${idx}`).value),
              total: number(card.querySelector(`#tgTotal_${idx}`).value),
              profitShare: type === "SELL" ? number(card.querySelector(`#tgProfitShare_${idx}`).value) : 0,
              date: card.querySelector(`#tgDate_${idx}`).value || today(),
              tickerPending: draftTickerPending
            };
          };

          // Onayla
          card.querySelector(`#tgConfirmBtn_${idx}`).addEventListener("click", () => {
            const draft = readTelegramDraft();
            const normalizedFinancials = Core.brokerTransactionFinancials(draft);
            const qty2 = normalizedFinancials.quantity;
            const price2 = normalizedFinancials.price;
            const draftSymbol = draft.symbol;
            if (!qty2 || !price2 || !draftSymbol) {
              showToast("Eksik bilgi var, formu kullanarak düzenleyin."); return;
            }
            if (normalizedFinancials.profitShare > normalizedFinancials.total + 1e-8) {
              showToast("Kâr paylaşımı aracı kurumdan gelen net satış tutarını aşamaz."); return;
            }
            const newTx = {
              id: Date.now().toString(36) + Math.random().toString(36).slice(2),
              type: draft.type || "BUY",
              date: draft.date || today(),
              market: draft.market || "BIST",
              currency: draft.currency,
              symbol: draftSymbol,
              name: draft.name || draftSymbol,
              quantity: qty2,
              price: price2,
              quotedPrice: normalizedFinancials.quotedPrice,
              total: normalizedFinancials.total,
              fee: normalizedFinancials.fee,
              profitShare: normalizedFinancials.profitShare,
              tickerPending: draft.tickerPending
            };
            const result = appendValidatedTransaction(newTx);
            if (!result) return;
            const addedTransaction = result.transaction;
            addedTransactionId = addedTransaction.id;
            if (draft.tickerPending) {
              state.prices[draftSymbol] = { price: price2, changePct: 0, currency: addedTransaction.currency, updatedAt: Date.now(), delayed: true };
              saveState();
            }
            render();
            showToast(result.adjustment
              ? `${draftSymbol} Midas adedi ${formatNumber(result.adjustment.requested, 9)} olarak korundu; eski dört ondalıklı kayıtla eşleştiği için pozisyon tam kapatıldı.`
              : `${draftSymbol} eklendi; kişisel net tutar ${formatMoney(normalizedFinancials.total - normalizedFinancials.profitShare, addedTransaction.currency, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`);
            refreshQuotes({ quiet: true });
            card.style.opacity = "0.65";
            editFields.hidden = true;
            editButton.textContent = "İşlemi düzenle";
            card.querySelector(`#tgRejectBtn_${idx}`).disabled = true;
            card.querySelector(`#tgConfirmBtn_${idx}`).disabled = true;
            card.querySelector(`#tgConfirmBtn_${idx}`).textContent = "Eklendi";
            // Sadece bu kartı kuyruktan kaldır. Aynı görselde başka işlem
            // bulunduysa onlar ayrı kart olarak onay beklemeye devam eder.
            ackPendingTransaction(tx._pendingGroupId, tx._pendingTransactionId);
          });

          // Reddet
          card.querySelector(`#tgRejectBtn_${idx}`).addEventListener("click", () => {
            card.remove();
            ackPendingTransaction(tx._pendingGroupId, tx._pendingTransactionId);
          });
        });

        if (previewArea) previewArea.style.display = "block";
        banner.style.display = "none";
      })
      .catch(error => {
        if (errorEl) { errorEl.textContent = friendlyError("telegram", error); errorEl.style.display = "block"; }
      });
  }

  function ackPendingTransaction(groupId, transactionId) {
    fetch("/api/ack-transaction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: groupId, transactionId })
    }).then(async response => {
      const result = await readJsonResponse(response, "telegram");
      if (!response.ok) throw serviceError("telegram");
      return result;
    }).then(result => {
      if (result.remaining === 0) knownPendingIds.delete(groupId);
    }).catch(() => {});
  }

  // Polling başlat (yalnızca sunucu modunda, file:// protokolünde değil)
  if (location.protocol !== "file:") {
    setInterval(poll, POLL_INTERVAL);
    poll(); // İlk kontrolü hemen yap
  }
})();

// ============================================================
// AI İŞLEM ASİSTANI
// ============================================================

(function initAiAssistant() {
  // --- Durum: Çoklu görüntü desteği ---
  let aiImages = []; // [{ base64, mime, dataUrl, name }]
  let aiActiveTab = "text";
  let previousFocus = null;

  // --- Elementler ---
  const btn        = document.getElementById("aiAssistantBtn");
  const panel      = document.getElementById("aiAssistantPanel");
  const overlay    = document.getElementById("aiAssistantOverlay");
  const closeBtn   = document.getElementById("aiAssistantCloseBtn");
  const analyzeBtn = document.getElementById("aiAnalyzeBtn");
  const btnText    = document.getElementById("aiAnalyzeBtnText");
  const errorEl    = document.getElementById("aiAssistantError");
  const previewArea= document.getElementById("aiPreviewArea");
  const previewList= document.getElementById("aiPreviewList");
  const textInput  = document.getElementById("aiTextInput");
  const imageInput = document.getElementById("aiImageInput");
  const dropZone   = document.getElementById("aiDropZone");
  const imgThumbGrid = document.getElementById("aiImageThumbGrid");
  const tabs       = document.querySelectorAll(".ai-tab");
  const panes      = document.querySelectorAll(".ai-pane");

  if (!btn || !panel) return;

  // --- Panel Aç / Kapat ---
  function openPanel() {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : btn;
    panel.classList.add("open");
    overlay.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
    overlay.setAttribute("aria-hidden", "false");
    if (aiActiveTab === "text" && textInput) textInput.focus();
  }
  function closePanel() {
    panel.classList.remove("open");
    overlay.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
    overlay.setAttribute("aria-hidden", "true");
    requestAnimationFrame(() => previousFocus?.focus());
  }

  btn.addEventListener("click", openPanel);
  closeBtn && closeBtn.addEventListener("click", closePanel);
  overlay.addEventListener("click", closePanel);
  document.addEventListener("keydown", function(e) {
    if (!panel.classList.contains("open")) return;
    if (e.key === "Escape") { closePanel(); return; }
    if (e.key !== "Tab") return;
    const focusable = [...panel.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter(element => element.getClientRects().length > 0);
    if (!focusable.length) { e.preventDefault(); panel.focus(); return; }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // --- Sekme Geçişleri ---
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      aiActiveTab = target;
      tabs.forEach(t => {
        t.classList.toggle("active", t.dataset.tab === target);
        t.setAttribute("aria-selected", t.dataset.tab === target);
      });
      panes.forEach(p => p.classList.toggle("active", p.id === `aiPane${target.charAt(0).toUpperCase() + target.slice(1)}`));
      hideError();
      resetPreview();
    });
  });

  // --- Görüntü Ekle ---
  function addImageFile(file) {
    if (!file || !file.type.startsWith("image/")) {
      showError("Lütfen geçerli bir görüntü dosyası seçin (PNG, JPG, WEBP).");
      return;
    }
    if (aiImages.length >= 5) {
      showError("En fazla 5 görüntü ekleyebilirsin.");
      return;
    }
    const reader = new FileReader();
    reader.onload = function(e) {
      const dataUrl = e.target.result;
      aiImages.push({
        base64: dataUrl.split(",")[1],
        mime: file.type,
        dataUrl,
        name: file.name || "görüntü"
      });
      renderThumbGrid();
      hideError();
      resetPreview();
    };
    reader.readAsDataURL(file);
  }

  function addImageFromClipboard(item) {
    const file = item.getAsFile();
    if (file) {
      // Görüntü sekmesine geç
      if (aiActiveTab !== "image") {
        const imgTab = document.getElementById("aiTabImage");
        if (imgTab) imgTab.click();
      }
      addImageFile(file);
    }
  }

  // --- Thumbnail Grid ---
  function renderThumbGrid() {
    if (!imgThumbGrid) return;
    imgThumbGrid.innerHTML = "";

    if (aiImages.length === 0) {
      dropZone && (dropZone.style.display = "block");
      imgThumbGrid.style.display = "none";
      return;
    }

    imgThumbGrid.style.display = "grid";
    dropZone && (dropZone.style.display = aiImages.length < 5 ? "block" : "none");

    aiImages.forEach((img, idx) => {
      const thumb = document.createElement("div");
      thumb.className = "ai-thumb";
      thumb.innerHTML = `
        <img src="${img.dataUrl}" alt="Görüntü ${idx + 1}" />
        <button class="ai-thumb-remove" data-idx="${idx}" title="Kaldır">✕</button>
        <span class="ai-thumb-label">${idx + 1}</span>
      `;
      imgThumbGrid.appendChild(thumb);
    });

    imgThumbGrid.querySelectorAll(".ai-thumb-remove").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx);
        aiImages.splice(idx, 1);
        renderThumbGrid();
        resetPreview();
      });
    });
  }

  // --- Olay Dinleyicileri ---
  // Dosya seçici
  dropZone && dropZone.addEventListener("click", () => imageInput && imageInput.click());
  dropZone && dropZone.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") imageInput && imageInput.click();
  });
  imageInput && imageInput.addEventListener("change", e => {
    Array.from(e.target.files).forEach(addImageFile);
    if (imageInput) imageInput.value = "";
  });

  // Drag & Drop
  dropZone && dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("dragover"); });
  dropZone && dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
  dropZone && dropZone.addEventListener("drop", e => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    Array.from(e.dataTransfer.files).forEach(addImageFile);
  });

  // Ctrl+V yapıştırma — panel açıkken her yerden çalışır
  document.addEventListener("paste", function(e) {
    if (!panel.classList.contains("open")) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    let found = false;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        addImageFromClipboard(item);
        found = true;
        break;
      }
    }
    if (found) showToast("Görüntü yapıştırıldı");
  });

  // --- Yardımcılar ---
  function showError(msg) {
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.style.display = "block";
  }
  function hideError() {
    if (errorEl) errorEl.style.display = "none";
  }
  function resetPreview() {
    if (previewArea) previewArea.style.display = "none";
    if (previewList) previewList.innerHTML = "";
  }
  function setLoading(loading, progress) {
    if (!analyzeBtn || !btnText) return;
    analyzeBtn.disabled = loading;
    if (loading) {
      btnText.innerHTML = progress
        ? `<span class="ai-spinner"></span>${progress}`
        : `<span class="ai-spinner"></span>Analiz ediliyor…`;
    } else {
      btnText.textContent = "Analiz et";
    }
  }

  // --- Gemini API Çağrısı (tek istek, birden fazla görüntü destekler) ---
  async function callGeminiForTransaction(userText, images) {
    if (!hasGeminiKey()) throw new Error("Gemini API anahtarı bulunamadı. Ayarlar → Yapay Zekâ bölümünden girin.");
    if (getGeminiKey() && !await syncGeminiKeyToServer(getGeminiKey())) {
      throw new Error("Gemini anahtarı güvenli bulut ayarlarına kaydedilemedi.");
    }

    const model = getGeminiModel() || $("#geminiModelSelect")?.value || "";
    if (!model) throw new Error("Ayarlar → Yapay Zekâ bölümünden bir model seçin.");
    const todayStr = today();

    const systemPrompt = `Sen bir finansal asistansın. Kullanıcının verdiği bilgiden (metin veya ekran görüntüsü) hisse senedi işlem bilgilerini çıkarıp YALNIZCA JSON döndüreceksin. Başka hiçbir açıklama veya metin yazma.

Bugünün tarihi: ${todayStr}

Döndüreceğin format — birden fazla işlem olabilir, her zaman bir dizi döndür:
[
  {
    "symbol": "GARAN",
    "market": "BIST",
    "type": "BUY",
    "quantity": 50,
    "price": 106.5,
    "fee": 1.5,
    "total": 5326.5,
    "date": "${todayStr}",
    "currency": "TRY",
    "name": "Garanti Bankası"
  }
]

Kurallar:
- symbol: sadece hisse kodu (BIST için .IS ekleme). Örn: "GARAN", "THYAO", "NVDA"
- market: "BIST" (Türk hisseleri) veya "ABD" (yabancı hisseler)
- type: "BUY" (alış) veya "SELL" (satış)
- quantity: lot/adet sayısı (sayı)
- price: birim fiyat (sayı). Toplam tutar verilmişse lot'a böl.
- fee: işlem ücreti veya komisyon (sayı). Görünmüyorsa 0.
- total: ekrandaki Toplam satırı (sayı). Satışta komisyon düşülmüş net gelir, alışta komisyon eklenmiş toplam ödemedir. Brüt adet × fiyatı bu alana yazma.
- date: YYYY-MM-DD formatında. Belirtilmemişse bugün.
- currency: "TRY" (BIST) veya "USD" (ABD)
- name: şirket adı (bilinmiyorsa symbol ile aynı yaz)
- Bilinmeyen alanlar için null kullan.
- Sadece JSON döndür. Markdown code block kullanma.`;

    const parts = [];

    if (images && images.length > 0) {
      // Tüm görüntüleri tek istekte gönder
      images.forEach((img, i) => {
        parts.push({ inlineData: { mimeType: img.mime, data: img.base64 } });
        if (images.length > 1) parts.push({ text: `Görüntü ${i + 1}:` });
      });
      parts.push({ text: systemPrompt + `\n\n${images.length > 1 ? "Yukarıdaki tüm görüntülerdeki" : "Görüntüdeki"} işlem bilgilerini çıkar.` });
    } else {
      parts.push({ text: systemPrompt + `\n\nKullanıcı metni: "${userText}"` });
    }

    const response = await fetch("/api/ai/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        contents: [{ parts }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
      })
    });

    const data = await readJsonResponse(response, "gemini");
    if (!response.ok) throw serviceError("gemini");

    let raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const startJson = raw.indexOf("["); const endJson = raw.lastIndexOf("]");
    if (startJson !== -1 && endJson !== -1 && endJson > startJson) { raw = raw.substring(startJson, endJson + 1); } else {
      raw = raw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
      if (raw.startsWith("{")) raw = `[${raw}]`;
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { throw new Error("AI yanıtı ayrıştırılamadı. Lütfen tekrar deneyin."); }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("İşlem bilgisi bulunamadı. Daha açık bir metin veya görüntü deneyin.");
    }

    return parsed;
  }

  // --- Önizleme Kartı Render ---
  function renderPreviewCards(transactions) {
    if (!previewList || !previewArea) return;
    previewList.innerHTML = "";

    transactions.forEach((tx, idx) => {
      const isBuy = (tx.type || "BUY") === "BUY";
      const badgeClass = isBuy ? "buy" : "sell";
      const badgeText = isBuy ? "ALIŞ" : "SATIŞ";

      let displaySymbol = (tx.symbol || "—").toUpperCase();
      let storeSymbol = displaySymbol;
      if (tx.market === "BIST" && !storeSymbol.endsWith(".IS")) storeSymbol += ".IS";

      const financials = Core.brokerTransactionFinancials(tx);
      const qty   = financials.quantity > 0 ? formatNumber(financials.quantity, 9) : null;
      const price = financials.quotedPrice > 0 ? formatMoney(financials.quotedPrice, tx.currency || "TRY", { maximumFractionDigits: 4 }) : null;
      const fee   = formatMoney(financials.fee, tx.currency || "TRY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const total = financials.total > 0 ? formatMoney(financials.total, tx.currency || "TRY", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : null;

      const card = document.createElement("div");
      card.className = "ai-tx-card";
      card.innerHTML = `
        <div class="ai-tx-card-header">
          <span class="ai-tx-badge ${badgeClass}">${badgeText}</span>
          <span class="ai-tx-symbol">${escapeHtml(storeSymbol)}</span>
          <span class="ai-tx-market">${escapeHtml(tx.market || "—")}</span>
        </div>
        <div class="ai-tx-fields">
          <div class="ai-tx-field">
            <span class="ai-tx-field-label">Adet (Lot)</span>
            <span class="ai-tx-field-value${qty ? "" : " missing"}">${qty || "Belirtilmedi"}</span>
          </div>
          <div class="ai-tx-field">
            <span class="ai-tx-field-label">Birim Fiyat</span>
            <span class="ai-tx-field-value${price ? "" : " missing"}">${price || "Belirtilmedi"}</span>
          </div>
          <div class="ai-tx-field">
            <span class="ai-tx-field-label">${isBuy ? "Toplam Ödeme" : "Net Toplam"}</span>
            <span class="ai-tx-field-value${total ? "" : " missing"}">${total || "—"}</span>
          </div>
          <div class="ai-tx-field">
            <span class="ai-tx-field-label">İşlem Ücreti</span>
            <span class="ai-tx-field-value">${fee}</span>
          </div>
          <div class="ai-tx-field">
            <span class="ai-tx-field-label">Tarih</span>
            <span class="ai-tx-field-value">${escapeHtml(tx.date || today())}</span>
          </div>
          ${tx.name && tx.name !== displaySymbol && tx.name !== storeSymbol ? `
          <div class="ai-tx-field" style="grid-column: 1/-1">
            <span class="ai-tx-field-label">Şirket</span>
            <span class="ai-tx-field-value">${escapeHtml(tx.name)}</span>
          </div>` : ""}
        </div>
        <div class="ai-tx-actions">
          <button class="button secondary" id="aiEditTxBtn_${idx}">Formda düzenle</button>
          <button class="button primary" id="aiConfirmTxBtn_${idx}">Ekle</button>
        </div>
      `;
      previewList.appendChild(card);

      card.querySelector(`#aiConfirmTxBtn_${idx}`).addEventListener("click", () => {
        confirmAiTransaction(tx, storeSymbol);
        card.style.opacity = "0.4";
        card.style.pointerEvents = "none";
        card.querySelector(`#aiConfirmTxBtn_${idx}`).textContent = "Eklendi";
      });

      card.querySelector(`#aiEditTxBtn_${idx}`).addEventListener("click", () => {
        openAiTransactionInForm(tx, storeSymbol);
      });
    });

    previewArea.style.display = "block";
  }

  // --- İşlemi Portföye Ekle ---
  function confirmAiTransaction(tx, storeSymbol) {
    const financials = Core.brokerTransactionFinancials(tx);
    const qty = financials.quantity;
    const price = financials.price;
    if (!qty || !price || !storeSymbol) {
      showToast("Eksik bilgi var, lütfen formu kullanarak düzenleyin.");
      return;
    }
    const newTx = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      type: tx.type || "BUY",
      date: tx.date || today(),
      market: tx.market || "BIST",
      currency: tx.currency || (tx.market === "ABD" ? "USD" : "TRY"),
      symbol: storeSymbol,
      name: tx.name || storeSymbol,
      quantity: qty,
      price,
      quotedPrice: financials.quotedPrice,
      total: financials.total,
      fee: financials.fee,
      profitShare: financials.profitShare
    };
    const result = appendValidatedTransaction(newTx);
    if (!result) return;
    const addedTransaction = result.transaction;
    render();
    showToast(result.adjustment
      ? `${storeSymbol} Midas adedi ${formatNumber(result.adjustment.requested, 9)} olarak korundu; eski dört ondalıklı kayıtla eşleştiği için pozisyon tam kapatıldı.`
      : `${storeSymbol} işlemi eklendi; net tutar ${formatMoney(financials.total, addedTransaction.currency, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`);
    refreshQuotes({ quiet: true });
  }

  // --- Formu AI Verileriyle Aç ---
  function openAiTransactionInForm(tx, storeSymbol) {
    const financials = Core.brokerTransactionFinancials(tx);
    openTransaction(tx.type || "BUY");
    const market = tx.market || "BIST";
    document.getElementById("transactionMarket").value = market;
    document.getElementById("transactionCurrency").value = tx.currency || (market === "ABD" ? "USD" : "TRY");
    document.getElementById("transactionSymbol").value = storeSymbol || "";
    if (tx.name)     document.getElementById("transactionName").value = tx.name;
    if (financials.quotedPrice) document.getElementById("transactionPrice").value = financials.quotedPrice;
    if (financials.quantity) document.getElementById("transactionQuantity").value = financials.quantity;
    if (financials.total > 0) document.getElementById("transactionTotal").value = financials.total.toFixed(2);
    document.getElementById("transactionFee").value = financials.fee;
    document.getElementById("transactionProfitShare").value = financials.profitShare || 0;
    if (tx.date)     document.getElementById("transactionDate").value = tx.date;
    closePanel();
  }

  // --- Analiz Et ---
  analyzeBtn && analyzeBtn.addEventListener("click", async () => {
    hideError();
    resetPreview();

    if (!hasGeminiKey()) {
      showError("Gemini API anahtarı bulunamadı. Lütfen Ayarlar → Yapay Zekâ bölümünden girin.");
      return;
    }

    const useImage = aiActiveTab === "image";

    if (useImage && aiImages.length === 0) {
      showError("Lütfen en az bir görüntü ekleyin (sürükle, tıkla veya Ctrl+V ile yapıştır).");
      return;
    }
    if (!useImage) {
      const txt = textInput ? textInput.value.trim() : "";
      if (!txt) { showError("Lütfen işlem bilgisini yazın."); return; }
    }

    const imgCount = useImage ? aiImages.length : 0;
    setLoading(true, imgCount > 1 ? `${imgCount} görüntü analiz ediliyor…` : null);

    try {
      const userText = textInput ? textInput.value.trim() : "";
      const transactions = await callGeminiForTransaction(
        useImage ? null : userText,
        useImage ? aiImages : null
      );
      renderPreviewCards(transactions);
    } catch (err) {
      showError(friendlyError("gemini", err));
    } finally {
      setLoading(false);
    }
  });

})();

function handleFileUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();

  if (file.name.toLowerCase().endsWith(".csv")) {
    reader.onload = function(evt) {
      try {
        const text = evt.target.result;
        const lines = text.split(/\r\n|\n/).map(line => line.split(/;|,|\t/));
        processExcelRows(lines);
        $("#importDialog").showModal();
      } catch (err) {
        showToast(`CSV okunamadı: ${err.message}`);
      }
    };
    reader.readAsText(file, "UTF-8");
  } else {
    reader.onload = function(evt) {
      try {
        if (typeof XLSX === "undefined") {
          showToast("Excel kütüphanesi yüklenemedi. İnternet bağlantınızı kontrol edin veya dosyayı CSV olarak kaydedip deneyin.");
          return;
        }
        const data = new Uint8Array(evt.target.result);
        const workbook = XLSX.read(data, { type: "array" });
        if (!workbook.SheetNames || !workbook.SheetNames.length) {
          showToast("Excel dosyasında sayfa bulunamadı.");
          return;
        }
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const jsonRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: "" });
        processExcelRows(jsonRows);
        $("#importDialog").showModal();
      } catch (err) {
        showToast(`Excel okunamadı: ${err.message}`);
      }
    };
    reader.readAsArrayBuffer(file);
  }
  e.target.value = "";
}

window.confirmImportData = function() {
  if (!parsedImportData || !parsedImportData.length) {
    showToast("Aktarılacak satır bulunamadı.");
    return;
  }

  // Gerçek Excel verisi aktarıldığında deneme kapanmış pozisyonları temizle
  state.closedPositions = (state.closedPositions || []).filter(p => !p.demo && !["cp1","cp2","cp3"].includes(p.id));

  let importedCount = 0;
  parsedImportData.forEach(item => {
    const symbol = (item.symbol || "VARLIK").trim().toUpperCase();
    const lot = number(item.lot) || 1;
    const buyPrice = number(item.buyPrice) || 0;
    const sellPrice = number(item.sellPrice) || 0;
    const cost = number(item.cost) || (lot * buyPrice);
    const revenue = number(item.revenue) || (lot * sellPrice);
    const profit = Number.isFinite(item.profit) ? item.profit : (revenue - cost);
    const profitPercent = cost ? (profit / cost) * 100 : 0;
    const sellDate = item.sellDate || today();
    const currency = item.currency || "TRY";

    state.closedPositions.push({
      id: uid("cp"),
      symbol,
      name: symbol,
      lot,
      buyPrice,
      sellPrice,
      cost,
      revenue,
      profit,
      profitPercent,
      profitTry: item.profitTry || null,
      sellDate,
      currency,
      status: "closed",
      demo: false
    });
    importedCount++;
  });

  state.isDemo = false;
  parsedImportData = [];
  saveState();
  renderClosedPositions();
  const dialog = document.getElementById("importDialog");
  if (dialog) dialog.close();
  showToast(`${importedCount} kapanmış pozisyon başarıyla aktarıldı!`);
};

window.clearAllClosedPositions = function() {
  const txClosed = getClosedPositionsFromTransactions();
  const manualCount = (state.closedPositions || []).length;

  if (!manualCount && !txClosed.length) {
    showToast("Silinecek kapanmış pozisyon kaydı bulunmuyor.");
    return;
  }
  if (!manualCount) {
    showToast("Bu kayıtlar işlem defterindeki satışlardan oluşuyor; ilgili satışı İşlemler ekranından düzenleyin.");
    return;
  }
  if (!confirm(`${manualCount} elle eklenmiş kapanmış pozisyon silinecek. İşlem defterinden oluşan ${txClosed.length} kayıt korunacak. Devam edilsin mi?`)) return;

  state.closedPositions = [];
  saveState();
  render();
  showToast("Elle eklenmiş kapanmış pozisyonlar silindi; işlem defteri korundu.");
};
