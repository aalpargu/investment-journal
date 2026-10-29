type JsonObject = { [key: string]: unknown };

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/';
const MODEL_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;
const SYMBOL_PATTERN = /^[A-Z0-9.^=-]{1,24}$/;
const FUND_SYMBOLS_BY_EXACT_NAME = new Map([
  ['tera portföy para piyasası fonu', 'TP2'],
  ['tera portföy para piyasası (tl) fonu', 'TP2'],
]);

export class FundCodeRequiredError extends Error {
  constructor() {
    super('Fon kodu görselde bulunamadı. Fotoğrafı "kod: FONKODU" açıklamasıyla yeniden gönderin.');
    this.name = 'FundCodeRequiredError';
  }
}

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function scalarText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}`;
  if (typeof value === 'bigint') return `${value}`;
  return '';
}

export async function geminiRequest(path: string, apiKey: string, payload?: JsonObject): Promise<JsonObject> {
  const response = await fetch(`${GEMINI_BASE_URL}${path}`, {
    method: payload ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(payload ? 55_000 : 20_000),
  });
  const data = object(await response.json().catch(() => ({})));
  if (!response.ok) {
    const message = scalarText(object(data.error).message) || `Gemini isteği başarısız oldu (HTTP ${response.status}).`;
    throw new Error(`Gemini: ${message}`);
  }
  return data;
}

export function validateGeminiModel(value: unknown): string | null {
  const model = scalarText(value).replace(/^models\//, '').trim();
  return MODEL_PATTERN.test(model) ? model : null;
}

function responseText(data: JsonObject): string {
  const candidate = Array.isArray(data.candidates) ? object(data.candidates[0]) : {};
  const content = object(candidate.content);
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const text = parts.map(part => scalarText(object(part).text)).join('').trim();
  if (!text) throw new Error(`Gemini metin döndürmedi (${scalarText(candidate.finishReason) || 'bilinmeyen neden'}).`);
  return text;
}

function positiveNumber(value: unknown): number | null {
  if (typeof value === 'boolean' || value === null || value === undefined) return null;
  let cleaned = scalarText(value).trim().replace(/[₺$\s]/g, '');
  if (cleaned.includes(',') && cleaned.includes('.')) cleaned = cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.') ? cleaned.replaceAll('.', '').replace(',', '.') : cleaned.replaceAll(',', '');
  else if (cleaned.includes(',')) cleaned = cleaned.replace(',', '.');
  const number = Number(cleaned);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function transactionNumber(value: unknown, market: string, field: string): number | null {
  if ((market === 'BIST' || market === 'FON') && field === 'quantity' && typeof value === 'string') {
    const cleaned = value.trim().replace(/[₺$\s]/g, '');
    if (!cleaned.includes(',') && /^\d{1,3}(?:\.\d{3})+$/.test(cleaned)) {
      return positiveNumber(cleaned.replaceAll('.', ''));
    }
  }
  return positiveNumber(value);
}

function transactionDate(value: unknown): string | null {
  const text = scalarText(value).trim();
  const validDate = (year: number, month: number, day: number): string | null => {
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
      ? date.toISOString().slice(0, 10) : null;
  };
  let match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (match) return validDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/.exec(text);
  if (match) return validDate(Number(match[3]), Number(match[2]), Number(match[1]));
  const turkish = /^(\d{1,2})\s+(ocak|şubat|mart|nisan|mayıs|haziran|temmuz|ağustos|eylül|ekim|kasım|aralık)\s+(\d{4})(?:\s|,|$)/iu
    .exec(text.toLocaleLowerCase('tr-TR'));
  if (!turkish) return null;
  const months = ['ocak', 'şubat', 'mart', 'nisan', 'mayıs', 'haziran', 'temmuz', 'ağustos', 'eylül', 'ekim', 'kasım', 'aralık'];
  return validDate(Number(turkish[3]), months.indexOf(turkish[2]) + 1, Number(turkish[1]));
}

function knownFundSymbol(name: string): string {
  return FUND_SYMBOLS_BY_EXACT_NAME.get(name.trim().normalize('NFC').replace(/\s+/g, ' ').toLocaleLowerCase('tr-TR')) || '';
}

function isFund(name: string, market: string): boolean {
  return market === 'FON' || market === 'TEFAS' || /(?:^|\s)fon(?:u)?(?=$|\s)/i.test(name);
}

function captionSymbol(caption: string): string {
  const patterns = [
    /(?:^|\s)(?:kod|hisse\s*kodu|ticker|sembol)\s*[:=-]\s*\$?([A-Za-z][A-Za-z0-9.-]{1,23})(?=$|[\s,.;])/i,
    /[#$]([A-Za-z][A-Za-z0-9.-]{1,23})(?=$|[\s,.;])/i,
    /^\s*([A-Za-z][A-Za-z0-9.-]{1,23})\s*$/i,
  ];
  for (const pattern of patterns) {
    const symbol = pattern.exec(caption)?.[1]?.toUpperCase().replace(/\.IS$/, '') || '';
    if (SYMBOL_PATTERN.test(symbol)) return symbol;
  }
  return '';
}

function provisionalIpoSymbol(name: string): string {
  const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'BEKLIYOR';
  return `IPO-${slug.slice(0, 18)}`;
}

export function normalizeTransaction(value: unknown, symbolOverride = ''): JsonObject | null {
  const item = object(value);
  const name = scalarText(item.name).trim();
  const marketValue = scalarText(item.market).trim().toUpperCase();
  const fund = isFund(name, marketValue);
  let symbol = (symbolOverride || knownFundSymbol(name) || scalarText(item.symbol)).trim().toUpperCase().replace(/\.IS$/, '').replace(/\s+/g, '');
  const typeValue = scalarText(item.type).trim().toUpperCase();
  const operation = ({ BUY: 'BUY', ALIS: 'BUY', 'ALIŞ': 'BUY', 'FON ALIŞ': 'BUY', 'FON ALIŞI': 'BUY', 'FON ALIMI': 'BUY', SELL: 'SELL', SATIS: 'SELL', 'SATIŞ': 'SELL', 'FON SATIŞ': 'SELL', 'FON SATIŞI': 'SELL', 'FON SATIMI': 'SELL', IPO: 'IPO_BUY', IPO_BUY: 'IPO_BUY', 'HALKA ARZ': 'IPO_BUY', 'HALKA ARZ ALIMI': 'IPO_BUY' } as Record<string, string>)[typeValue];
  if (!operation) return null;
  const tickerPending = operation === 'IPO_BUY' && !symbolOverride && (item.tickerPending === true || !symbol);
  if (tickerPending) {
    if (!name) return null;
    symbol = provisionalIpoSymbol(name);
  } else if (!SYMBOL_PATTERN.test(symbol)) return null;
  let market = fund ? 'FON' : ['BIST', 'BORSA ISTANBUL', 'BORSAİSTANBUL'].includes(marketValue) ? 'BIST' : 'ABD';
  if (operation === 'IPO_BUY') market = 'BIST';
  else if (!fund && !['BIST', 'BORSA ISTANBUL', 'BORSAİSTANBUL', 'ABD', 'US', 'USA', 'NASDAQ', 'NYSE'].includes(marketValue)) return null;
  const quantity = transactionNumber(item.quantity, market, 'quantity');
  const quotedPrice = transactionNumber(item.price, market, 'price');
  const date = transactionDate(item.date);
  if (quantity === null || quotedPrice === null || !date) return null;
  const fee = transactionNumber(item.fee, market, 'fee') || 0;
  const reportedTotal = transactionNumber(item.total, market, 'total');
  let price = quotedPrice;
  let total = quantity * price + (operation === 'SELL' ? -fee : fee);
  if (reportedTotal !== null) {
    const quotedTotal = quantity * quotedPrice + (operation === 'SELL' ? -fee : fee);
    const roundingTolerance = Math.max(0.02, quantity * 0.005 + 0.01);
    if (Math.abs(quotedTotal - reportedTotal) <= roundingTolerance) {
      const grossTotal = reportedTotal + (operation === 'SELL' ? fee : -fee);
      if (grossTotal > 0) {
        price = grossTotal / quantity;
        total = reportedTotal;
      }
    }
  }
  const currencyValue = scalarText(item.currency).trim().toUpperCase();
  const currency = ['TRY', 'TL', '₺'].includes(currencyValue) || market === 'BIST' || market === 'FON' ? 'TRY' : 'USD';
  return { symbol, market, type: operation, quantity, price, quotedPrice, fee, total, date, currency, name: (name || symbol).slice(0, 120), tickerPending };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function completedFundWithoutCode(value: unknown, symbolOverride: string): boolean {
  const item = object(value);
  const name = scalarText(item.name).trim();
  const market = scalarText(item.market).trim().toUpperCase();
  if (!isFund(name, market) || symbolOverride || knownFundSymbol(name) || scalarText(item.symbol).trim()) return false;
  return normalizeTransaction(item, 'FONKODU') !== null;
}

const TRANSACTION_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    transactions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          symbol: { type: 'STRING' }, market: { type: 'STRING' }, type: { type: 'STRING' },
          quantity: { type: 'STRING' }, price: { type: 'STRING' }, date: { type: 'STRING' },
          fee: { type: 'STRING' }, total: { type: 'STRING' },
          currency: { type: 'STRING' }, name: { type: 'STRING' }, tickerPending: { type: 'BOOLEAN' },
        },
      },
    },
  },
  required: ['transactions'],
};

export async function extractTransactionsFromImage(
  image: Uint8Array,
  mimeType: string,
  apiKey: string,
  caption = '',
): Promise<{ transactions: JsonObject[]; model: string }> {
  const suppliedSymbol = captionSymbol(caption);
  const prompt = `Bu görseldeki gerçekleşmiş hisse senedi ve yatırım fonu işlemlerini çıkar.

Yalnızca görselde açıkça görülen tamamlanmış alış/satış kayıtlarını ekle. Tahmin yapma.
Bir işlem için işlem yönü (BUY/SELL), adet ve birim fiyat görünmüyorsa o işlemi ekleme. Hisse senedi için sembol ve piyasa (BIST veya ABD) da görünmeli.
Yatırım fonlarında "Fon alış" BUY, "Fon satış" SELL'dir. Fonun piyasa alanını FON yaz; TEFAS ekranları da FON'dur. Fon adı görünüyorsa kodu görünmese bile işlemi ekle, name alanına ekrandaki tam fon adını yaz ve symbol alanını boş bırak. Görselde veya Telegram açıklamasında olmayan fon kodunu tahmin etme.
quantity, price, fee ve total alanlarını SAYIYA ÇEVİRMEDEN, ekranda yazan nokta ve virgüllerle birlikte metin olarak aynen aktar. Türkçe ekranda nokta binlik, virgül ondalık ayracıdır: "1.346" bin üç yüz kırk altı adet; "2,209513" iki virgül iki sıfır dokuz beş bir üç TL; "2.974,004498" iki bin dokuz yüz yetmiş dört TL'dir.
Toplam tutar ve adet görünüyorsa birim fiyatı hesaplayabilirsin.
fee alanına görseldeki İşlem ücreti veya komisyonu yaz; görünmüyorsa 0 yaz.
total alanına görseldeki Toplam satırını aynen yaz. Satışta bu değer işlem ücreti düşülmüş net gelir, alışta işlem ücreti eklenmiş toplam ödemedir; brüt adet × fiyat değildir.
date alanını mutlaka YYYY-MM-DD biçiminde yaz. Midas Emir detayları ekranında Gerçekleşme tarihi satırını kullan; Emir tarihi veya bugünün tarihini kullanma.
Emir tipi Halka arz ise type alanına IPO_BUY, market alanına BIST yaz. BIST kodu yoksa symbol alanını boş bırak ve tickerPending alanını true yap; kod uydurma.
Telegram açıklamasındaki kullanıcı hisse kodu: ${suppliedSymbol || 'YOK'}. Bu kod varsa tek işlem için aynen kullan.
Hiç uygun işlem yoksa transactions alanına boş dizi koy.`;
  const request = {
    contents: [{ parts: [{ inlineData: { mimeType, data: bytesToBase64(image) } }, { text: prompt }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 2048, responseMimeType: 'application/json', responseSchema: TRANSACTION_RESPONSE_SCHEMA },
  };
  let lastError: unknown = null;
  let fundCodeError: FundCodeRequiredError | null = null;
  for (const model of ['gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-3.1-flash-lite']) {
    try {
      const data = await geminiRequest(`models/${model}:generateContent`, apiKey, request);
      const parsed = JSON.parse(responseText(data)) as unknown;
      const values = Array.isArray(object(parsed).transactions) ? object(parsed).transactions as unknown[] : null;
      if (!values) throw new Error('Gemini yanıtında işlem listesi bulunamadı.');
      const override = values.length === 1 ? suppliedSymbol : '';
      let transactions = values.map(value => normalizeTransaction(value, override)).filter((value): value is JsonObject => Boolean(value));
      if (suppliedSymbol && transactions.length) transactions = transactions.map(transaction => ({ ...transaction, symbol: suppliedSymbol, tickerPending: false }));
      if (values.length && !transactions.length) {
        if (values.some(value => completedFundWithoutCode(value, override))) throw new FundCodeRequiredError();
        throw new Error('Gemini öğe buldu ancak hiçbiri portföy doğrulamasını geçemedi.');
      }
      return { transactions, model };
    } catch (error) {
      if (error instanceof FundCodeRequiredError) fundCodeError = error;
      lastError = error;
    }
  }
  if (fundCodeError) throw fundCodeError;
  throw lastError instanceof Error ? lastError : new Error('Görsel analizi için kullanılabilir Gemini modeli bulunamadı.');
}
