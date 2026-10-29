"use strict";

(function installPortfolioOfflineQueue(global) {
  function safeEntries(storage, key) {
    try {
      const payload = JSON.parse(storage.getItem(key) || "null");
      const entries = Array.isArray(payload?.entries) ? payload.entries : [];
      return entries.filter(entry => (
        entry
        && typeof entry.id === "string"
        && Number.isFinite(Number(entry.createdAt))
        && entry.operation
        && ["upsert", "delete"].includes(entry.operation.type)
        && typeof entry.operation.transactionId === "string"
        && (entry.operation.type === "delete"
          || (entry.operation.transaction
            && typeof entry.operation.transaction === "object"
            && entry.operation.transaction.id === entry.operation.transactionId))
      ));
    } catch {
      return [];
    }
  }

  function transactionMap(values) {
    const result = new Map();
    (Array.isArray(values) ? values : []).forEach(transaction => {
      if (!transaction || typeof transaction !== "object" || transaction.demo === true) return;
      const id = String(transaction.id || "").trim();
      if (id) result.set(id, transaction);
    });
    return result;
  }

  function diffTransactions(beforeValues, afterValues) {
    const before = transactionMap(beforeValues);
    const after = transactionMap(afterValues);
    const operations = [];

    for (const [transactionId, transaction] of after) {
      const previous = before.get(transactionId);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(transaction)) {
        operations.push({ type: "upsert", transactionId, transaction });
      }
    }
    for (const transactionId of before.keys()) {
      if (!after.has(transactionId)) operations.push({ type: "delete", transactionId });
    }
    return operations;
  }

  function createOutbox({ storage, key, maxEntries = 500, now = () => Date.now(), idFactory } = {}) {
    if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
      throw new Error("Kalıcı tarayıcı depolaması bulunamadı.");
    }
    if (!key) throw new Error("Kuyruk anahtarı gerekli.");

    const createId = typeof idFactory === "function"
      ? idFactory
      : () => global.crypto?.randomUUID?.() || `offline-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let entries = safeEntries(storage, key);

    function persist(nextEntries) {
      storage.setItem(key, JSON.stringify({ version: 1, entries: nextEntries }));
      entries = nextEntries;
    }

    function enqueueMany(operations) {
      const additions = (Array.isArray(operations) ? operations : [])
        .filter(operation => operation && ["upsert", "delete"].includes(operation.type))
        .map(operation => ({
          id: String(createId()),
          createdAt: Number(now()),
          operation: JSON.parse(JSON.stringify(operation))
        }));
      if (!additions.length) return [];

      const next = [...entries, ...additions].slice(-Math.max(1, Number(maxEntries) || 500));
      try {
        persist(next);
      } catch {
        // İşlemler zaten ana yerel kayıtta bulunduğundan depolama kotası
        // dolarsa en yeni işlemleri korumak güvenli son durum eşitlemesini sağlar.
        const compact = next.slice(-Math.min(100, next.length));
        persist(compact);
      }
      return additions;
    }

    function acknowledge(id) {
      if (!entries.length || entries[0].id !== id) return false;
      persist(entries.slice(1));
      return true;
    }

    return Object.freeze({
      acknowledge,
      count: () => entries.length,
      enqueueMany,
      list: () => entries.map(entry => JSON.parse(JSON.stringify(entry))),
      peek: () => entries.length ? JSON.parse(JSON.stringify(entries[0])) : null
    });
  }

  global.PortfolioOfflineQueue = Object.freeze({ createOutbox, diffTransactions });
})(globalThis);
