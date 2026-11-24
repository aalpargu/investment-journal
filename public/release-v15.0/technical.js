/* Yatırım Defterim — Teknik analiz modülü
 *
 * Tek bir analiz motoru (analyzeTechnicals) tüm ekranı besler: karar şeridi,
 * grafik, seviyeler, risk planı ve AI istemi aynı sayılardan üretilir.
 * Göstergeler her zaman 2 yıllık GÜNLÜK veriden hesaplanır; seçilen aralık
 * yalnızca grafikte görünen pencereyi değiştirir (SMA200 her aralıkta geçerlidir).
 */
(function () {
  "use strict";

  const UI_KEY = "yatirim-defterim-v1:ta-ui";
  const RANGES = [["1mo", "1A", 22], ["3mo", "3A", 66], ["6mo", "6A", 130], ["1y", "1Y", 252], ["2y", "2Y", 9999]];
  const ui = Object.assign({ range: "6mo", style: "candle", sma20: true, sma50: true, sma200: true, bb: false, levels: true }, readUi());

  function readUi() { try { return JSON.parse(localStorage.getItem(UI_KEY) || "{}") || {}; } catch { return {}; } }
  function saveUi() { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch { /* tercih saklanamazsa varsayılan kullanılır */ } }

  const dateFmt = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short", year: "numeric" });
  const monthFmt = new Intl.DateTimeFormat("tr-TR", { month: "short" });
  const fin = Number.isFinite;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const pctDiff = (a, b) => (fin(a) && fin(b) && b !== 0 ? ((a - b) / b) * 100 : null);

  // Piyasa kapalıyken son fiyattan üretilen düz, hacimsiz çubuk gerçek bir seans değildir;
  // önceki kapanışla aynıysa göstergeleri ve günlük değişimi bozmaması için analize alınmaz.
  function prepareDailyPoints(points) {
    const tail = points.at(-1), prev = points.at(-2);
    const synthetic = tail && prev && !tail.v && tail.o === tail.c && tail.h === tail.l && Math.abs(tail.c - prev.c) < prev.c * 1e-6;
    return synthetic ? points.slice(0, -1) : points;
  }

  // ───────────────────────── Gösterge yardımcıları ─────────────────────────
  function bollinger(closes, period = 20, k = 2) {
    const mid = simpleMovingAverage(closes, period);
    const upper = [], lower = [];
    for (let i = 0; i < closes.length; i++) {
      if (!fin(mid[i])) { upper.push(null); lower.push(null); continue; }
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += (closes[j] - mid[i]) ** 2;
      const sd = Math.sqrt(s / period);
      upper.push(mid[i] + k * sd); lower.push(mid[i] - k * sd);
    }
    return { mid, upper, lower };
  }

  function adxSeries(h, l, c, p = 14) {
    const n = c.length, out = new Array(n).fill(null);
    if (n < p * 2 + 1) return out;
    let trS = 0, plusS = 0, minusS = 0, count = 0;
    for (let i = 1; i < n; i++) {
      const up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
      const plusDm = up > dn && up > 0 ? up : 0, minusDm = dn > up && dn > 0 ? dn : 0;
      const tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
      if (i <= p) { trS += tr; plusS += plusDm; minusS += minusDm; if (i < p) continue; }
      else { trS = trS - trS / p + tr; plusS = plusS - plusS / p + plusDm; minusS = minusS - minusS / p + minusDm; }
      const plusDi = trS ? (100 * plusS) / trS : 0, minusDi = trS ? (100 * minusS) / trS : 0;
      const dx = plusDi + minusDi ? (100 * Math.abs(plusDi - minusDi)) / (plusDi + minusDi) : 0;
      count++;
      if (count < p) out[i] = null, out._sum = (out._sum || 0) + dx;
      else if (count === p) out[i] = ((out._sum || 0) + dx) / p;
      else out[i] = (out[i - 1] * (p - 1) + dx) / p;
    }
    delete out._sum;
    return out;
  }

  function crossIndex(a, b, maxAge) {
    // Son `maxAge` çubuk içinde a'nın b'yi kestiği en yeni noktayı döndürür.
    const n = a.length;
    for (let i = n - 1; i >= Math.max(1, n - maxAge); i--) {
      if (![a[i], b[i], a[i - 1], b[i - 1]].every(fin)) continue;
      const now = a[i] - b[i], before = a[i - 1] - b[i - 1];
      if (before <= 0 && now > 0) return { i, dir: "up" };
      if (before >= 0 && now < 0) return { i, dir: "down" };
    }
    return null;
  }

  function findLevels(h, l, c, atr) {
    const n = c.length, k = 4, from = Math.max(k, n - 260), price = c[n - 1];
    const pivots = [];
    for (let i = from; i < n - k; i++) {
      let isHigh = true, isLow = true;
      for (let j = i - k; j <= i + k; j++) {
        if (h[j] > h[i]) isHigh = false;
        if (l[j] < l[i]) isLow = false;
      }
      if (isHigh) pivots.push({ price: h[i], i });
      if (isLow) pivots.push({ price: l[i], i });
    }
    pivots.sort((a, b) => a.price - b.price);
    const tol = Math.max(atr * 0.6, price * 0.008);
    const clusters = [];
    pivots.forEach(p => {
      const last = clusters.at(-1);
      if (last && p.price - last.sum / last.touches <= tol) { last.sum += p.price; last.touches++; last.lastIndex = Math.max(last.lastIndex, p.i); }
      else clusters.push({ sum: p.price, touches: 1, lastIndex: p.i });
    });
    const levels = clusters.map(cl => {
      const age = n - 1 - cl.lastIndex;
      return { price: cl.sum / cl.touches, touches: cl.touches, lastIndex: cl.lastIndex, strength: cl.touches * 2 + (age <= 60 ? 1.5 : age <= 120 ? 0.75 : 0) };
    });
    const margin = atr * 0.25;
    const supports = levels.filter(x => x.price < price - margin).sort((a, b) => b.price - a.price).slice(0, 3);
    const resistances = levels.filter(x => x.price > price + margin).sort((a, b) => a.price - b.price).slice(0, 3);
    return { supports, resistances };
  }

  // ───────────────────────────── Analiz motoru ─────────────────────────────
  function analyzeTechnicals(points) {
    const n = points.length;
    const o = points.map(p => Number(p.o)), h = points.map(p => Number(p.h)), l = points.map(p => Number(p.l));
    const c = points.map(p => Number(p.c)), v = points.map(p => Number(p.v) || 0);
    const last = n - 1, price = c[last];
    const sma20 = simpleMovingAverage(c, 20), sma50 = simpleMovingAverage(c, 50), sma200 = simpleMovingAverage(c, 200);
    const ema12 = exponentialMovingAverage(c, 12), ema26 = exponentialMovingAverage(c, 26);
    const macd = c.map((_, i) => (fin(ema12[i]) && fin(ema26[i]) ? ema12[i] - ema26[i] : null));
    const signal = exponentialMovingAverage(macd, 9);
    const hist = macd.map((m, i) => (fin(m) && fin(signal[i]) ? m - signal[i] : null));
    const rsi = calculateRsi(c, 14);
    const bb = bollinger(c);
    const adx = adxSeries(h, l, c);
    const atr = calcATR(h, l, c, 14) || (price * 0.02);
    const atrPct = (atr / price) * 100;
    const at = (arr, back = 0) => (fin(arr[last - back]) ? arr[last - back] : null);
    const ret = bars => (last - bars >= 0 ? pctDiff(price, c[last - bars]) : null);

    const year = Math.max(0, n - 252);
    const high52 = Math.max(...h.slice(year)), low52 = Math.min(...l.slice(year));
    const rangePos = high52 > low52 ? ((price - low52) / (high52 - low52)) * 100 : null;

    // Trend
    const t = { s20: at(sma20), s50: at(sma50), s200: at(sma200), adx: at(adx) };
    const trendParts = [
      [fin(t.s200) ? (price > t.s200 ? 1 : -1) : null, 25],
      [fin(t.s50) && fin(t.s200) ? (t.s50 > t.s200 ? 1 : -1) : null, 20],
      [fin(t.s50) ? (price > t.s50 ? 1 : -1) : null, 20],
      [fin(t.s20) ? (price > t.s20 ? 1 : -1) : null, 15],
      [fin(t.s20) && fin(at(sma20, 5)) ? Math.sign(t.s20 - at(sma20, 5)) : null, 10],
      [fin(t.s50) && fin(at(sma50, 10)) ? Math.sign(t.s50 - at(sma50, 10)) : null, 10],
    ].filter(([sign]) => sign !== null);
    const trendWeight = trendParts.reduce((s, [, w]) => s + w, 0);
    let trendScore = trendWeight ? (trendParts.reduce((s, [sign, w]) => s + sign * w, 0) / trendWeight) * 100 : 0;
    const ranging = fin(t.adx) && t.adx < 18;
    if (ranging) trendScore *= 0.6;

    // Momentum
    const r = at(rsi), hNow = at(hist), hPrev = at(hist, 3), roc20 = ret(20);
    let momentumScore = 0;
    if (fin(r)) momentumScore += clamp((r - 50) * 2, -40, 40) + (r > 75 ? -10 : r < 25 ? 10 : 0);
    if (fin(hNow)) momentumScore += hNow > 0 ? 25 : -25;
    if (fin(hNow) && fin(hPrev)) momentumScore += hNow > hPrev ? 15 : -15;
    if (fin(roc20)) momentumScore += roc20 > 0 ? 20 : -20;
    momentumScore = clamp(momentumScore, -100, 100);

    // Hacim
    const hasVolume = v.slice(-50).filter(x => x > 0).length >= 20;
    let volumeScore = null, volumeRatio = null, upShare = null;
    if (hasVolume) {
      let upVol = 0, downVol = 0;
      for (let i = Math.max(1, n - 20); i < n; i++) (c[i] >= c[i - 1] ? (upVol += v[i]) : (downVol += v[i]));
      upShare = upVol + downVol ? upVol / (upVol + downVol) : 0.5;
      const avg = (arr) => arr.reduce((s, x) => s + x, 0) / Math.max(arr.length, 1);
      const avg50 = avg(v.slice(-50)), avg5 = avg(v.slice(-5));
      volumeRatio = avg50 ? avg5 / avg50 : null;
      volumeScore = clamp((upShare - 0.5) * 200, -60, 60);
      const r5 = ret(5);
      if (fin(volumeRatio) && volumeRatio > 1.2 && fin(r5)) volumeScore += r5 > 0 ? 40 : -40;
      volumeScore = clamp(volumeScore, -100, 100);
    }

    const total = volumeScore === null
      ? trendScore * 0.62 + momentumScore * 0.38
      : trendScore * 0.5 + momentumScore * 0.3 + volumeScore * 0.2;
    const verdict = total >= 60 ? { label: "Güçlü yükseliş", tone: "positive" }
      : total >= 20 ? { label: "Yükseliş eğilimi", tone: "positive" }
      : total > -20 ? { label: "Yatay / kararsız", tone: "neutral" }
      : total > -60 ? { label: "Düşüş eğilimi", tone: "negative" }
      : { label: "Güçlü düşüş", tone: "negative" };

    // Seviyeler ve risk planı
    const { supports, resistances } = findLevels(h, l, c, atr);
    const inRange = (val, lo, hi) => fin(val) && val >= lo && val <= hi;
    const structure1 = supports[0] ? supports[0].price - 0.5 * atr : null;
    const balancedStructural = inRange(structure1, price - 3.2 * atr, price - 2 * atr);
    const balanced = balancedStructural ? structure1 : price - 2.5 * atr;
    const wideAnchor = supports.find(s => s.price - 0.5 * atr < balanced - 0.5 * atr)?.price ?? (fin(t.s50) && t.s50 < price ? t.s50 : null);
    const structure2 = fin(wideAnchor) ? wideAnchor - 0.5 * atr : null;
    const wideStructural = inRange(structure2, price - 6 * atr, price - 3.8 * atr);
    const wide = wideStructural ? structure2 : price - 4.5 * atr;
    const stops = [
      { key: "tight", title: "Sıkı", price: price - 1.5 * atr, basis: "1,5 × ATR — kısa vadeli işlem" },
      { key: "balanced", title: "Dengeli", price: balanced, basis: balancedStructural ? "İlk desteğin yarım ATR altı" : "2,5 × ATR — olağan dalgalanmanın dışı" },
      { key: "wide", title: "Geniş", price: wide, basis: wideStructural ? "Daha derindeki desteğin altı" : "4,5 × ATR — trend takibi" },
    ].map(s => ({ ...s, price: Math.max(s.price, price * 0.05), riskPct: ((price - Math.max(s.price, price * 0.05)) / price) * 100 }));
    const target = resistances[0]?.price ?? null;
    const riskReward = fin(target) ? (target - price) / (price - stops[1].price) : null;

    // Son sinyaller
    const signals = [];
    const push = (i, tone, text) => signals.push({ i, tone, text, age: last - i });
    const longCross = crossIndex(sma50, sma200, 30);
    if (longCross) push(longCross.i, longCross.dir === "up" ? "positive" : "negative", longCross.dir === "up" ? "SMA50, SMA200'ü yukarı kesti (altın kesişim)" : "SMA50, SMA200'ü aşağı kesti (ölüm kesişimi)");
    const shortCross = crossIndex(sma20, sma50, 15);
    if (shortCross) push(shortCross.i, shortCross.dir === "up" ? "positive" : "negative", `SMA20, SMA50'yi ${shortCross.dir === "up" ? "yukarı" : "aşağı"} kesti`);
    const macdCross = crossIndex(macd, signal, 10);
    if (macdCross) push(macdCross.i, macdCross.dir === "up" ? "positive" : "negative", `MACD sinyal çizgisini ${macdCross.dir === "up" ? "yukarı" : "aşağı"} kesti`);
    for (let i = last; i > Math.max(1, last - 10); i--) {
      if (!fin(rsi[i]) || !fin(rsi[i - 1])) continue;
      if (rsi[i - 1] >= 70 && rsi[i] < 70) { push(i, "negative", "RSI aşırı alım bölgesinden çıktı"); break; }
      if (rsi[i - 1] <= 30 && rsi[i] > 30) { push(i, "positive", "RSI aşırı satım bölgesinden çıktı"); break; }
    }
    for (let i = last; i > Math.max(252, last - 5); i--) {
      if (c[i] >= Math.max(...c.slice(i - 252, i))) { push(i, "positive", "52 haftanın en yüksek kapanışı"); break; }
    }
    if (hasVolume) {
      for (let i = last; i > Math.max(50, last - 5); i--) {
        const base = v.slice(i - 50, i).reduce((s, x) => s + x, 0) / 50;
        if (base && v[i] > base * 2) { push(i, c[i] >= c[i - 1] ? "positive" : "negative", `Ortalamanın ${formatNumber(v[i] / base, 1)} katı hacimle ${c[i] >= c[i - 1] ? "yükseliş" : "düşüş"}`); break; }
      }
    }
    signals.sort((a, b) => b.i - a.i);

    // Okunabilir gerekçeler
    const pros = [], cons = [];
    if (fin(t.s200)) (price > t.s200 ? pros : cons).push(`Fiyat 200 günlük ortalamanın ${price > t.s200 ? "üzerinde" : "altında"} — ana trend ${price > t.s200 ? "yukarı" : "aşağı"}`);
    if (fin(t.s50) && fin(t.s200)) (t.s50 > t.s200 ? pros : cons).push(`SMA50, SMA200'ün ${t.s50 > t.s200 ? "üzerinde" : "altında"}`);
    if (fin(t.s20) && fin(t.s50)) (price > t.s20 && t.s20 > t.s50 ? pros : price < t.s20 && t.s20 < t.s50 ? cons : []).push(price > t.s20 ? "Kısa vadeli ortalamalar yukarı dizili" : "Kısa vadeli ortalamalar aşağı dizili");
    if (ranging) cons.push(`ADX ${formatNumber(t.adx, 0)} — belirgin bir trend yok, yatay piyasa`);
    else if (fin(t.adx) && t.adx >= 25) (trendScore > 0 ? pros : cons).push(`ADX ${formatNumber(t.adx, 0)} — ${trendScore > 0 ? "yükseliş" : "düşüş"} trendi güçlü`);
    if (fin(r)) {
      if (r >= 70) cons.push(`RSI ${formatNumber(r, 0)} — aşırı alım; kısa vadede soluklanma riski`);
      else if (r <= 30) pros.push(`RSI ${formatNumber(r, 0)} — aşırı satım; tepki ihtimali artar`);
      else if (r >= 55) pros.push(`RSI ${formatNumber(r, 0)} — momentum alıcılardan yana`);
      else if (r <= 45) cons.push(`RSI ${formatNumber(r, 0)} — momentum satıcılardan yana`);
    }
    if (fin(hNow) && fin(hPrev)) {
      if (hNow > 0 && hNow > hPrev) pros.push("MACD pozitif ve güçleniyor");
      else if (hNow > 0) cons.push("MACD pozitif ama ivme kaybediyor");
      else if (hNow < hPrev) cons.push("MACD negatif ve zayıflıyor");
      else pros.push("MACD negatif ama toparlanıyor");
    }
    if (hasVolume && fin(upShare)) {
      if (upShare >= 0.58) pros.push(`Son 20 günde hacmin %${formatNumber(upShare * 100, 0)}'i yükseliş günlerinde`);
      else if (upShare <= 0.42) cons.push(`Son 20 günde hacmin %${formatNumber((1 - upShare) * 100, 0)}'i düşüş günlerinde`);
    }
    if (fin(riskReward) && riskReward < 1) cons.push("İlk direnç yakın — dengeli stopa göre getiri/risk 1'in altında");

    return {
      n, o, h, l, c, v, price, sma20, sma50, sma200, macd, signal, hist, rsi, bb, adx,
      atr, atrPct, high52, low52, rangePos, t, rsiNow: r, histNow: hNow, macdNow: at(macd), signalNow: at(signal),
      trendScore, momentumScore, volumeScore, total, verdict, ranging, hasVolume, volumeRatio, upShare,
      supports, resistances, stops, target, riskReward, signals, pros, cons,
      returns: { w1: ret(5), m1: ret(21), m3: ret(63), m6: ret(126), y1: ret(252) },
      dayChangePct: ret(1), drawdown: pctDiff(price, high52),
    };
  }

  // ─────────────────────────────── Grafik ───────────────────────────────
  function niceTicks(lo, hi, count = 5) {
    const span = hi - lo || 1, raw = span / count, mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || raw;
    const ticks = [];
    for (let val = Math.ceil(lo / step) * step; val <= hi; val += step) ticks.push(val);
    return ticks;
  }

  function drawChart(A, points, currency, holding) {
    const host = $("#taChart");
    if (!host) return;
    const bars = (RANGES.find(x => x[0] === ui.range) || RANGES[2])[2];
    const start = Math.max(0, A.n - bars), count = A.n - start;
    const W = Math.max(480, Math.round(host.clientWidth || 880));
    const padL = 6, padR = 62, top = 8, priceH = 300, gap = 18, rsiH = 84, macdH = 84, axisH = 20;
    const rsiTop = top + priceH + gap, macdTop = rsiTop + rsiH + gap, H = macdTop + macdH + axisH;
    const plotW = W - padL - padR, step = plotW / count;
    const x = i => padL + (i - start + 0.5) * step;
    const slice = arr => arr.slice(start);
    const money = val => formatMoney(val, currency, { maximumFractionDigits: val >= 1000 ? 0 : 2 });

    const visible = [...slice(A.h), ...slice(A.l)];
    if (ui.sma20) visible.push(...slice(A.sma20));
    if (ui.sma50) visible.push(...slice(A.sma50));
    if (ui.sma200) visible.push(...slice(A.sma200));
    if (ui.bb) visible.push(...slice(A.bb.upper), ...slice(A.bb.lower));
    const vals = visible.filter(fin);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const padY = (hi - lo) * 0.06 || hi * 0.02; lo -= padY; hi += padY;
    const volH = A.hasVolume ? priceH * 0.2 : 0;
    const yP = val => top + ((hi - val) / (hi - lo)) * (priceH - volH - 6);
    const line = (arr, y) => {
      let d = "", pen = false;
      for (let i = start; i < A.n; i++) {
        if (!fin(arr[i])) { pen = false; continue; }
        d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(arr[i]).toFixed(1)}`; pen = true;
      }
      return d;
    };

    let svg = "";
    // Izgara ve fiyat ekseni
    niceTicks(lo, hi).forEach(val => {
      const y = yP(val);
      if (y < top + 4 || y > top + priceH - volH) return;
      svg += `<line class="ta-grid" x1="${padL}" x2="${W - padR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text class="ta-axis" x="${W - padR + 6}" y="${(y + 3.5).toFixed(1)}">${escapeHtml(money(val))}</text>`;
    });
    // Tarih ekseni
    const everyMonth = count > 300 ? 3 : count > 150 ? 2 : 1;
    let lastMonth = -1, monthCount = 0;
    for (let i = start; i < A.n; i++) {
      const d = new Date(points[i].t * 1000), m = d.getMonth();
      if (m === lastMonth) continue;
      lastMonth = m; monthCount++;
      if (i === start || monthCount % everyMonth) continue;
      const label = m === 0 ? String(d.getFullYear()) : monthFmt.format(d);
      svg += `<line class="ta-grid ta-grid-v" x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${top}" y2="${H - axisH}"/><text class="ta-axis" x="${x(i).toFixed(1)}" y="${H - 5}" text-anchor="middle">${escapeHtml(label)}</text>`;
    }
    // Hacim
    if (A.hasVolume) {
      const maxV = Math.max(...slice(A.v)) || 1, base = top + priceH, bw = Math.max(1, step * 0.7);
      let up = "", down = "";
      for (let i = start; i < A.n; i++) {
        const bh = (A.v[i] / maxV) * volH;
        const seg = `M${(x(i) - bw / 2).toFixed(1)},${base}v${(-bh).toFixed(1)}h${bw.toFixed(1)}v${bh.toFixed(1)}z`;
        (A.c[i] >= (i ? A.c[i - 1] : A.o[i]) ? (up += seg) : (down += seg));
      }
      svg += `<path class="ta-vol up" d="${up}"/><path class="ta-vol down" d="${down}"/>`;
    }
    // Bollinger
    if (ui.bb) {
      const upper = line(A.bb.upper, yP), lower = line(A.bb.lower, yP);
      svg += `<path class="ta-bb" d="${upper}"/><path class="ta-bb" d="${lower}"/>`;
    }
    // Fiyat
    if (ui.style === "candle") {
      const bw = Math.max(1, Math.min(14, step * 0.68));
      let upW = "", downW = "", upB = "", downB = "";
      for (let i = start; i < A.n; i++) {
        const isUp = A.c[i] >= A.o[i], cx = x(i);
        const wick = `M${cx.toFixed(1)},${yP(A.h[i]).toFixed(1)}V${yP(A.l[i]).toFixed(1)}`;
        const yTop = yP(Math.max(A.o[i], A.c[i])), bodyH = Math.max(1, yP(Math.min(A.o[i], A.c[i])) - yTop);
        const body = `M${(cx - bw / 2).toFixed(1)},${yTop.toFixed(1)}h${bw.toFixed(1)}v${bodyH.toFixed(1)}h${(-bw).toFixed(1)}z`;
        if (isUp) { upW += wick; upB += body; } else { downW += wick; downB += body; }
      }
      svg += `<path class="ta-wick up" d="${upW}"/><path class="ta-wick down" d="${downW}"/><path class="ta-body up" d="${upB}"/><path class="ta-body down" d="${downB}"/>`;
    } else {
      const d = line(A.c, yP);
      svg += `<path class="ta-area" d="${d}L${x(A.n - 1).toFixed(1)},${top + priceH - volH}L${x(start).toFixed(1)},${top + priceH - volH}Z"/><path class="ta-price" d="${d}"/>`;
    }
    if (ui.sma20) svg += `<path class="ta-ma ma20" d="${line(A.sma20, yP)}"/>`;
    if (ui.sma50) svg += `<path class="ta-ma ma50" d="${line(A.sma50, yP)}"/>`;
    if (ui.sma200) svg += `<path class="ta-ma ma200" d="${line(A.sma200, yP)}"/>`;

    // Seviye çizgileri ve eksen etiketleri
    const tags = [];
    const hline = (val, cls, label) => {
      if (!fin(val) || val < lo || val > hi) return;
      const y = yP(val);
      svg += `<line class="ta-level ${cls}" x1="${padL}" x2="${W - padR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
      tags.push({ y, cls, label });
    };
    if (ui.levels) {
      A.resistances.forEach(s => hline(s.price, "res", money(s.price)));
      A.supports.forEach(s => hline(s.price, "sup", money(s.price)));
      hline(A.stops[1].price, "stop", "Stop");
      if (holding && fin(holding.avgCost)) hline(holding.avgCost, "cost", "Maliyet");
    }
    tags.push({ y: yP(A.price), cls: "last", label: money(A.price) });
    // Üst üste binen eksen etiketlerini aşağı doğru aç
    tags.sort((a, b) => a.y - b.y);
    for (let i = 1; i < tags.length; i++) if (tags[i].y - tags[i - 1].y < 17) tags[i].y = tags[i - 1].y + 17;
    tags.forEach(tag => {
      svg += `<g class="ta-tag ${tag.cls}"><rect x="${W - padR + 2}" y="${(tag.y - 8).toFixed(1)}" width="${padR - 4}" height="16" rx="3"/><text x="${W - padR + 6}" y="${(tag.y + 3.5).toFixed(1)}">${escapeHtml(tag.label)}</text></g>`;
    });

    // RSI paneli
    const yR = val => rsiTop + ((100 - val) / 100) * rsiH;
    svg += `<rect class="ta-pane" x="${padL}" y="${rsiTop}" width="${plotW}" height="${rsiH}"/><rect class="ta-band" x="${padL}" y="${yR(70)}" width="${plotW}" height="${yR(30) - yR(70)}"/>`;
    [70, 30].forEach(val => { svg += `<line class="ta-guide" x1="${padL}" x2="${W - padR}" y1="${yR(val)}" y2="${yR(val)}"/><text class="ta-axis" x="${W - padR + 6}" y="${yR(val) + 3.5}">${val}</text>`; });
    svg += `<text class="ta-pane-title" x="${padL + 6}" y="${rsiTop + 13}">RSI 14</text><path class="ta-rsi" d="${line(A.rsi, yR)}"/>`;

    // MACD paneli
    const macdVals = [...slice(A.macd), ...slice(A.signal), ...slice(A.hist)].filter(fin).map(Math.abs);
    const maxM = (macdVals.length ? Math.max(...macdVals) : 1) * 1.15 || 1;
    const yM = val => macdTop + macdH / 2 - (val / maxM) * (macdH / 2);
    let histUp = "", histDown = "";
    const hw = Math.max(1, step * 0.6);
    for (let i = start; i < A.n; i++) {
      if (!fin(A.hist[i])) continue;
      const y = yM(A.hist[i]), zero = yM(0);
      const seg = `M${(x(i) - hw / 2).toFixed(1)},${Math.min(y, zero).toFixed(1)}h${hw.toFixed(1)}v${Math.max(0.6, Math.abs(y - zero)).toFixed(1)}h${(-hw).toFixed(1)}z`;
      (A.hist[i] >= 0 ? (histUp += seg) : (histDown += seg));
    }
    svg += `<rect class="ta-pane" x="${padL}" y="${macdTop}" width="${plotW}" height="${macdH}"/><line class="ta-guide" x1="${padL}" x2="${W - padR}" y1="${yM(0)}" y2="${yM(0)}"/><text class="ta-axis" x="${W - padR + 6}" y="${yM(0) + 3.5}">0</text>`;
    svg += `<text class="ta-pane-title" x="${padL + 6}" y="${macdTop + 13}">MACD 12 · 26 · 9</text><path class="ta-hist up" d="${histUp}"/><path class="ta-hist down" d="${histDown}"/><path class="ta-macd" d="${line(A.macd, yM)}"/><path class="ta-signal" d="${line(A.signal, yM)}"/>`;

    // İmleç
    svg += `<line id="taCrossV" class="ta-cross" y1="${top}" y2="${H - axisH}" visibility="hidden"/><line id="taCrossH" class="ta-cross" x1="${padL}" x2="${W - padR}" visibility="hidden"/><circle id="taCrossDot" class="ta-cross-dot" r="3.5" visibility="hidden"/>`;
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Fiyat, hacim, RSI ve MACD grafiği">${svg}</svg>`;

    const legend = $("#taLegend");
    const showLegend = i => {
      const prev = i > 0 ? A.c[i - 1] : A.o[i], chg = pctDiff(A.c[i], prev);
      const item = (label, value, cls = "") => `<span class="${cls}"><i>${label}</i>${value}</span>`;
      const f = val => (fin(val) ? formatMoney(val, currency, { maximumFractionDigits: 2 }) : "—");
      legend.innerHTML = [
        `<b>${escapeHtml(dateFmt.format(new Date(points[i].t * 1000)))}</b>`,
        item("A", f(A.o[i])), item("Y", f(A.h[i])), item("D", f(A.l[i])), item("K", f(A.c[i])),
        fin(chg) ? `<span class="${typeClass(chg)}">${signedPercent(chg)}</span>` : "",
        ui.sma20 && fin(A.sma20[i]) ? item("SMA20", f(A.sma20[i]), "ma20") : "",
        ui.sma50 && fin(A.sma50[i]) ? item("SMA50", f(A.sma50[i]), "ma50") : "",
        ui.sma200 && fin(A.sma200[i]) ? item("SMA200", f(A.sma200[i]), "ma200") : "",
        fin(A.rsi[i]) ? item("RSI", formatNumber(A.rsi[i], 1)) : "",
        fin(A.hist[i]) ? item("MACD hist", formatNumber(A.hist[i], 2)) : "",
      ].join("");
    };
    showLegend(A.n - 1);
    const svgEl = host.firstElementChild;
    const crossV = $("#taCrossV"), crossH = $("#taCrossH"), dot = $("#taCrossDot");
    svgEl.addEventListener("pointermove", event => {
      const rect = svgEl.getBoundingClientRect();
      const mx = ((event.clientX - rect.left) / rect.width) * W;
      const i = clamp(start + Math.floor((mx - padL) / step), start, A.n - 1);
      const cx = x(i).toFixed(1), cy = yP(A.c[i]).toFixed(1);
      crossV.setAttribute("x1", cx); crossV.setAttribute("x2", cx);
      crossH.setAttribute("y1", cy); crossH.setAttribute("y2", cy);
      dot.setAttribute("cx", cx); dot.setAttribute("cy", cy);
      [crossV, crossH, dot].forEach(el => el.setAttribute("visibility", "visible"));
      showLegend(i);
    });
    svgEl.addEventListener("pointerleave", () => {
      [crossV, crossH, dot].forEach(el => el.setAttribute("visibility", "hidden"));
      showLegend(A.n - 1);
    });
  }

  // ─────────────────────────────── Arayüz ───────────────────────────────
  function shellMarkup() {
    return `
    <div class="ta">
      <header class="ta-head">
        <div class="ta-id"><p class="ta-kicker">TEKNİK ANALİZ</p><h2 id="technicalTitle">—</h2><p id="technicalSubtitle" class="ta-sub">Fiyat geçmişi yükleniyor…</p></div>
        <div class="ta-quote"><strong id="taPrice">—</strong><span id="taChange"></span></div>
        <button class="ta-close" type="button" id="closeTechnicalDialogButton" aria-label="Teknik analiz penceresini kapat">✕</button>
      </header>
      <div class="ta-scroll">
        <div id="taMain"></div>
        <section class="ta-card ta-ai" id="aiAnalysisCard">
          <div class="ta-card-head"><div><h3>Yapay zekâ yorumu</h3><p>Yukarıdaki sayılar Gemini'ye gönderilir ve sade bir dille yorumlanır.</p></div><button class="button secondary" type="button" id="aiAnalyzeButton">Yorumla</button></div>
          <div id="aiAnalysisResult" class="ai-analysis-result ai-idle"></div>
        </section>
        <section class="ta-card ta-alerts">
          <div class="ta-card-head"><div><h3>Teknik alarm</h3><p>Koşul oluştuğunda fiyat yenilemesi sırasında uygulama içinde bildirilir.</p></div></div>
          <form id="technicalAlertForm" class="ta-alert-form">
            <select id="technicalAlertType" aria-label="Alarm türü"><option value="RSI_BELOW">RSI şu seviyenin altına inerse</option><option value="RSI_ABOVE">RSI şu seviyenin üstüne çıkarsa</option><option value="SMA20_CROSS_UP">SMA20, SMA50'yi yukarı keserse</option><option value="SMA20_CROSS_DOWN">SMA20, SMA50'yi aşağı keserse</option></select>
            <input id="technicalAlertThreshold" type="number" min="1" max="99" step="1" value="30" aria-label="RSI seviyesi" />
            <button class="button secondary" type="submit">Alarm ekle</button>
          </form>
          <div id="technicalAlertList" class="technical-alert-list"></div>
        </section>
        <p class="ta-disclaimer">Göstergeler geçmiş fiyat ve hacimden hesaplanır; gelecek getiriyi garanti etmez ve yatırım tavsiyesi değildir. Veri: Yahoo Finance günlük kapanışları.</p>
      </div>
    </div>`;
  }

  function gauge(label, score, detail) {
    if (score === null) return `<div class="ta-gauge is-empty"><div class="ta-gauge-top"><span>${label}</span><b>Veri yok</b></div><div class="ta-gauge-track"></div><small>${escapeHtml(detail)}</small></div>`;
    const tone = score >= 20 ? "positive" : score <= -20 ? "negative" : "neutral";
    const word = score >= 60 ? "Güçlü" : score >= 20 ? "Olumlu" : score > -20 ? "Nötr" : score > -60 ? "Olumsuz" : "Zayıf";
    const width = Math.abs(score) / 2, left = score >= 0 ? 50 : 50 - width;
    return `<div class="ta-gauge ${tone}"><div class="ta-gauge-top"><span>${label}</span><b>${word}</b></div><div class="ta-gauge-track"><i style="left:${left.toFixed(1)}%;width:${Math.max(width, 1.5).toFixed(1)}%"></i></div><small>${escapeHtml(detail)}</small></div>`;
  }

  function renderMain(A, points, currency, holding) {
    const money = val => (fin(val) ? formatMoney(val, currency, { maximumFractionDigits: 2 }) : "—");
    const pct = val => (fin(val) ? signedPercent(val) : "—");
    const dist = level => pct(pctDiff(level, A.price));
    const ago = age => (age === 0 ? "bugün" : `${age} işlem günü önce`);

    const levelRow = (lv, kind) => `<li class="${kind}"><span class="ta-lv-price">${money(lv.price)}</span><span class="ta-lv-dist">${dist(lv.price)}</span><span class="ta-lv-note">${lv.touches} temas${lv.touches >= 3 ? " · güçlü" : ""}</span></li>`;
    const maRows = [["SMA 20", A.t.s20], ["SMA 50", A.t.s50], ["SMA 200", A.t.s200]].filter(([, val]) => fin(val));
    const ladder = [
      ...[...A.resistances].reverse().map(lv => levelRow(lv, "res")),
      `<li class="now"><span class="ta-lv-price">${money(A.price)}</span><span class="ta-lv-dist">Şu an</span><span class="ta-lv-note"></span></li>`,
      ...A.supports.map(lv => levelRow(lv, "sup")),
    ].join("");

    const position = holding ? (() => {
      const pnlPct = pctDiff(A.price, holding.avgCost);
      return `<section class="ta-card"><h3>Pozisyonun</h3><dl class="ta-kv">
        <div><dt>Adet</dt><dd>${formatNumber(holding.quantity, 4)}</dd></div>
        <div><dt>Ortalama maliyet</dt><dd>${money(holding.avgCost)}</dd></div>
        <div><dt>Maliyete göre</dt><dd class="${fin(pnlPct) ? typeClass(pnlPct) : ""}">${pct(pnlPct)}</dd></div>
        <div><dt>Dengeli stopta sonuç</dt><dd class="${typeClass(A.stops[1].price - holding.avgCost)}">${pct(pctDiff(A.stops[1].price, holding.avgCost))}</dd></div>
      </dl></section>`;
    })() : "";

    const rr = fin(A.riskReward)
      ? `<p class="ta-rr">İlk dirence <b>${dist(A.target)}</b>, dengeli stopa <b>−%${formatNumber(A.stops[1].riskPct, 1)}</b> → getiri/risk <b class="${A.riskReward >= 1.5 ? "positive" : A.riskReward < 1 ? "negative" : ""}">${formatNumber(A.riskReward, 1)}</b></p>`
      : `<p class="ta-rr">Yukarıda görünür direnç yok; fiyat son bir yılın tepe bölgesinde.</p>`;

    const indicatorRows = [
      ["SMA 20 / 50 / 200", `${money(A.t.s20)} · ${money(A.t.s50)} · ${money(A.t.s200)}`, fin(A.t.s200) ? "" : "SMA200 için 200 işlem günü gerekir"],
      ["RSI (14)", fin(A.rsiNow) ? formatNumber(A.rsiNow, 1) : "—", !fin(A.rsiNow) ? "" : A.rsiNow >= 70 ? "Aşırı alım" : A.rsiNow <= 30 ? "Aşırı satım" : "Nötr bölge"],
      ["MACD / sinyal", fin(A.macdNow) ? `${formatNumber(A.macdNow, 2)} / ${formatNumber(A.signalNow, 2)}` : "—", !fin(A.histNow) ? "" : A.histNow > 0 ? "Sinyalin üzerinde" : "Sinyalin altında"],
      ["ADX (14)", fin(A.t.adx) ? formatNumber(A.t.adx, 0) : "—", !fin(A.t.adx) ? "" : A.t.adx >= 25 ? "Güçlü trend" : A.t.adx < 18 ? "Trend yok / yatay" : "Zayıf trend"],
      ["ATR (14)", `${money(A.atr)} · %${formatNumber(A.atrPct, 1)}`, A.atrPct > 4 ? "Çok oynak" : A.atrPct > 2.5 ? "Oynak" : A.atrPct > 1.2 ? "Normal" : "Sakin"],
      ["Hacim (5g / 50g)", fin(A.volumeRatio) ? `${formatNumber(A.volumeRatio, 2)}×` : "—", !A.hasVolume ? "Hacim verisi yok" : A.volumeRatio > 1.2 ? "Ortalamanın üzerinde" : A.volumeRatio < 0.8 ? "Ortalamanın altında" : "Ortalama"],
      ["52 hafta aralığı", `${money(A.low52)} – ${money(A.high52)}`, fin(A.rangePos) ? `Aralığın %${formatNumber(A.rangePos, 0)} seviyesinde · zirveden ${pct(A.drawdown)}` : ""],
    ].map(([name, value, note]) => `<tr><th scope="row">${name}</th><td>${value}</td><td>${escapeHtml(note)}</td></tr>`).join("");

    const perf = [["1H", A.returns.w1], ["1A", A.returns.m1], ["3A", A.returns.m3], ["6A", A.returns.m6], ["1Y", A.returns.y1]]
      .map(([label, val]) => `<div><span>${label}</span><b class="${fin(val) ? typeClass(val) : ""}">${pct(val)}</b></div>`).join("");

    const toggle = (key, label, cls = "") => `<button type="button" class="ta-chip ${cls} ${ui[key] ? "on" : ""}" data-ta-toggle="${key}" aria-pressed="${ui[key]}">${label}</button>`;

    $("#taMain").innerHTML = `
      <section class="ta-verdict ${A.verdict.tone}">
        <div class="ta-verdict-main">
          <p class="ta-kicker">GENEL GÖRÜNÜM · GÜNLÜK</p>
          <h3>${A.verdict.label}</h3>
          <div class="ta-reasons">
            ${A.pros.length ? `<ul class="pro">${A.pros.slice(0, 4).map(text => `<li>${escapeHtml(text)}</li>`).join("")}</ul>` : ""}
            ${A.cons.length ? `<ul class="con">${A.cons.slice(0, 4).map(text => `<li>${escapeHtml(text)}</li>`).join("")}</ul>` : ""}
          </div>
        </div>
        <div class="ta-gauges">
          ${gauge("Trend", A.trendScore, A.ranging ? "ADX düşük: yatay piyasa" : "Ortalamaların dizilimi ve eğimi")}
          ${gauge("Momentum", A.momentumScore, "RSI, MACD ve 20 günlük değişim")}
          ${gauge("Hacim", A.volumeScore, A.hasVolume ? "Yükseliş/düşüş günlerinin hacim payı" : "Bu sembol için hacim verisi gelmiyor")}
        </div>
      </section>

      <div class="ta-grid-main">
        <section class="ta-card ta-chart-card">
          <div class="ta-toolbar">
            <div class="ta-seg" role="group" aria-label="Grafik aralığı">${RANGES.map(([key, label]) => `<button type="button" data-ta-range="${key}" class="${ui.range === key ? "on" : ""}">${label}</button>`).join("")}</div>
            <div class="ta-seg" role="group" aria-label="Grafik türü"><button type="button" data-ta-style="candle" class="${ui.style === "candle" ? "on" : ""}">Mum</button><button type="button" data-ta-style="line" class="${ui.style === "line" ? "on" : ""}">Çizgi</button></div>
            <div class="ta-chips">${toggle("sma20", "SMA20", "ma20")}${toggle("sma50", "SMA50", "ma50")}${toggle("sma200", "SMA200", "ma200")}${toggle("bb", "Bollinger")}${toggle("levels", "Seviyeler")}</div>
          </div>
          <div id="taLegend" class="ta-legend"></div>
          <div id="taChart" class="ta-chart"></div>
        </section>

        <aside class="ta-side">
          <section class="ta-card"><h3>Destek ve direnç</h3><p class="ta-hint">Son bir yıldaki dönüş noktalarının kümelendiği bölgeler.</p><ul class="ta-ladder">${ladder}</ul>
            ${maRows.length ? `<div class="ta-ma-row">${maRows.map(([name, val]) => `<span><i>${name}</i>${money(val)} <em class="${typeClass(val - A.price)}">${dist(val)}</em></span>`).join("")}</div>` : ""}
          </section>
          <section class="ta-card"><h3>Risk planı</h3><p class="ta-hint">Zarar-kes seviyeleri ATR (%${formatNumber(A.atrPct, 1)} günlük oynaklık) ve desteklere göre.</p>
            <ul class="ta-stops">${A.stops.map(s => `<li class="${s.key}"><div><b>${s.title}</b><small>${escapeHtml(s.basis)}</small></div><div><strong>${money(s.price)}</strong><em>−%${formatNumber(s.riskPct, 1)}</em></div></li>`).join("")}</ul>
            ${rr}
          </section>
          ${position}
          <section class="ta-card"><h3>Getiri</h3><div class="ta-perf">${perf}</div></section>
          <section class="ta-card"><h3>Son sinyaller</h3>${A.signals.length ? `<ul class="ta-signals">${A.signals.slice(0, 5).map(s => `<li class="${s.tone}"><span>${escapeHtml(s.text)}</span><small>${ago(s.age)}</small></li>`).join("")}</ul>` : `<p class="ta-hint">Son haftalarda kesişim veya kırılım sinyali oluşmadı.</p>`}</section>
        </aside>
      </div>

      <section class="ta-card"><h3>Gösterge tablosu</h3><div class="ta-table-wrap"><table class="ta-table"><tbody>${indicatorRows}</tbody></table></div></section>`;
    drawChart(A, points, currency, holding);
  }

  function renderTechnicalAnalysisImpl() {
    if (!technicalView.symbol) return;
    const symbol = technicalView.symbol;
    const holding = calculatePortfolio().holdings.find(item => item.symbol === symbol);
    const watch = (state.watchlist || []).find(item => item.symbol === symbol);
    const name = holding?.name || watch?.name || "";
    const currency = getSymbolCurrency(symbol);
    $("#technicalTitle").textContent = name ? `${symbol.replace(/\.IS$/i, "")} · ${name}` : symbol.replace(/\.IS$/i, "");
    const subtitle = $("#technicalSubtitle"), main = $("#taMain");

    if (technicalView.loading) {
      subtitle.textContent = "Fiyat geçmişi yükleniyor…";
      main.innerHTML = `<div class="ta-state"><span class="ta-spinner" aria-hidden="true"></span><p>2 yıllık günlük veri alınıyor ve göstergeler hesaplanıyor…</p></div>`;
      $("#taPrice").textContent = "—"; $("#taChange").textContent = "";
      renderAiAnalysis(); return;
    }
    if (technicalView.error || technicalView.points.length < 30) {
      const message = technicalView.error || "Bu sembol için teknik analiz yapacak kadar günlük veri yok (en az 30 işlem günü gerekir).";
      subtitle.textContent = "Veri alınamadı";
      main.innerHTML = `<div class="ta-state is-error"><strong>Analiz oluşturulamadı</strong><p>${escapeHtml(message)}</p><button class="button secondary" type="button" data-retry-service="technical">Yeniden dene</button></div>`;
      renderAiAnalysis(); return;
    }
    const points = technicalView.points;
    const A = analyzeTechnicals(points);
    technicalView.analysis = A;
    technicalView.latestMetrics = getTechnicalMetrics(points);
    subtitle.textContent = technicalView.staleWarning || `${points.length} işlem günü · son veri ${dateFmt.format(new Date(points.at(-1).t * 1000))}`;
    $("#taPrice").textContent = formatMoney(A.price, currency, { maximumFractionDigits: 2 });
    const change = $("#taChange");
    change.textContent = fin(A.dayChangePct) ? `${signedPercent(A.dayChangePct)} bugün` : "";
    change.className = fin(A.dayChangePct) ? typeClass(A.dayChangePct) : "";
    renderMain(A, points, currency, holding);
    evaluateTechnicalAlerts(symbol, technicalView.latestMetrics);
    renderTechnicalAlerts(technicalView.latestMetrics);
    renderAiAnalysis();
  }

  async function loadTechnicalHistoryImpl() {
    if (!technicalView.symbol) return;
    if (location.protocol === "file:") { technicalView.error = "Teknik analiz için uygulamayı Baslat.cmd ile aç."; renderTechnicalAnalysisImpl(); return; }
    const symbol = technicalView.symbol;
    technicalView.loading = true; technicalView.error = ""; technicalView.staleWarning = "";
    renderTechnicalAnalysisImpl();
    try {
      const points = await getTechnicalHistory(symbol, "2y");
      if (technicalView.symbol !== symbol) return;
      technicalView.points = prepareDailyPoints(points);
    } catch (error) {
      if (technicalView.symbol !== symbol) return;
      technicalView.points = [];
      technicalView.error = friendlyError("price", error);
    }
    technicalView.loading = false;
    renderTechnicalAnalysisImpl();
    if (!technicalView.error && technicalView.points.length && getAiSettings().autoAnalyze && hasGeminiKey()) void callGeminiAIImpl();
  }

  function openTechnicalAnalysisImpl(symbol) {
    Object.assign(technicalView, { symbol, currency: getSymbolCurrency(symbol), points: [], error: "", staleWarning: "", aiResult: null, aiLoading: false, aiError: "", analysis: null });
    const dialog = $("#technicalDialog");
    if (!dialog.open) dialog.showModal();
    dialog.querySelector(".ta-scroll")?.scrollTo(0, 0);
    loadTechnicalHistoryImpl();
  }

  async function callGeminiAIImpl() {
    const fail = message => { technicalView.aiError = message; renderAiAnalysis(); };
    if (!hasGeminiKey()) return fail("Gemini API anahtarı bulunamadı. Ayarlar → Yapay Zekâ bölümünden gir.");
    const model = getGeminiModel() || $("#geminiModelSelect")?.value || "";
    if (!model) return fail("Ayarlar → Yapay Zekâ bölümünden bir model seçip kaydet.");
    const A = technicalView.analysis;
    if (!A) return fail("Teknik veri henüz yüklenmedi.");
    const symbol = technicalView.symbol, currency = getSymbolCurrency(symbol);
    const holding = calculatePortfolio().holdings.find(item => item.symbol === symbol);
    const money = val => (fin(val) ? formatMoney(val, currency, { maximumFractionDigits: 2 }) : "yok");
    const num = (val, digits = 1) => (fin(val) ? formatNumber(val, digits) : "yok");
    const prompt = `Sen bir teknik analiz uzmanısın ve bireysel yatırımcıya Türkçe yardım ediyorsun. Aşağıdaki GÜNLÜK veriler uygulamada hesaplandı; yeni sayı uydurma, yalnızca bunları yorumla.

Hisse: ${symbol}${holding ? ` (${holding.name})` : ""} · Para birimi: ${currency}
Son fiyat: ${money(A.price)} · Uygulamanın kural tabanlı sonucu: ${A.verdict.label}
SMA20 / SMA50 / SMA200: ${money(A.t.s20)} / ${money(A.t.s50)} / ${money(A.t.s200)}
ADX(14): ${num(A.t.adx, 0)} · RSI(14): ${num(A.rsiNow)} · MACD / sinyal: ${num(A.macdNow, 2)} / ${num(A.signalNow, 2)}
ATR(14): %${num(A.atrPct)} · 5g/50g hacim oranı: ${num(A.volumeRatio, 2)} · Son 20 günde yükseliş günlerinin hacim payı: ${fin(A.upShare) ? `%${num(A.upShare * 100, 0)}` : "yok"}
52 hafta aralığı: ${money(A.low52)} – ${money(A.high52)} (aralığın %${num(A.rangePos, 0)} seviyesinde)
Getiriler: 1 ay ${num(A.returns.m1)}%, 3 ay ${num(A.returns.m3)}%, 1 yıl ${num(A.returns.y1)}%
Destekler: ${A.supports.map(s => `${money(s.price)} (${s.touches} temas)`).join(", ") || "yok"}
Dirençler: ${A.resistances.map(s => `${money(s.price)} (${s.touches} temas)`).join(", ") || "yok"}
Zarar-kes seçenekleri: ${A.stops.map(s => `${s.title} ${money(s.price)}`).join(", ")} · Getiri/risk: ${num(A.riskReward)}
Son sinyaller: ${A.signals.map(s => `${s.text} (${s.age} gün önce)`).join("; ") || "yok"}
${holding ? `Kullanıcının maliyeti: ${money(holding.avgCost)}` : "Kullanıcının bu hissede pozisyonu yok."}

Yeni başlayan birinin tek okumada anlayacağı biçimde yaz; çelişen sinyalleri gizleme, kesin kazanç ima etme.
1. İlk satır: **Net sonuç: OLUMLU**, **Net sonuç: KARARSIZ** veya **Net sonuç: OLUMSUZ**.
2. **Neden?** — en fazla dört kısa madde (trend, momentum, hacim, risk).
3. **Kritik seviyeler** — hangi direncin aşılması teyit, hangi desteğin kırılması uyarı olur.
4. **${holding ? "Elimde varken" : "Almayı düşünüyorsam"}** — izlenecek koşulu tek cümlede yaz.
Sonuna bunun yatırım tavsiyesi olmadığını belirten tek kısa cümle ekle. Markdown **kalın** ve - liste kullanabilirsin.`;

    Object.assign(technicalView, { aiLoading: true, aiError: "", aiResult: null });
    renderAiAnalysis();
    try {
      if (getGeminiKey() && !await syncGeminiKeyToServer(getGeminiKey())) throw new Error("Gemini anahtarı sunucuya kaydedilemedi.");
      const response = await fetch("/api/ai/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4, maxOutputTokens: 2048 } }),
      });
      const data = await readJsonResponse(response, "gemini");
      if (!response.ok) throw serviceError("gemini");
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("Gemini boş yanıt döndürdü.");
      technicalView.aiResult = text;
    } catch (error) {
      technicalView.aiError = friendlyError("gemini", error);
    } finally {
      technicalView.aiLoading = false;
      renderAiAnalysis();
    }
  }

  function init() {
    const dialog = $("#technicalDialog");
    if (!dialog) return;
    dialog.innerHTML = shellMarkup();
    dialog.addEventListener("click", event => {
      const target = event.target.closest("button");
      if (event.target === dialog) { dialog.close(); return; }
      if (!target) return;
      if (target.id === "closeTechnicalDialogButton") { dialog.close(); return; }
      if (target.id === "aiAnalyzeButton") { void callGeminiAIImpl(); return; }
      if (target.dataset.retryService === "technical") { event.stopPropagation(); void loadTechnicalHistoryImpl(); return; }
      const rerender = () => { saveUi(); if (technicalView.analysis) renderTechnicalAnalysisImpl(); };
      if (target.dataset.taRange) { ui.range = target.dataset.taRange; rerender(); }
      else if (target.dataset.taStyle) { ui.style = target.dataset.taStyle; rerender(); }
      else if (target.dataset.taToggle) { ui[target.dataset.taToggle] = !ui[target.dataset.taToggle]; rerender(); }
    });
    $("#technicalAlertType").addEventListener("change", updateTechnicalAlertForm);
    $("#technicalAlertForm").addEventListener("submit", saveTechnicalAlert);
    updateTechnicalAlertForm();
    let resizeTimer = 0;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (dialog.open && technicalView.analysis && !technicalView.loading) renderTechnicalAnalysisImpl(); }, 150);
    });
  }

  // app.js bu adları çağırır; tek gerçek uygulama burada durur.
  window.renderTechnicalAnalysis = renderTechnicalAnalysisImpl;
  window.loadTechnicalHistory = loadTechnicalHistoryImpl;
  window.openTechnicalAnalysis = openTechnicalAnalysisImpl;
  window.callGeminiAI = callGeminiAIImpl;
  window.analyzeTechnicals = analyzeTechnicals;
  window.prepareDailyPoints = prepareDailyPoints;
  init();
})();
