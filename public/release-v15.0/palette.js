/* Yatırım Defterim — Komut paleti (Ctrl+K)
 * Sayfalara, işlemlere ve hisselerin teknik analizine klavyeden ulaşmayı sağlar.
 */
(function () {
  "use strict";
  let dialog, input, list, items = [], active = 0;

  const norm = text => String(text || "").toLocaleLowerCase("tr-TR").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i");
  const bare = symbol => symbol.replace(/\.IS$/i, "");

  function build() {
    dialog = document.createElement("dialog");
    dialog.className = "cmdk";
    dialog.setAttribute("aria-label", "Komut paleti");
    dialog.innerHTML = `<div class="cmdk-box"><input class="cmdk-input" type="text" placeholder="Hisse, sayfa veya işlem ara…" autocomplete="off" spellcheck="false" aria-label="Ara" /><ul class="cmdk-list" role="listbox"></ul><p class="cmdk-foot"><span><kbd>↑</kbd><kbd>↓</kbd> gez</span><span><kbd>Enter</kbd> aç</span><span><kbd>Esc</kbd> kapat</span></p></div>`;
    document.body.append(dialog);
    input = dialog.querySelector(".cmdk-input");
    list = dialog.querySelector(".cmdk-list");
    input.addEventListener("input", () => { active = 0; render(); });
    input.addEventListener("keydown", event => {
      if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
      else if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
      else if (event.key === "Enter") { event.preventDefault(); run(items[active]); }
    });
    list.addEventListener("click", event => {
      const row = event.target.closest("li[data-index]");
      if (row) run(items[Number(row.dataset.index)]);
    });
    list.addEventListener("pointermove", event => {
      const row = event.target.closest("li[data-index]");
      if (row && Number(row.dataset.index) !== active) { active = Number(row.dataset.index); paint(); }
    });
    dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
  }

  function commands() {
    const out = [];
    const data = calculatePortfolio();
    const seen = new Set();
    const addSymbol = (symbol, name, hint) => {
      if (!symbol || seen.has(symbol)) return;
      seen.add(symbol);
      const isUs = !/\.IS$/i.test(symbol);
      out.push({ group: "Hisseler", title: bare(symbol), detail: name || "", hint, keys: `${symbol} ${name}`, run: () => openTechnicalAnalysis(symbol) });
      if (isUs && hint === "Portföyde" && typeof openStockDetail === "function") {
        out.push({ group: "Hisseler", title: `${bare(symbol)} · şirket detayı`, detail: name || "", hint: "Temel veriler", keys: `${symbol} ${name} detay temel`, run: () => openStockDetail(symbol) });
      }
    };
    (data.holdings || []).filter(h => h.market !== "FON").forEach(h => addSymbol(h.symbol, h.name, "Portföyde"));
    (state.watchlist || []).forEach(w => addSymbol(w.symbol, w.name, "Takip listesinde"));

    document.querySelectorAll(".sidebar .nav-item[data-page]").forEach(button => {
      out.push({ group: "Sayfalar", title: button.textContent.trim(), detail: "", hint: "Sayfa", keys: button.textContent, run: () => button.click() });
    });
    const click = selector => () => document.querySelector(selector)?.click();
    out.push({ group: "İşlemler", title: "İşlem ekle", detail: "Alış, satış veya nakit hareketi", hint: "İşlem", keys: "islem ekle alis satis yeni", run: click("#addTransactionButton") });
    out.push({ group: "İşlemler", title: "Fiyatları yenile", detail: "", hint: "İşlem", keys: "fiyat yenile guncelle", run: click("#refreshButton") });
    out.push({ group: "İşlemler", title: "Temayı değiştir", detail: "Aydınlık / karanlık", hint: "İşlem", keys: "tema aydinlik karanlik", run: click("#themeToggle") });
    out.push({ group: "İşlemler", title: "AI asistanı aç", detail: "Ekran görüntüsünden işlem ekle", hint: "İşlem", keys: "ai asistan yapay zeka", run: click("#aiAssistantBtn") });
    return out;
  }

  function filtered(query) {
    const all = commands();
    const q = norm(query.trim());
    if (!q) return all.slice(0, 40);
    const scored = all.map(item => {
      const title = norm(item.title), keys = norm(item.keys);
      const score = title === q ? 0 : title.startsWith(q) ? 1 : keys.split(/\s+/).some(word => word.startsWith(q)) ? 2 : keys.includes(q) ? 3 : -1;
      return { item, score };
    }).filter(x => x.score >= 0).sort((a, b) => a.score - b.score).map(x => x.item);
    // Listede olmayan bir kod yazıldıysa doğrudan analiz seçeneği sun
    const raw = query.trim().toUpperCase();
    if (/^[A-Z0-9.]{2,10}$/.test(raw) && !scored.some(item => norm(item.title) === q)) {
      const code = raw.replace(/\.IS$/, "");
      scored.push({ group: "Yeni sembol", title: `${code} · ABD`, detail: "Teknik analizi aç", hint: "ABD", run: () => openTechnicalAnalysis(code) });
      scored.push({ group: "Yeni sembol", title: `${code} · BIST`, detail: "Teknik analizi aç", hint: "BIST", run: () => openTechnicalAnalysis(`${code}.IS`) });
    }
    return scored.slice(0, 40);
  }

  function render() {
    items = filtered(input.value);
    active = Math.min(active, Math.max(items.length - 1, 0));
    if (!items.length) { list.innerHTML = `<li class="cmdk-empty">Sonuç yok. Bir hisse kodu yazarak teknik analizini açabilirsin.</li>`; return; }
    let group = "";
    list.innerHTML = items.map((item, index) => {
      const head = item.group !== group ? `<li class="cmdk-group" role="presentation">${escapeHtml(group = item.group)}</li>` : "";
      return `${head}<li data-index="${index}" role="option"><span class="cmdk-title">${escapeHtml(item.title)}</span><span class="cmdk-detail">${escapeHtml(item.detail || "")}</span><span class="cmdk-hint">${escapeHtml(item.hint || "")}</span></li>`;
    }).join("");
    paint();
  }

  function paint() {
    list.querySelectorAll("li[data-index]").forEach(row => {
      const on = Number(row.dataset.index) === active;
      row.classList.toggle("on", on);
      row.setAttribute("aria-selected", String(on));
      if (on) row.scrollIntoView({ block: "nearest" });
    });
  }

  function move(delta) {
    if (!items.length) return;
    active = (active + delta + items.length) % items.length;
    paint();
  }

  function run(item) {
    if (!item) return;
    dialog.close();
    item.run();
  }

  function open() {
    if (!dialog) build();
    if (dialog.open) { dialog.close(); return; }
    input.value = ""; active = 0;
    render();
    dialog.showModal();
    input.focus();
  }

  document.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") {
      event.preventDefault();
      open();
    }
  });
  document.addEventListener("click", event => { if (event.target.closest("[data-open-palette]")) open(); });
  window.openCommandPalette = open;
})();
