(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PortfolioCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ASSET_TYPES = new Set(["BUY", "SELL", "IPO_BUY"]);
  const CASH_TYPES = new Set(["DEPOSIT", "WITHDRAWAL", "DIVIDEND"]);
  const TRANSACTION_TYPES = new Set([...ASSET_TYPES, ...CASH_TYPES]);
  const CURRENCIES = new Set(["TRY", "USD"]);
  const MARKETS = new Set(["BIST", "ABD", "NAKİT"]);
  const SYMBOL_PATTERN = /^[A-Z0-9.\-^=]{1,24}$/;
  const EPSILON = 1e-8;
  const LEGACY_QUANTITY_TOLERANCE = 5e-5;

  function parseNumber(value) {
    if (value === null || value === undefined || value === "") return 0;
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;

    let text = String(value).trim().replace(/[^0-9.,\-]/g, "");
    if (!text) return 0;
    if (text.includes(".") && text.includes(",")) {
      text = text.indexOf(".") < text.indexOf(",")
        ? text.replace(/\./g, "").replace(",", ".")
        : text.replace(/,/g, "");
    } else if (text.includes(",")) {
      text = text.replace(",", ".");
    }
    const parsed = Number.parseFloat(text);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function localDateISO(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function isValidDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
    const [year, month, day] = value.split("-").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year
      && parsed.getUTCMonth() === month - 1
      && parsed.getUTCDate() === day;
  }

  function createId(prefix = "id") {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return `${prefix}-${globalThis.crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function normalizeMarket(value, symbol = "") {
    const market = String(value || "").trim().toUpperCase();
    if (MARKETS.has(market)) return market;
    return String(symbol || "").toUpperCase().endsWith(".IS") ? "BIST" : "ABD";
  }

  function normalizeSymbol(value, market) {
    let symbol = String(value || "").trim().toUpperCase();
    if (!symbol) return "";
    if (market === "BIST" && !symbol.endsWith(".IS")) symbol += ".IS";
    if (market === "ABD" && symbol.endsWith(".IS")) symbol = symbol.slice(0, -3);
    return symbol;
  }

  function normalizeTransaction(raw, index = 0) {
    const value = raw && typeof raw === "object" ? raw : {};
    const type = TRANSACTION_TYPES.has(String(value.type || "").toUpperCase())
      ? String(value.type).toUpperCase()
      : "BUY";
    let market = normalizeMarket(value.market, value.symbol);
    if (CASH_TYPES.has(type) && !value.symbol) market = "NAKİT";
    const symbol = normalizeSymbol(value.symbol, market);
    const currency = CURRENCIES.has(String(value.currency || "").toUpperCase())
      ? String(value.currency).toUpperCase()
      : (market === "ABD" ? "USD" : "TRY");
    const createdAt = Number.isFinite(Number(value.createdAt))
      ? Number(value.createdAt)
      : index;

    return {
      ...value,
      id: String(value.id || createId("tx")),
      type,
      date: String(value.date || "").trim(),
      market,
      currency,
      symbol,
      name: String(value.name || symbol || "Nakit hareketi").trim(),
      quantity: Math.max(0, parseNumber(value.quantity)),
      price: Math.max(0, parseNumber(value.price)),
      fee: Math.max(0, parseNumber(value.fee)),
      profitShare: Math.max(0, parseNumber(value.profitShare)),
      createdAt,
      tickerPending: Boolean(value.tickerPending)
    };
  }

  function brokerTransactionFinancials(raw) {
    const value = raw && typeof raw === "object" ? raw : {};
    const type = String(value.type || "BUY").toUpperCase();
    const quantity = Math.max(0, parseNumber(value.quantity));
    const quotedPrice = Math.max(0, parseNumber(value.quotedPrice ?? value.price));
    const fee = Math.max(0, parseNumber(value.fee));
    const profitShare = type === "SELL" ? Math.max(0, parseNumber(value.profitShare)) : 0;
    const reportedTotal = Math.max(0, parseNumber(value.total));
    const isSell = type === "SELL";
    let price = Math.max(0, parseNumber(value.price)) || quotedPrice;
    let total = quantity * price + (isSell ? -fee : fee);
    let reportedTotalAccepted = false;

    if (reportedTotal > 0 && quantity > 0 && quotedPrice > 0) {
      const totalFromQuotedPrice = quantity * quotedPrice + (isSell ? -fee : fee);
      // Aracı kurum birim fiyatı iki ondalıkla gösterebilir. Görseldeki net
      // toplam bu yuvarlama aralığındaysa nakit hareketinin kesin kaynağıdır.
      const displayRoundingTolerance = Math.max(0.02, quantity * 0.005 + 0.01);
      if (Math.abs(totalFromQuotedPrice - reportedTotal) <= displayRoundingTolerance) {
        const grossFromReportedTotal = reportedTotal + (isSell ? fee : -fee);
        if (grossFromReportedTotal > 0) {
          price = grossFromReportedTotal / quantity;
          total = reportedTotal;
          reportedTotalAccepted = true;
        }
      }
    }

    return { quantity, quotedPrice, price, fee, profitShare, total, reportedTotalAccepted };
  }

  function sortTransactions(transactions) {
    return (Array.isArray(transactions) ? transactions : [])
      .map((tx, index) => ({ tx: normalizeTransaction(tx, index), index }))
      .sort((a, b) => a.tx.date.localeCompare(b.tx.date)
        || a.tx.createdAt - b.tx.createdAt
        || a.index - b.index)
      .map(item => item.tx);
  }

  function isLegacyRoundedFullClose(requested, available) {
    if (requested <= EPSILON || available <= EPSILON) return false;
    // Only a genuinely four-decimal legacy balance may need this repair.
    if (Math.abs(available - Math.round(available * 10000) / 10000) > EPSILON
      || Math.abs(requested - Math.round(requested * 10000) / 10000) <= EPSILON) return false;
    const difference = Math.abs(requested - available);
    if (difference <= EPSILON || difference > LEGACY_QUANTITY_TOLERANCE + EPSILON) return false;
    return Math.round(requested * 10000) === Math.round(available * 10000);
  }

  function auditTransactions(transactions) {
    const balances = new Map();
    const errors = [];
    for (const tx of sortTransactions(transactions)) {
      if (!ASSET_TYPES.has(tx.type) || !tx.symbol) continue;
      const key = `${tx.market}|${tx.symbol}`;
      const current = balances.get(key) || 0;
      if (tx.type === "BUY" || tx.type === "IPO_BUY") {
        balances.set(key, current + tx.quantity);
      } else if (isLegacyRoundedFullClose(tx.quantity, current)) {
        balances.set(key, 0);
      } else if (tx.quantity > current + EPSILON) {
        errors.push({
          code: "OVERSELL",
          txId: tx.id,
          symbol: tx.symbol,
          requested: tx.quantity,
          available: Math.max(0, current),
          message: `${tx.symbol} için ${tx.quantity} adet satış girilmiş; o tarihte yalnızca ${Math.max(0, current)} adet mevcut.`
        });
        balances.set(key, 0);
      } else {
        balances.set(key, Math.max(0, current - tx.quantity));
      }
    }
    return errors;
  }

  function reconcileSellQuantity(transactions, rawTransaction) {
    const transaction = normalizeTransaction(rawTransaction);
    if (transaction.type !== "SELL") return { transaction, adjustment: null };
    let available = 0;
    const key = `${transaction.market}|${transaction.symbol}`;
    for (const tx of sortTransactions([...(Array.isArray(transactions) ? transactions : []), transaction])) {
      if (tx.id === transaction.id) break;
      if (`${tx.market}|${tx.symbol}` !== key || !ASSET_TYPES.has(tx.type)) continue;
      if (tx.type === "BUY" || tx.type === "IPO_BUY") available += tx.quantity;
      else if (isLegacyRoundedFullClose(tx.quantity, available)) available = 0;
      else available = Math.max(0, available - tx.quantity);
    }
    if (!isLegacyRoundedFullClose(transaction.quantity, available)) return { transaction, adjustment: null };
    return {
      transaction,
      adjustment: {
        requested: transaction.quantity,
        available,
        difference: transaction.quantity - available,
        brokerQuantityPreserved: true
      }
    };
  }

  function validateTransaction(raw) {
    const errors = [];
    const type = String(raw?.type || "").toUpperCase();
    const market = normalizeMarket(raw?.market, raw?.symbol);
    const symbol = normalizeSymbol(raw?.symbol, market);
    const quantity = parseNumber(raw?.quantity);
    const price = parseNumber(raw?.price);
    const fee = parseNumber(raw?.fee);
    const profitShare = parseNumber(raw?.profitShare);

    if (!TRANSACTION_TYPES.has(type)) errors.push("Geçerli bir işlem türü seçin.");
    if (!isValidDate(raw?.date)) errors.push("Geçerli bir işlem tarihi girin.");
    if (fee < 0) errors.push("Komisyon negatif olamaz.");
    if (profitShare < 0) errors.push("Kâr paylaşımı negatif olamaz.");
    if (profitShare > 0 && type !== "SELL") errors.push("Kâr paylaşımı yalnızca satış işlemlerine eklenebilir.");
    if (ASSET_TYPES.has(type)) {
      if (!symbol || !SYMBOL_PATTERN.test(symbol)) errors.push("Geçerli bir hisse kodu girin.");
      if (quantity <= 0) errors.push("Adet sıfırdan büyük olmalı.");
      if (price <= 0) errors.push("Birim fiyat sıfırdan büyük olmalı.");
      if (market !== "BIST" && market !== "ABD") errors.push("Hisse işlemi için BIST veya ABD piyasasını seçin.");
    } else if (CASH_TYPES.has(type)) {
      if (quantity <= 0 || price <= 0) errors.push("Nakit hareketi tutarı sıfırdan büyük olmalı.");
    }
    return errors;
  }

  function baseConverter(settings) {
    const baseCurrency = settings?.baseCurrency === "USD" ? "USD" : "TRY";
    const fx = parseNumber(settings?.fxUsdTry) || 1;
    return {
      baseCurrency,
      convert(value, currency) {
        const amount = parseNumber(value);
        if (currency === baseCurrency) return amount;
        return baseCurrency === "TRY" ? amount * fx : amount / fx;
      }
    };
  }

  function aggregateClosedPositionsBySymbol(positions, settings) {
    const { baseCurrency, convert } = baseConverter(settings);
    const grouped = new Map();

    for (const position of Array.isArray(positions) ? positions : []) {
      const rawSymbol = String(position?.symbol || "").trim();
      if (!rawSymbol) continue;

      const rawCurrency = String(position?.currency || "").toUpperCase();
      const inferredMarket = position?.market
        || (rawCurrency === "USD" ? "ABD" : rawSymbol.toUpperCase().endsWith(".IS") || rawCurrency === "TRY" ? "BIST" : "ABD");
      const market = normalizeMarket(inferredMarket, rawSymbol);
      const currency = CURRENCIES.has(rawCurrency) ? rawCurrency : (market === "ABD" ? "USD" : "TRY");
      const symbol = normalizeSymbol(rawSymbol, market);
      if (!symbol) continue;

      if (!grouped.has(symbol)) {
        grouped.set(symbol, {
          symbol,
          profit: 0,
          cost: 0,
          revenue: 0,
          saleCount: 0,
          baseCurrency
        });
      }

      const aggregate = grouped.get(symbol);
      aggregate.profit += convert(position?.profit || 0, currency);
      aggregate.cost += convert(position?.cost || 0, currency);
      aggregate.revenue += convert(position?.revenue || 0, currency);
      aggregate.saleCount += 1;
    }

    return [...grouped.values()]
      .map(item => ({
        ...item,
        profitPercent: item.cost > EPSILON ? item.profit / item.cost * 100 : 0
      }))
      .sort((a, b) => b.profit - a.profit || a.symbol.localeCompare(b.symbol));
  }

  function groupClosedPositionsForDisplay(positions) {
    const grouped = new Map();
    const precise = value => parseNumber(value).toFixed(9);

    for (const position of Array.isArray(positions) ? positions : []) {
      const rawSymbol = String(position?.symbol || "").trim();
      const rawCurrency = String(position?.currency || "").toUpperCase();
      const inferredMarket = position?.market
        || (rawCurrency === "USD" ? "ABD" : rawSymbol.toUpperCase().endsWith(".IS") || rawCurrency === "TRY" ? "BIST" : "ABD");
      const market = normalizeMarket(inferredMarket, rawSymbol);
      const currency = CURRENCIES.has(rawCurrency) ? rawCurrency : (market === "ABD" ? "USD" : "TRY");
      const symbol = normalizeSymbol(rawSymbol, market);
      const key = JSON.stringify([
        symbol,
        String(position?.buyDate || ""),
        String(position?.sellDate || ""),
        currency,
        precise(position?.buyPrice),
        precise(position?.sellPrice)
      ]);

      if (!grouped.has(key)) {
        grouped.set(key, {
          key,
          items: [],
          summary: {
            ...position,
            symbol,
            market,
            currency,
            lot: 0,
            cost: 0,
            revenue: 0,
            profit: 0,
            fee: 0,
            profitShare: 0,
            recordCount: 0
          }
        });
      }

      const group = grouped.get(key);
      group.items.push(position);
      group.summary.lot += parseNumber(position?.lot);
      group.summary.cost += parseNumber(position?.cost);
      group.summary.revenue += parseNumber(position?.revenue);
      group.summary.profit += parseNumber(position?.profit);
      group.summary.fee += parseNumber(position?.fee);
      group.summary.profitShare += parseNumber(position?.profitShare);
      group.summary.recordCount += 1;
    }

    return [...grouped.values()].map(group => ({
      ...group,
      summary: {
        ...group.summary,
        profitPercent: group.summary.cost > EPSILON ? group.summary.profit / group.summary.cost * 100 : 0
      }
    }));
  }

  function cumulativeExternalFlow(transactions, settings, throughDate = "9999-12-31") {
    const { convert } = baseConverter(settings);
    const includeCash = settings?.includeCash === true;
    let total = 0;
    for (const tx of sortTransactions(transactions)) {
      if (tx.date > throughDate) break;
      const gross = tx.quantity * tx.price;
      let flow = 0;
      if (includeCash) {
        if (tx.type === "DEPOSIT") flow = gross - tx.fee;
        else if (tx.type === "WITHDRAWAL") flow = -gross - tx.fee;
      } else {
        if (tx.type === "BUY" || tx.type === "IPO_BUY") flow = gross + tx.fee;
        else if (tx.type === "SELL") flow = -gross + tx.fee + tx.profitShare;
      }
      total += convert(flow, tx.currency);
    }
    return total;
  }

  function calculatePeriodReturn({ snapshots, currentValue, transactions, settings, targetDate }) {
    const baseCurrency = settings?.baseCurrency === "USD" ? "USD" : "TRY";
    const includeCash = settings?.includeCash === true;
    const compatible = (Array.isArray(snapshots) ? snapshots : [])
      .filter(snapshot => {
        if (!snapshot || !isValidDate(snapshot.date) || parseNumber(snapshot.value) <= 0) return false;
        const snapshotBase = snapshot.baseCurrency || baseCurrency;
        const snapshotCashMode = snapshot.includeCash === undefined ? includeCash : snapshot.includeCash === true;
        return snapshotBase === baseCurrency && snapshotCashMode === includeCash;
      })
      .sort((a, b) => a.date.localeCompare(b.date));
    let start = null;
    for (const snapshot of compatible) {
      if (snapshot.date <= targetDate) start = snapshot;
      else break;
    }
    if (!start) return null;
    const startValue = parseNumber(start.value);
    if (startValue <= EPSILON) return null;
    const startFlow = Number.isFinite(Number(start.netFlows))
      ? Number(start.netFlows)
      : cumulativeExternalFlow(transactions, settings, start.date);
    const currentFlow = cumulativeExternalFlow(transactions, settings);
    const adjustedGain = parseNumber(currentValue) - startValue - (currentFlow - startFlow);
    return adjustedGain / startValue * 100;
  }

  function calculatePortfolio(appState) {
    const source = appState && typeof appState === "object" ? appState : {};
    const settings = source.settings || {};
    const { convert } = baseConverter(settings);
    const books = new Map();
    const cash = { TRY: 0, USD: 0 };
    const realized = { TRY: 0, USD: 0 };
    const closedFromTransactions = [];
    const integrityErrors = [];

    for (const tx of sortTransactions(source.transactions)) {
      const gross = tx.quantity * tx.price;
      if (tx.type === "DEPOSIT") {
        cash[tx.currency] = (cash[tx.currency] || 0) + gross - tx.fee;
        continue;
      }
      if (tx.type === "WITHDRAWAL") {
        cash[tx.currency] = (cash[tx.currency] || 0) - gross - tx.fee;
        continue;
      }
      if (tx.type === "DIVIDEND") {
        cash[tx.currency] = (cash[tx.currency] || 0) + gross - tx.fee;
        continue;
      }
      if (!tx.symbol || !ASSET_TYPES.has(tx.type)) continue;

      const key = `${tx.market}|${tx.symbol}`;
      if (!books.has(key)) {
        books.set(key, {
          key,
          symbol: tx.symbol,
          name: tx.name || tx.symbol,
          market: tx.market,
          currency: tx.currency,
          quantity: 0,
          cost: 0,
          ipoCount: 0,
          tickerPending: Boolean(tx.tickerPending),
          initialPrice: tx.price,
          firstBuyDate: tx.date
        });
      }
      const book = books.get(key);
      book.name = tx.name || book.name;
      book.tickerPending = book.tickerPending || Boolean(tx.tickerPending);

      if (tx.type === "BUY" || tx.type === "IPO_BUY") {
        if (book.quantity <= EPSILON) book.firstBuyDate = tx.date;
        if (!book.initialPrice && tx.price > 0) book.initialPrice = tx.price;
        book.quantity += tx.quantity;
        book.cost += gross + tx.fee;
        book.ipoCount += tx.type === "IPO_BUY" ? 1 : 0;
        cash[tx.currency] = (cash[tx.currency] || 0) - gross - tx.fee;
        continue;
      }

      const available = Math.max(0, book.quantity);
      const legacyFullClose = isLegacyRoundedFullClose(tx.quantity, available);
      const sellQuantity = legacyFullClose ? available : Math.min(tx.quantity, available);
      if (tx.quantity > available + EPSILON && !legacyFullClose) {
        integrityErrors.push({
          code: "OVERSELL",
          txId: tx.id,
          symbol: tx.symbol,
          requested: tx.quantity,
          available,
          message: `${tx.symbol} satış miktarı mevcut pozisyonu aşıyor.`
        });
      }
      if (sellQuantity <= EPSILON) continue;

      const averageCost = available > EPSILON ? book.cost / available : 0;
      const removedCost = averageCost * sellQuantity;
      const appliedFee = legacyFullClose
        ? tx.fee
        : tx.quantity > EPSILON ? tx.fee * (sellQuantity / tx.quantity) : 0;
      const appliedProfitShare = legacyFullClose
        ? tx.profitShare
        : tx.quantity > EPSILON ? tx.profitShare * (sellQuantity / tx.quantity) : 0;
      // Eski kayıt 4 ondalığa yuvarlanmışsa pozisyonun tamamını kapat, fakat
      // Midas'tan gelen gerçek adet ve net satış gelirini aynen koru.
      const proceeds = legacyFullClose
        ? tx.price * tx.quantity - tx.fee - tx.profitShare
        : tx.price * sellQuantity - appliedFee - appliedProfitShare;
      const profit = proceeds - removedCost;
      book.quantity = Math.max(0, book.quantity - sellQuantity);
      book.cost = Math.max(0, book.cost - removedCost);
      realized[tx.currency] = (realized[tx.currency] || 0) + profit;
      cash[tx.currency] = (cash[tx.currency] || 0) + proceeds;
      closedFromTransactions.push({
        id: `tx_cp_${tx.id}`,
        sourceTransactionId: tx.id,
        symbol: tx.symbol,
        name: tx.name || book.name || tx.symbol,
        lot: legacyFullClose ? tx.quantity : sellQuantity,
        buyPrice: averageCost,
        sellPrice: tx.price,
        cost: removedCost,
        revenue: proceeds,
        fee: appliedFee,
        profitShare: appliedProfitShare,
        profit,
        profitPercent: removedCost > EPSILON ? profit / removedCost * 100 : 0,
        buyDate: book.firstBuyDate || tx.date,
        sellDate: tx.date,
        currency: tx.currency,
        market: tx.market,
        status: "closed"
      });
    }

    const holdings = [...books.values()]
      .filter(book => book.quantity > EPSILON)
      .map(book => {
        const actualCurrency = book.market === "BIST" || book.symbol.endsWith(".IS") ? "TRY" : "USD";
        const savedQuote = source.prices?.[book.symbol];
        const hasMarketPrice = Number.isFinite(Number(savedQuote?.price)) && Number(savedQuote.price) > 0;
        const quote = hasMarketPrice
          ? { ...savedQuote, currency: actualCurrency }
          : {
              price: book.initialPrice,
              changePct: 0,
              currency: actualCurrency,
              updatedAt: 0,
              delayed: true,
              source: "transaction_cost",
              fallbackPrice: true
            };
        const value = book.quantity * parseNumber(quote.price);
        const pnl = value - book.cost;
        return {
          ...book,
          currency: actualCurrency,
          price: parseNumber(quote.price),
          changePct: parseNumber(quote.changePct),
          value,
          pnl,
          pnlPct: book.cost > EPSILON ? pnl / book.cost * 100 : 0,
          avgCost: book.quantity > EPSILON ? book.cost / book.quantity : 0,
          quote
        };
      })
      .sort((a, b) => convert(b.value, b.currency) - convert(a.value, a.currency));

    const holdingsValue = holdings.reduce((sum, holding) => sum + convert(holding.value, holding.currency), 0);
    const rawCashValue = Object.entries(cash).reduce((sum, [currency, value]) => sum + convert(value, currency), 0);
    const cashInTotal = settings.includeCash === true ? rawCashValue : 0;
    const totalValue = holdingsValue + cashInTotal;
    const totalCost = holdings.reduce((sum, holding) => sum + convert(holding.cost, holding.currency), 0);
    const realizedPnlFromTx = Object.entries(realized).reduce((sum, [currency, value]) => sum + convert(value, currency), 0);
    const holdingsPnl = holdings.reduce((sum, holding) => sum + convert(holding.pnl, holding.currency), 0);
    const manualClosedPnl = (Array.isArray(source.closedPositions) ? source.closedPositions : [])
      .reduce((sum, position) => sum + convert(position?.profit || 0, position?.currency || "TRY"), 0);
    const totalClosedPnl = realizedPnlFromTx + manualClosedPnl;
    const dayChange = holdings.reduce((sum, holding) => {
      const previousValue = holding.changePct === -100
        ? holding.value
        : holding.value / (1 + holding.changePct / 100);
      return sum + convert(holding.value - previousValue, holding.currency);
    }, 0);
    const previousTotal = totalValue - dayChange;

    return {
      holdings,
      cash,
      holdingsValue,
      cashValue: rawCashValue,
      cashInTotal,
      totalValue,
      totalCost,
      pnl: holdingsPnl + realizedPnlFromTx,
      holdingsPnl,
      realizedPnlFromTx,
      manualClosedPnl,
      totalClosedPnl,
      potentialTotalPnl: holdingsPnl + totalClosedPnl,
      pnlPct: totalCost > EPSILON ? holdingsPnl / totalCost * 100 : 0,
      dayChange,
      dayChangePct: Math.abs(previousTotal) > EPSILON ? dayChange / previousTotal * 100 : 0,
      closedFromTransactions,
      integrityErrors
    };
  }

  function greetingForUser(user, now = new Date()) {
    const hour = now.getHours();
    const greeting = hour < 6 || hour >= 22 ? "İyi geceler"
      : hour < 12 ? "Günaydın" : hour < 18 ? "İyi günler" : "İyi akşamlar";
    const name = String(user?.username || user?.displayName || user?.name || "").trim().slice(0, 80);
    return name ? `${greeting}, ${name}` : greeting;
  }

  function selectPerformanceSnapshots(source, throughDate = localDateISO()) {
    const base = source.settings?.baseCurrency || "TRY";
    const demo = source.isDemo === true;
    const recordDates = [...(source.transactions || []).filter(tx => demo || !tx.demo).map(tx => tx.date),
      ...(source.closedPositions || []).filter(cp => demo || !cp.demo).map(cp => cp.buyDate || cp.sellDate)]
      .filter(isValidDate).sort();
    const firstDate = recordDates[0];
    const byDate = new Map();
    let excluded = 0;
    for (const snapshot of source.dailySnapshots || []) {
      const invalid = !snapshot || !isValidDate(snapshot.date) || snapshot.date > throughDate
        || snapshot.value === null || snapshot.value === "" || !Number.isFinite(Number(snapshot.value)) || Number(snapshot.value) < 0
        || snapshot.baseCurrency !== base || snapshot.includeCash === true
        || (!demo && (snapshot.isDemo === true || snapshot.demo === true || snapshot.source === "sample"))
        || !firstDate || snapshot.date < firstDate;
      if (invalid) { excluded += 1; continue; }
      const previous = byDate.get(snapshot.date);
      if (!previous || (Number(snapshot.capturedAt) || 0) >= (Number(previous.capturedAt) || 0)) {
        byDate.set(snapshot.date, { ...snapshot, value: Number(snapshot.value) });
      }
    }
    return { snapshots: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)), excluded };
  }

  function buildValueSeries(snapshots) {
    const first = snapshots.find(snapshot => Number.isFinite(snapshot.value));
    return snapshots.map((snapshot, index) => {
      const previous = snapshots[index - 1];
      const consecutive = previous && (!snapshot.date || !previous.date
        || Date.parse(snapshot.date) - Date.parse(previous.date) === 86400000);
      return {
        ...snapshot,
        returnPct: Number.isFinite(snapshot.value) && first?.value > 0 ? (snapshot.value / first.value - 1) * 100 : null,
        dailyChange: consecutive && Number.isFinite(snapshot.value) && Number.isFinite(previous?.value) ? snapshot.value - previous.value : null,
        dailyReturnPct: consecutive && Number.isFinite(snapshot.value) && previous?.value > 0 ? (snapshot.value / previous.value - 1) * 100 : null
      };
    });
  }

  function historicalClose(points, date) {
    let latest = null;
    const rows = Array.isArray(points) ? points : Array.isArray(points?.points) ? points.points : [];
    for (const point of rows) {
      const stamp = point.t !== null && point.t !== "" ? Number(point.t) : NaN;
      const timestampDate = new Date(stamp * 1000);
      const day = point.date || (Number.isFinite(timestampDate.getTime()) ? timestampDate.toISOString().slice(0, 10) : "");
      if (!isValidDate(day) || day > date || !Number.isFinite(Number(point.c)) || Number(point.c) <= 0) continue;
      if (!latest || day >= latest.date) latest = { date: day, c: Number(point.c) };
    }
    // Only carry the latest published close over a short market closure, never from the future.
    return latest && (Date.parse(date) - Date.parse(latest.date)) / 86400000 <= 7 ? latest : null;
  }

  function holdingsKey(holdings) {
    return JSON.stringify(holdings.map(holding => [holding.market, holding.symbol, holding.currency,
      Number(holding.quantity.toFixed(9))]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  }

  function ipoAllocationValue(holding, transactions, history, date) {
    // Missing candles alone do not prove an IPO has not started trading.
    // Only use the allocation price before the provider's actual listing date.
    const firstTradeDate = history?.firstTradeDate;
    if (!isValidDate(firstTradeDate) || date >= firstTradeDate) return null;
    const entries = transactions.filter(tx => tx.symbol === holding.symbol && tx.market === holding.market && ASSET_TYPES.has(tx.type));
    if (!entries.length || entries.some(tx => tx.type !== "IPO_BUY" || !(Number(tx.price) > 0))) return null;
    const quantity = entries.reduce((sum, tx) => sum + Number(tx.quantity), 0);
    if (Math.abs(quantity - holding.quantity) > EPSILON) return null;
    const value = entries.reduce((sum, tx) => sum + Number(tx.quantity) * Number(tx.price), 0);
    // Fees remain in cost; they are not a market asset or an unrealized gain.
    return { symbol: holding.symbol, quantity, price: value / quantity, value, currency: holding.currency, firstTradeDate };
  }

  function performanceCalendar(source, snapshots, histories = {}, options = {}) {
    if (!snapshots.length) return [];
    const ordered = snapshots.filter(snapshot => isValidDate(snapshot.date)).slice().sort((a, b) => a.date.localeCompare(b.date));
    if (!ordered.length) return [];
    const byDate = new Map(ordered.map(snapshot => [snapshot.date, snapshot]));
    const end = Date.parse(isValidDate(options.throughDate) ? options.throughDate : ordered.at(-1).date);
    const start = Math.max(Date.parse(ordered[0].date), isValidDate(options.fromDate) ? Date.parse(options.fromDate) : -Infinity);
    const result = [];
    for (let time = start; time <= end; time += 86400000) {
      const date = new Date(time).toISOString().slice(0, 10);
      const transactions = (source.transactions || []).filter(tx => isValidDate(tx.date) && tx.date <= date && (source.isDemo || !tx.demo));
      const settings = { ...source.settings, includeCash: false };
      const book = calculatePortfolio({ transactions, settings, prices: {} });
      const recorded = byDate.get(date);
      const positionMismatch = recorded?.holdingsKey !== undefined && recorded.holdingsKey !== holdingsKey(book.holdings);
      const recordedUnverified = Boolean(recorded && recorded.holdingsKey === undefined);
      if (recorded && (!recordedUnverified || source.isDemo) && !positionMismatch && !book.integrityErrors.length) {
        result.push({ ...recorded, valuationSource: "recorded", valuationVerified: recorded.holdingsKey !== undefined });
        continue;
      }
      const fx = historicalClose(histories["USDTRY=X"], date);
      const needsFx = book.holdings.some(holding => holding.currency !== settings.baseCurrency);
      let reason = book.integrityErrors.length ? "Bu tarihte işlem defteri tutarsız." : needsFx && !fx ? "Tarihi döviz kuru alınamadı." : "";
      const { convert } = baseConverter({ ...settings, fxUsdTry: fx?.c || 1 });
      let value = 0;
      const priceDates = [];
      const ipoValuations = [];
      for (const holding of book.holdings) {
        const quote = historicalClose(histories[holding.symbol], date);
        if (!quote) {
          const allocation = ipoAllocationValue(holding, transactions, histories[holding.symbol], date);
          if (allocation) {
            value += convert(allocation.value, holding.currency);
            ipoValuations.push(allocation);
            continue;
          }
          reason = `${holding.symbol} için tarihi kapanış alınamadı.`;
          break;
        }
        value += convert(holding.quantity * quote.c, holding.currency);
        priceDates.push(`${holding.symbol}: ${quote.date}`);
      }
      result.push({ date, value: reason ? null : Math.round(value * 100) / 100,
        baseCurrency: settings.baseCurrency, includeCash: false, fxUsdTry: fx?.c,
        valuationSource: reason ? "missing" : "historical-close", fxDate: fx?.date, priceDates, ipoValuations, reason,
        ...(recorded ? { recordedValue: recorded.value, positionMismatch, recordedUnverified } : {}) });
    }
    return result;
  }

  function snapshotProfit(snapshot, source, fxHistory = []) {
    if (!Number.isFinite(snapshot.value)) return { totalPnl: null, reason: snapshot.reason || "Bu günün portföy değeri yok." };
    if (snapshot.valuationSource === "recorded" && snapshot.valuationVerified === false && !source.isDemo) {
      return { totalPnl: null, reason: "Eski değer işlem dökümüyle doğrulanamıyor; tarihi fiyatlarla yeniden hesaplanmalı." };
    }
    // Rebuild cost and realized profit using only entries dated on/before this record.
    // Historical market value comes from the record, never from today's stock prices.
    const transactions = (source.transactions || []).filter(tx => isValidDate(tx.date)
      && tx.date <= snapshot.date && (source.isDemo === true || !tx.demo));
    const closedPositions = (source.closedPositions || []).filter(cp => isValidDate(cp.sellDate)
      && cp.sellDate <= snapshot.date && (source.isDemo === true || !cp.demo));
    const hasAssets = transactions.some(tx => ASSET_TYPES.has(tx.type)) || closedPositions.length > 0;
    if (!hasAssets) return { totalPnl: null, reason: "Bu tarihe ait maliyet kaydı yok." };
    const baseCurrency = snapshot.baseCurrency;
    const needsFx = transactions.some(tx => ASSET_TYPES.has(tx.type) && tx.currency !== baseCurrency)
      || closedPositions.some(cp => (cp.currency || "TRY") !== baseCurrency);
    const recordedFx = Number.isFinite(Number(snapshot.fxUsdTry)) && Number(snapshot.fxUsdTry) > 0 ? Number(snapshot.fxUsdTry) : null;
    const marketFx = needsFx && !recordedFx ? historicalClose(fxHistory, snapshot.date) : null;
    const fx = recordedFx || marketFx?.c;
    if (needsFx && !fx) {
      return { totalPnl: null, reason: "Bu günün döviz kuru kaydedilmemiş." };
    }
    const historical = calculatePortfolio({
      transactions, closedPositions, prices: {},
      settings: { baseCurrency, fxUsdTry: fx || 1, includeCash: false }
    });
    if (historical.integrityErrors.length) return { totalPnl: null, reason: "İşlem tarihlerinde tutarsızlık var." };
    if (snapshot.holdingsKey !== undefined && snapshot.holdingsKey !== holdingsKey(historical.holdings)) {
      return { totalPnl: null, reason: "Günlük kayıt, düzenlenen işlem adetleriyle eşleşmiyor; tarihi fiyatlarla yeniden hesaplanmalı." };
    }
    if (!historical.holdings.length && snapshot.value > EPSILON) {
      return { totalPnl: null, reason: "Kayıtlı değer, o tarihteki pozisyonlarla eşleşmiyor." };
    }
    const unrealizedPnl = snapshot.value - historical.totalCost;
    return { unrealizedPnl, realizedPnl: historical.totalClosedPnl,
      totalPnl: unrealizedPnl + historical.totalClosedPnl, reason: "",
      ...(marketFx ? { profitSource: "historical-fx", fxUsdTry: marketFx.c, fxDate: marketFx.date } : {}) };
  }

  function smoothTimelinePath(coords) {
    // Monotone cubic Hermite interpolation: passes through observations without overshoot.
    const segments = [];
    let segment = [];
    for (const point of [...coords, null]) {
      if (point) segment.push(point);
      else if (segment.length) { segments.push(segment); segment = []; }
    }
    const f = value => Number(value.toFixed(3));
    return segments.map(points => {
      let path = `M${f(points[0].x)},${f(points[0].y)}`;
      if (points.length < 2) return path;
      const slopes = points.slice(1).map((point, i) => (point.y - points[i].y) / (point.x - points[i].x));
      const tangents = points.map((point, i) => {
        if (i === 0) return slopes[0];
        if (i === points.length - 1) return slopes.at(-1);
        const a = slopes[i - 1], b = slopes[i];
        return a * b <= 0 ? 0 : 2 * a * b / (a + b);
      });
      slopes.forEach((slope, i) => {
        if (slope === 0) { tangents[i] = 0; tangents[i + 1] = 0; return; }
        const a = tangents[i] / slope, b = tangents[i + 1] / slope;
        const magnitude = Math.hypot(a, b);
        if (magnitude > 3) { tangents[i] *= 3 / magnitude; tangents[i + 1] *= 3 / magnitude; }
      });
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i], dx = (b.x - a.x) / 3;
        path += ` C${f(a.x + dx)},${f(a.y + tangents[i - 1] * dx)} ${f(b.x - dx)},${f(b.y - tangents[i] * dx)} ${f(b.x)},${f(b.y)}`;
      }
      return path;
    }).join(" ");
  }

  function timelineTickIndexes(points, plotWidth) {
    if (points.length <= 62) return points.map((_, index) => index);
    const count = Math.max(2, Math.floor(plotWidth / 80));
    const essential = new Set([0, points.length - 1]);
    if (points.length <= 370) points.forEach((point, index) => {
      const nextDay = new Date(Date.parse(point.date) + 86400000);
      if (nextDay.getUTCDate() === 1) essential.add(index);
    });
    for (let i = 0; i < count; i++) {
      const index = Math.round(i / (count - 1) * (points.length - 1));
      if ([...essential].every(other => Math.abs(index - other) * plotWidth / (points.length - 1) >= 60)) essential.add(index);
    }
    return [...essential].sort((a, b) => a - b);
  }

  function calculateRangePosition({ price, low, high } = {}) {
    const current = Number(price);
    const floor = Number(low);
    const ceiling = Number(high);
    if (![current, floor, ceiling].every(Number.isFinite) || ceiling <= floor) return null;
    return Math.min(100, Math.max(0, (current - floor) / (ceiling - floor) * 100));
  }

  function classifyTechnicalStage({ price, sma50, sma200 } = {}) {
    const current = Number(price);
    const medium = Number(sma50);
    const long = Number(sma200);
    if (![current, medium, long].every(Number.isFinite) || current <= 0 || medium <= 0 || long <= 0) {
      return { code: "insufficient", label: "Veri yetersiz", tone: "neutral" };
    }
    if (current > medium && medium > long) {
      return { code: "strong_uptrend", label: "Güçlü yükseliş", tone: "positive" };
    }
    if (current > long && medium >= long) {
      return { code: "uptrend", label: "Yükseliş", tone: "positive" };
    }
    if (current < medium && medium < long) {
      return { code: "downtrend", label: "Düşüş", tone: "negative" };
    }
    if (current < long) {
      return { code: "weak", label: "Zayıf görünüm", tone: "negative" };
    }
    return { code: "transition", label: "Geçiş / yatay", tone: "neutral" };
  }

  function analyzeTrendChannel(values, options = {}) {
    const source = Array.isArray(values) ? values : [];
    const lookback = Math.max(20, Math.min(120, Number(options.lookback) || 60));
    const minPoints = Math.max(10, Math.min(lookback, Number(options.minPoints) || 20));
    const valid = source
      .map((value, index) => ({ index, value: Number(value) }))
      .filter(point => Number.isFinite(point.value) && point.value > 0)
      .slice(-lookback);
    const emptySeries = new Array(source.length).fill(null);

    if (valid.length < minPoints) {
      return {
        code: "insufficient",
        direction: "insufficient",
        trendLabel: "Veri yetersiz",
        channelLabel: "Kanal için veri yetersiz",
        tone: "neutral",
        fit: 0,
        fitLabel: "Yetersiz",
        movePct: null,
        slopePctPerPoint: null,
        channelHalfWidthPct: null,
        position: "unknown",
        positionPct: null,
        latestLower: null,
        latestMiddle: null,
        latestUpper: null,
        lower: emptySeries.slice(),
        middle: emptySeries.slice(),
        upper: emptySeries.slice(),
        sampleSize: valid.length
      };
    }

    const logs = valid.map(point => Math.log(point.value));
    const n = logs.length;
    const meanX = (n - 1) / 2;
    const meanY = logs.reduce((sum, value) => sum + value, 0) / n;
    let covariance = 0;
    let varianceX = 0;
    for (let index = 0; index < n; index += 1) {
      covariance += (index - meanX) * (logs[index] - meanY);
      varianceX += (index - meanX) ** 2;
    }
    const slope = varianceX > 0 ? covariance / varianceX : 0;
    const intercept = meanY - slope * meanX;
    const fittedLogs = logs.map((_, index) => intercept + slope * index);
    const residuals = logs.map((value, index) => value - fittedLogs[index]);
    const squaredError = residuals.reduce((sum, value) => sum + value ** 2, 0);
    const totalVariance = logs.reduce((sum, value) => sum + (value - meanY) ** 2, 0);
    const fit = totalVariance > 1e-12 ? Math.max(0, Math.min(1, 1 - squaredError / totalVariance)) : 1;
    const residualDeviation = Math.sqrt(squaredError / n);
    const channelHalfWidth = Math.max(residualDeviation * 2, Math.log(1.005));
    const movePct = (Math.exp(slope * (n - 1)) - 1) * 100;
    const noisePct = (Math.exp(residualDeviation) - 1) * 100;
    const meaningfulMove = Math.max(1.5, noisePct * 0.75);
    let direction = "sideways";
    if (fit >= 0.15 && movePct >= meaningfulMove) direction = "up";
    if (fit >= 0.15 && movePct <= -meaningfulMove) direction = "down";

    const latestResidual = residuals.at(-1);
    const position = latestResidual > channelHalfWidth
      ? "above"
      : latestResidual < -channelHalfWidth
        ? "below"
        : "inside";
    const positionPct = channelHalfWidth > 0
      ? 50 + latestResidual / (channelHalfWidth * 2) * 100
      : 50;
    const channelQualified = direction !== "sideways" && fit >= 0.35;
    const trendLabel = direction === "up"
      ? "Yükseliş trendi"
      : direction === "down"
        ? "Düşüş trendi"
        : "Yatay / kararsız trend";
    const directionWord = direction === "up" ? "Yükseliş" : "Düşüş";
    let channelLabel = "Net bir fiyat kanalı oluşmamış";
    if (channelQualified && position === "inside") channelLabel = `${directionWord} kanalı içinde hareket ediyor`;
    if (channelQualified && position === "above") channelLabel = `${directionWord} kanalının üzerinde hareket ediyor`;
    if (channelQualified && position === "below") channelLabel = `${directionWord} kanalının altında hareket ediyor`;

    const lower = emptySeries.slice();
    const middle = emptySeries.slice();
    const upper = emptySeries.slice();
    valid.forEach((point, index) => {
      middle[point.index] = Math.exp(fittedLogs[index]);
      lower[point.index] = Math.exp(fittedLogs[index] - channelHalfWidth);
      upper[point.index] = Math.exp(fittedLogs[index] + channelHalfWidth);
    });
    const fitLabel = fit >= 0.65 ? "Güçlü" : fit >= 0.4 ? "Orta" : "Zayıf";
    const code = channelQualified && position === "inside"
      ? `${direction}_channel`
      : direction === "up"
        ? "uptrend"
        : direction === "down"
          ? "downtrend"
          : "sideways";

    return {
      code,
      direction,
      trendLabel,
      channelLabel,
      tone: direction === "up" ? "positive" : direction === "down" ? "negative" : "neutral",
      fit,
      fitLabel,
      movePct,
      slopePctPerPoint: (Math.exp(slope) - 1) * 100,
      channelHalfWidthPct: (Math.exp(channelHalfWidth) - 1) * 100,
      position,
      positionPct,
      latestLower: lower[valid.at(-1).index],
      latestMiddle: middle[valid.at(-1).index],
      latestUpper: upper[valid.at(-1).index],
      lower,
      middle,
      upper,
      sampleSize: n
    };
  }

  return {
    ASSET_TYPES,
    CASH_TYPES,
    TRANSACTION_TYPES,
    SYMBOL_PATTERN,
    auditTransactions,
    analyzeTrendChannel,
    brokerTransactionFinancials,
    aggregateClosedPositionsBySymbol,
    groupClosedPositionsForDisplay,
    calculateRangePosition,
    calculatePortfolio,
    greetingForUser,
    selectPerformanceSnapshots,
    buildValueSeries,
    snapshotProfit,
    historicalClose,
    holdingsKey,
    performanceCalendar,
    smoothTimelinePath,
    timelineTickIndexes,
    calculatePeriodReturn,
    classifyTechnicalStage,
    createId,
    cumulativeExternalFlow,
    isValidDate,
    localDateISO,
    normalizeMarket,
    normalizeSymbol,
    normalizeTransaction,
    parseNumber,
    reconcileSellQuantity,
    sortTransactions,
    validateTransaction
  };
});
