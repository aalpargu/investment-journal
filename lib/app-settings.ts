import { env } from 'cloudflare:workers';
import { getCloudStore } from '@/lib/cloud-store';

export type AppSettings = {
  userId: string;
  secContactEmail: string;
  geminiApiKeyEncrypted: string;
  telegramBotTokenEncrypted: string;
  telegramUserId: string;
  telegramWebhookId: string;
  telegramWebhookSecretEncrypted: string;
  telegramDiagnosticsJson: string;
  updatedAt: string;
};

const EMPTY_SETTINGS: Omit<AppSettings, 'userId'> = {
  secContactEmail: '',
  geminiApiKeyEncrypted: '',
  telegramBotTokenEncrypted: '',
  telegramUserId: '',
  telegramWebhookId: '',
  telegramWebhookSecretEncrypted: '',
  telegramDiagnosticsJson: '',
  updatedAt: '',
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function encryptionKey(): Promise<CryptoKey> {
  const configured = (env.APP_CONFIG_ENCRYPTION_KEY ?? '').trim();
  if (!configured) throw new Error('Bulut gizli ayar şifreleme anahtarı yapılandırılmamış.');
  let material: Uint8Array;
  try {
    material = base64UrlToBytes(configured);
  } catch {
    material = new Uint8Array();
  }
  if (material.byteLength !== 32) throw new Error('Bulut gizli ayar şifreleme anahtarı geçersiz.');
  return crypto.subtle.importKey('raw', exactArrayBuffer(material), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(value: string): Promise<string> {
  if (!value) return '';
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(value);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(), encoded);
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(encrypted))}`;
}

export async function decryptSecret(value: string | null | undefined): Promise<string> {
  if (!value) return '';
  const [version, ivValue, encryptedValue] = value.split('.');
  if (version !== 'v1' || !ivValue || !encryptedValue) throw new Error('Kayıtlı gizli ayar biçimi geçersiz.');
  const iv = base64UrlToBytes(ivValue);
  const encrypted = base64UrlToBytes(encryptedValue);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: exactArrayBuffer(iv) },
    await encryptionKey(),
    exactArrayBuffer(encrypted),
  );
  return new TextDecoder().decode(decrypted);
}

export async function readAppSettings(userId: string): Promise<AppSettings> {
  const db = await getCloudStore();
  const row = await db.prepare(`SELECT
      user_id AS userId,
      COALESCE(sec_contact_email, '') AS secContactEmail,
      COALESCE(gemini_api_key_encrypted, '') AS geminiApiKeyEncrypted,
      COALESCE(telegram_bot_token_encrypted, '') AS telegramBotTokenEncrypted,
      COALESCE(telegram_user_id, '') AS telegramUserId,
      COALESCE(telegram_webhook_id, '') AS telegramWebhookId,
      COALESCE(telegram_webhook_secret_encrypted, '') AS telegramWebhookSecretEncrypted,
      COALESCE(telegram_diagnostics_json, '') AS telegramDiagnosticsJson,
      updated_at AS updatedAt
    FROM app_settings WHERE user_id = ?`).bind(userId).first<AppSettings>();
  return row || { userId, ...EMPTY_SETTINGS };
}

export async function readAppSettingsByWebhookId(webhookId: string): Promise<AppSettings | null> {
  const db = await getCloudStore();
  return db.prepare(`SELECT
      user_id AS userId,
      COALESCE(sec_contact_email, '') AS secContactEmail,
      COALESCE(gemini_api_key_encrypted, '') AS geminiApiKeyEncrypted,
      COALESCE(telegram_bot_token_encrypted, '') AS telegramBotTokenEncrypted,
      COALESCE(telegram_user_id, '') AS telegramUserId,
      COALESCE(telegram_webhook_id, '') AS telegramWebhookId,
      COALESCE(telegram_webhook_secret_encrypted, '') AS telegramWebhookSecretEncrypted,
      COALESCE(telegram_diagnostics_json, '') AS telegramDiagnosticsJson,
      updated_at AS updatedAt
    FROM app_settings WHERE telegram_webhook_id = ?`).bind(webhookId).first<AppSettings>();
}

export async function saveAppSettings(
  userId: string,
  updates: Partial<Omit<AppSettings, 'userId' | 'updatedAt'>>,
): Promise<AppSettings> {
  const current = await readAppSettings(userId);
  const next: AppSettings = {
    ...current,
    ...updates,
    userId,
    updatedAt: new Date().toISOString(),
  };
  const db = await getCloudStore();
  await db.prepare(`INSERT INTO app_settings (
      user_id, sec_contact_email, gemini_api_key_encrypted, telegram_bot_token_encrypted,
      telegram_user_id, telegram_webhook_id, telegram_webhook_secret_encrypted,
      telegram_diagnostics_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      sec_contact_email = excluded.sec_contact_email,
      gemini_api_key_encrypted = excluded.gemini_api_key_encrypted,
      telegram_bot_token_encrypted = excluded.telegram_bot_token_encrypted,
      telegram_user_id = excluded.telegram_user_id,
      telegram_webhook_id = excluded.telegram_webhook_id,
      telegram_webhook_secret_encrypted = excluded.telegram_webhook_secret_encrypted,
      telegram_diagnostics_json = excluded.telegram_diagnostics_json,
      updated_at = excluded.updated_at`).bind(
      next.userId,
      next.secContactEmail || null,
      next.geminiApiKeyEncrypted || null,
      next.telegramBotTokenEncrypted || null,
      next.telegramUserId || null,
      next.telegramWebhookId || null,
      next.telegramWebhookSecretEncrypted || null,
      next.telegramDiagnosticsJson || null,
      next.updatedAt,
    ).run();
  return next;
}

export function randomSecret(bytes = 24): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export type PendingGroup = {
  id: string;
  source: string;
  model: string;
  receivedAt: string;
  transactions: Array<Record<string, unknown>>;
};

export async function listPendingTransactions(userId: string): Promise<PendingGroup[]> {
  const db = await getCloudStore();
  const result = await db.prepare(`SELECT id, source, COALESCE(model, '') AS model,
      received_at AS receivedAt, transactions_json AS transactionsJson
    FROM pending_transactions WHERE user_id = ? ORDER BY received_at ASC LIMIT 100`).bind(userId).all<{
      id: string; source: string; model: string; receivedAt: string; transactionsJson: string;
    }>();
  return result.results.flatMap(row => {
    try {
      const transactions = JSON.parse(row.transactionsJson);
      return Array.isArray(transactions) ? [{ id: row.id, source: row.source, model: row.model, receivedAt: row.receivedAt, transactions }] : [];
    } catch {
      return [];
    }
  });
}

export async function insertPendingTransactions(userId: string, group: PendingGroup): Promise<void> {
  const db = await getCloudStore();
  await db.prepare(`INSERT OR REPLACE INTO pending_transactions
    (id, user_id, source, model, received_at, transactions_json) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(group.id, userId, group.source, group.model || null, group.receivedAt, JSON.stringify(group.transactions)).run();
}

export async function acknowledgePendingTransaction(userId: string, groupId: string, transactionId = ''): Promise<{ removed: number; remaining: number }> {
  const groups = await listPendingTransactions(userId);
  const group = groups.find(item => item.id === groupId);
  if (!group) return { removed: 0, remaining: groups.length };
  const db = await getCloudStore();
  if (!transactionId) {
    const result = await db.prepare('DELETE FROM pending_transactions WHERE user_id = ? AND id = ?').bind(userId, groupId).run();
    return { removed: Number(result.meta?.changes || 0), remaining: Math.max(0, groups.length - 1) };
  }
  const transactions = group.transactions.filter(item => (
    typeof item._pendingTransactionId === 'string' ? item._pendingTransactionId : ''
  ) !== transactionId);
  if (transactions.length === group.transactions.length) return { removed: 0, remaining: groups.length };
  if (!transactions.length) {
    await db.prepare('DELETE FROM pending_transactions WHERE user_id = ? AND id = ?').bind(userId, groupId).run();
    return { removed: 1, remaining: Math.max(0, groups.length - 1) };
  }
  await db.prepare('UPDATE pending_transactions SET transactions_json = ? WHERE user_id = ? AND id = ?')
    .bind(JSON.stringify(transactions), userId, groupId).run();
  return { removed: 1, remaining: groups.length };
}

export async function claimTelegramUpdate(userId: string, updateId: number): Promise<boolean> {
  const db = await getCloudStore();
  const result = await db.prepare(`INSERT OR IGNORE INTO telegram_updates (user_id, update_id, processed_at)
    VALUES (?, ?, ?)`).bind(userId, updateId, new Date().toISOString()).run();
  return Number(result.meta?.changes || 0) === 1;
}

export async function releaseTelegramUpdate(userId: string, updateId: number): Promise<void> {
  const db = await getCloudStore();
  await db.prepare('DELETE FROM telegram_updates WHERE user_id = ? AND update_id = ?').bind(userId, updateId).run();
}
