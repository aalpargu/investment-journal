import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const portfolioStates = sqliteTable('portfolio_states', {
  userId: text('user_id').primaryKey(),
  revision: integer('revision').notNull().default(1),
  stateJson: text('state_json').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const portfolioStateVersions = sqliteTable('portfolio_state_versions', {
  userId: text('user_id').notNull(),
  revision: integer('revision').notNull(),
  stateJson: text('state_json').notNull(),
  updatedAt: text('updated_at').notNull(),
}, table => [
  primaryKey({ columns: [table.userId, table.revision] }),
  index('idx_portfolio_versions_user_revision').on(table.userId, table.revision),
]);

export const appSettings = sqliteTable('app_settings', {
  userId: text('user_id').primaryKey(),
  secContactEmail: text('sec_contact_email'),
  geminiApiKeyEncrypted: text('gemini_api_key_encrypted'),
  telegramBotTokenEncrypted: text('telegram_bot_token_encrypted'),
  telegramUserId: text('telegram_user_id'),
  telegramWebhookId: text('telegram_webhook_id'),
  telegramWebhookSecretEncrypted: text('telegram_webhook_secret_encrypted'),
  telegramDiagnosticsJson: text('telegram_diagnostics_json'),
  updatedAt: text('updated_at').notNull(),
}, table => [uniqueIndex('idx_app_settings_webhook_id').on(table.telegramWebhookId)]);

export const pendingTransactions = sqliteTable('pending_transactions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  source: text('source').notNull(),
  model: text('model'),
  receivedAt: text('received_at').notNull(),
  transactionsJson: text('transactions_json').notNull(),
}, table => [index('idx_pending_transactions_user_received').on(table.userId, table.receivedAt)]);

export const telegramUpdates = sqliteTable('telegram_updates', {
  userId: text('user_id').notNull(),
  updateId: integer('update_id').notNull(),
  processedAt: text('processed_at').notNull(),
}, table => [primaryKey({ columns: [table.userId, table.updateId] })]);

export const portfolioStateManifests = sqliteTable('portfolio_state_manifests', {
  userId: text('user_id').notNull(),
  stateId: text('state_id').notNull(),
  revision: integer('revision').notNull(),
  schemaVersion: integer('schema_version').notNull(),
  isDemo: integer('is_demo').notNull().default(0),
  onboardingCompleted: integer('onboarding_completed').notNull().default(0),
  extraJson: text('extra_json').notNull().default('{}'),
  updatedAt: text('updated_at').notNull(),
}, table => [
  primaryKey({ columns: [table.userId, table.stateId] }),
  uniqueIndex('idx_portfolio_manifests_user_revision').on(table.userId, table.revision),
]);

export const portfolioSettings = sqliteTable('portfolio_settings', {
  userId: text('user_id').notNull(),
  stateId: text('state_id').notNull(),
  settingsJson: text('settings_json').notNull(),
}, table => [primaryKey({ columns: [table.userId, table.stateId] })]);

export const portfolioTransactions = sqliteTable('portfolio_transactions', {
  userId: text('user_id').notNull(),
  stateId: text('state_id').notNull(),
  itemId: text('item_id').notNull(),
  position: integer('position').notNull(),
  itemJson: text('item_json').notNull(),
}, table => [
  primaryKey({ columns: [table.userId, table.stateId, table.itemId] }),
  index('idx_portfolio_transactions_user_state_position').on(table.userId, table.stateId, table.position),
]);

export const portfolioWatchlistItems = sqliteTable('portfolio_watchlist_items', {
  userId: text('user_id').notNull(),
  stateId: text('state_id').notNull(),
  itemId: text('item_id').notNull(),
  position: integer('position').notNull(),
  itemJson: text('item_json').notNull(),
}, table => [
  primaryKey({ columns: [table.userId, table.stateId, table.itemId] }),
  index('idx_portfolio_watchlist_user_state_position').on(table.userId, table.stateId, table.position),
]);

export const portfolioClosedPositions = sqliteTable('portfolio_closed_positions', {
  userId: text('user_id').notNull(),
  stateId: text('state_id').notNull(),
  itemId: text('item_id').notNull(),
  position: integer('position').notNull(),
  itemJson: text('item_json').notNull(),
}, table => [
  primaryKey({ columns: [table.userId, table.stateId, table.itemId] }),
  index('idx_portfolio_closed_user_state_position').on(table.userId, table.stateId, table.position),
]);

export const portfolioJournalEntries = sqliteTable('portfolio_journal_entries', {
  userId: text('user_id').notNull(),
  stateId: text('state_id').notNull(),
  itemId: text('item_id').notNull(),
  position: integer('position').notNull(),
  itemJson: text('item_json').notNull(),
}, table => [
  primaryKey({ columns: [table.userId, table.stateId, table.itemId] }),
  index('idx_portfolio_journal_user_state_position').on(table.userId, table.stateId, table.position),
]);

export const portfolioDailySnapshots = sqliteTable('portfolio_daily_snapshots', {
  userId: text('user_id').notNull(),
  stateId: text('state_id').notNull(),
  itemId: text('item_id').notNull(),
  position: integer('position').notNull(),
  itemJson: text('item_json').notNull(),
}, table => [
  primaryKey({ columns: [table.userId, table.stateId, table.itemId] }),
  index('idx_portfolio_snapshots_user_state_position').on(table.userId, table.stateId, table.position),
]);

export const portfolioHistoryEntries = sqliteTable('portfolio_history_entries', {
  userId: text('user_id').notNull(),
  stateId: text('state_id').notNull(),
  itemId: text('item_id').notNull(),
  position: integer('position').notNull(),
  itemJson: text('item_json').notNull(),
}, table => [
  primaryKey({ columns: [table.userId, table.stateId, table.itemId] }),
  index('idx_portfolio_history_user_state_position').on(table.userId, table.stateId, table.position),
]);

export const portfolioTechnicalAlerts = sqliteTable('portfolio_technical_alerts', {
  userId: text('user_id').notNull(),
  stateId: text('state_id').notNull(),
  itemId: text('item_id').notNull(),
  position: integer('position').notNull(),
  itemJson: text('item_json').notNull(),
}, table => [
  primaryKey({ columns: [table.userId, table.stateId, table.itemId] }),
  index('idx_portfolio_alerts_user_state_position').on(table.userId, table.stateId, table.position),
]);

export const portfolioTransactionAudit = sqliteTable('portfolio_transaction_audit', {
  eventId: text('event_id').primaryKey(),
  userId: text('user_id').notNull(),
  stateId: text('state_id').notNull(),
  transactionId: text('transaction_id').notNull(),
  revision: integer('revision').notNull(),
  action: text('action').notNull(),
  beforeJson: text('before_json'),
  afterJson: text('after_json'),
  changedAt: text('changed_at').notNull(),
}, table => [index('idx_portfolio_audit_user_revision').on(table.userId, table.revision)]);

export const portfolioSyncOperations = sqliteTable('portfolio_sync_operations', {
  userId: text('user_id').notNull(),
  operationId: text('operation_id').notNull(),
  appliedRevision: integer('applied_revision').notNull(),
  appliedAt: text('applied_at').notNull(),
}, table => [
  primaryKey({ columns: [table.userId, table.operationId] }),
  index('idx_portfolio_sync_operations_user_applied').on(table.userId, table.appliedAt),
]);
