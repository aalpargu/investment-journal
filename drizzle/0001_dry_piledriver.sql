CREATE TABLE `app_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`sec_contact_email` text,
	`gemini_api_key_encrypted` text,
	`telegram_bot_token_encrypted` text,
	`telegram_user_id` text,
	`telegram_webhook_id` text,
	`telegram_webhook_secret_encrypted` text,
	`telegram_diagnostics_json` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_app_settings_webhook_id` ON `app_settings` (`telegram_webhook_id`);--> statement-breakpoint
CREATE TABLE `pending_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source` text NOT NULL,
	`model` text,
	`received_at` text NOT NULL,
	`transactions_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pending_transactions_user_received` ON `pending_transactions` (`user_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `telegram_updates` (
	`user_id` text NOT NULL,
	`update_id` integer NOT NULL,
	`processed_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `update_id`)
);
