"use strict";

(function exposeExpenseCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ExpenseCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createExpenseCore() {
  const DATE_PATTERN = /(?:^|\s)(\d{1,2}[.\/-]\d{1,2}(?:[.\/-]\d{2,4})?|\d{4}-\d{1,2}-\d{1,2})(?=\s|$)/;
  const AMOUNT_PATTERN = /(?:^|\s)([-+]?\s*\d{1,3}(?:[.\s]\d{3})*,\d{2}-?|[-+]?\s*\d+[.,]\d{2}-?)(?:\s*(?:TL|TRY|₺))?(?=\s|$)/gi;
  const IGNORE_PATTERN = /hesap kesim|son odeme|asgari odeme|donem borcu|ekstre borcu|onceki donem|devreden bakiye|kart borcu odemesi|odeme\s*[-–]?\s*tesekkur|toplam harcama|toplam donem|faiz oran|kazanilan (?:puan|mil)|musteri numarasi|kart numarasi/i;

  function fold(value) {
    return String(value ?? "")
      .toLocaleLowerCase("tr-TR")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/ı/g, "i");
  }

  function normalizeDate(value, referenceDate = new Date()) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
    }
    const text = String(value ?? "").trim();
    if (!text) return "";
    let year;
    let month;
    let day;
    let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) {
      [, year, month, day] = match;
    } else {
      match = text.match(/^(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?$/);
      if (!match) return "";
      [, day, month, year] = match;
      if (!year) year = String(referenceDate.getFullYear());
      if (String(year).length === 2) year = String(Number(year) >= 70 ? 1900 + Number(year) : 2000 + Number(year));
    }
    const numericYear = Number(year);
    const numericMonth = Number(month);
    const numericDay = Number(day);
    const parsed = new Date(numericYear, numericMonth - 1, numericDay);
    if (parsed.getFullYear() !== numericYear || parsed.getMonth() !== numericMonth - 1 || parsed.getDate() !== numericDay) return "";
    return `${numericYear}-${String(numericMonth).padStart(2, "0")}-${String(numericDay).padStart(2, "0")}`;
  }

  function parseAmount(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
    let text = String(value ?? "").trim();
    if (!text) return NaN;
    const trailingMinus = /-$/.test(text);
    text = text.replace(/(?:TL|TRY|₺)/gi, "").replace(/\s+/g, "").replace(/-$/, "");
    let normalized;
    if (text.includes(",")) normalized = text.replace(/\./g, "").replace(",", ".");
    else if (/^[+-]?\d{1,3}(?:\.\d{3})+$/.test(text)) normalized = text.replace(/\./g, "");
    else normalized = text;
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) return NaN;
    return trailingMinus ? -Math.abs(parsed) : parsed;
  }

  function isInsideParentheses(line, index) {
    const prefix = line.slice(0, index);
    return prefix.lastIndexOf("(") > prefix.lastIndexOf(")");
  }

  function selectStatementAmount(line, matches) {
    const candidates = matches
      .map(match => ({ match, amount: parseAmount(match[1]) }))
      .filter(candidate => Number.isFinite(candidate.amount));
    const columnCandidates = candidates.filter(candidate => !isInsideParentheses(line, candidate.match.index));
    return columnCandidates.find(candidate => candidate.amount !== 0)
      || columnCandidates[0]
      || candidates.findLast(candidate => candidate.amount !== 0)
      || candidates.at(-1);
  }

  function cleanDescription(value) {
    return String(value ?? "")
      .replace(/^[-–—:;|\s]+|[-–—:;|\s]+$/g, "")
      .replace(/\b\d{1,2}[.\/-]\d{1,2}(?:[.\/-]\d{2,4})?\b/g, " ")
      .replace(/\b(?:taksit|tks)\s*\d+\s*[\/-]\s*\d+\b/gi, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function categoryFor(description) {
    const text = fold(description);
    if (/market|migros|carrefour|a101|bim|sok|şok|file market|gross|macrocenter/.test(text)) return "Market";
    if (/restoran|restaurant|cafe|kahve|yemek|burger|pizza|kebap|lokanta|starbucks|yemeksepeti|getir yemek|trendyol yemek/.test(text)) return "Yeme & içme";
    if (/benzin|petrol|akaryakit|shell|opet|bp |metro|iett|ulasim|otopark|taksi|uber|marti/.test(text)) return "Ulaşım";
    if (/elektrik|dogalgaz|su fatur|internet|telekom|turkcell|vodafone|superonline|fatura/.test(text)) return "Faturalar";
    if (/eczane|hastane|saglik|klinik|doktor|dis |diş |medikal/.test(text)) return "Sağlık";
    if (/netflix|spotify|youtube|sinema|tiyatro|oyun|steam|playstation|eglence/.test(text)) return "Eğlence";
    if (/amazon|trendyol|hepsiburada|n11|giyim|magaza|mağaza|teknosa|mediamarkt|apple\.com/.test(text)) return "Alışveriş";
    return "Diğer";
  }

  function shouldIgnore(description, line = "") {
    const joined = fold(`${description} ${line}`);
    return !description || description.length < 2 || IGNORE_PATTERN.test(joined);
  }

  function parseStatementLines(lines, options = {}) {
    const referenceDate = options.referenceDate instanceof Date ? options.referenceDate : new Date();
    const expenses = [];
    (Array.isArray(lines) ? lines : String(lines ?? "").split(/\r?\n/)).forEach(rawLine => {
      const line = String(rawLine ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
      if (!line) return;
      const dateMatch = line.match(DATE_PATTERN);
      if (!dateMatch) return;
      const date = normalizeDate(dateMatch[1], referenceDate);
      if (!date) return;
      const amountCandidate = selectStatementAmount(line, [...line.matchAll(AMOUNT_PATTERN)]);
      if (!amountCandidate) return;
      const { match: amountMatch, amount } = amountCandidate;
      if (!Number.isFinite(amount) || amount === 0) return;
      const descriptionStart = (dateMatch.index || 0) + dateMatch[0].length;
      const description = cleanDescription(line.slice(descriptionStart, amountMatch.index));
      if (shouldIgnore(description, line)) return;
      expenses.push({ date, description, amount, currency: "TRY", category: categoryFor(description) });
    });
    return expenses;
  }

  function headerIndex(headers, aliases) {
    const normalizedAliases = aliases.map(fold);
    for (const alias of normalizedAliases) {
      const exact = headers.findIndex(header => fold(header).trim() === alias);
      if (exact >= 0) return exact;
    }
    for (const alias of normalizedAliases) {
      const index = headers.findIndex(header => fold(header).includes(alias));
      if (index >= 0) return index;
    }
    return -1;
  }

  function parseRows(rows, options = {}) {
    if (!Array.isArray(rows) || !rows.length) return [];
    const headerRowIndex = rows.slice(0, 15).findIndex(row => {
      const cells = Array.isArray(row) ? row : [];
      return headerIndex(cells, ["tarih", "islem tarihi", "işlem tarihi"]) >= 0
        && headerIndex(cells, ["tutar", "harcama", "borc", "borç", "islem tutari", "işlem tutarı"]) >= 0;
    });
    if (headerRowIndex < 0) return parseStatementLines(rows.map(row => (Array.isArray(row) ? row.join(" ") : row)), options);
    const headers = rows[headerRowIndex];
    const dateColumn = headerIndex(headers, ["islem tarihi", "işlem tarihi", "tarih"]);
    const descriptionColumn = headerIndex(headers, ["isyeri", "işyeri", "aciklama", "açıklama", "islem", "işlem", "merchant"]);
    const amountColumn = headerIndex(headers, ["donem ici tl", "dönem içi tl", "islem tutari", "işlem tutarı", "harcama", "borc", "borç", "tutar"]);
    const currencyColumn = headerIndex(headers, ["para birimi", "doviz", "döviz", "currency"]);
    const categoryColumn = headerIndex(headers, ["kategori", "category"]);
    if (dateColumn < 0 || amountColumn < 0) return [];
    return rows.slice(headerRowIndex + 1).flatMap(row => {
      if (!Array.isArray(row)) return [];
      const date = normalizeDate(row[dateColumn], options.referenceDate);
      const amount = parseAmount(row[amountColumn]);
      const description = cleanDescription(descriptionColumn >= 0 ? row[descriptionColumn] : "Kart harcaması");
      if (!date || !Number.isFinite(amount) || amount === 0 || shouldIgnore(description)) return [];
      const rawCurrency = currencyColumn >= 0 ? String(row[currencyColumn] || "").toUpperCase() : "";
      return [{
        date,
        description,
        amount,
        currency: /USD|\$/.test(rawCurrency) ? "USD" : /EUR|€/.test(rawCurrency) ? "EUR" : "TRY",
        category: cleanDescription(categoryColumn >= 0 ? row[categoryColumn] : "") || categoryFor(description)
      }];
    });
  }

  function detectDelimiter(text) {
    const sample = String(text ?? "").split(/\r?\n/).find(line => line.trim()) || "";
    return [";", "\t", ","].sort((a, b) => sample.split(b).length - sample.split(a).length)[0];
  }

  function parseDelimited(text) {
    const delimiter = detectDelimiter(text);
    const rows = [];
    let row = [], cell = "", quoted = false;
    const source = String(text ?? "").replace(/^\uFEFF/, "");
    for (let index = 0; index < source.length; index++) {
      const character = source[index];
      if (character === '"' && quoted && source[index + 1] === '"') { cell += '"'; index++; }
      else if (character === '"') quoted = !quoted;
      else if (character === delimiter && !quoted) { row.push(cell.trim()); cell = ""; }
      else if ((character === "\n" || character === "\r") && !quoted) {
        if (character === "\r" && source[index + 1] === "\n") index++;
        row.push(cell.trim());
        if (row.some(Boolean)) rows.push(row);
        row = []; cell = "";
      } else cell += character;
    }
    if (quoted) throw new Error("CSV dosyasında kapanmamış tırnak var; dosyayı kontrol edin.");
    row.push(cell.trim());
    if (row.some(Boolean)) rows.push(row);
    return rows;
  }

  function amountInTry(expense, settings = {}) {
    const amount = Number(expense?.amount);
    if (!Number.isFinite(amount)) return NaN;
    const currency = expense?.currency || "TRY";
    if (currency === "TRY") return amount;
    const rate = currency === "USD" ? Number(settings.fxUsdTry) : currency === "EUR" ? Number(settings.fxEurTry) : NaN;
    return Number.isFinite(rate) && rate > 0 ? amount * rate : NaN;
  }

  function fingerprint(expense, occurrence = 1) {
    const base = [expense?.date, fold(expense?.description).replace(/[^a-z0-9]+/g, ""), Number(expense?.amount).toFixed(2), expense?.currency || "TRY"].join("|");
    const sequence = Number(occurrence);
    return Number.isInteger(sequence) && sequence > 1 ? `${base}#${sequence}` : base;
  }

  return { amountInTry, normalizeDate, parseAmount, cleanDescription, categoryFor, parseStatementLines, parseRows, parseDelimited, fingerprint };
});
