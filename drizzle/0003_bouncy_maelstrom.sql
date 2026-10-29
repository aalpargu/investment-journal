CREATE TABLE `portfolio_closed_positions` (
	`user_id` text NOT NULL,
	`state_id` text NOT NULL,
	`item_id` text NOT NULL,
	`position` integer NOT NULL,
	`item_json` text NOT NULL,
	PRIMARY KEY(`user_id`, `state_id`, `item_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_portfolio_closed_user_state_position` ON `portfolio_closed_positions` (`user_id`,`state_id`,`position`);--> statement-breakpoint
CREATE TABLE `portfolio_daily_snapshots` (
	`user_id` text NOT NULL,
	`state_id` text NOT NULL,
	`item_id` text NOT NULL,
	`position` integer NOT NULL,
	`item_json` text NOT NULL,
	PRIMARY KEY(`user_id`, `state_id`, `item_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_portfolio_snapshots_user_state_position` ON `portfolio_daily_snapshots` (`user_id`,`state_id`,`position`);--> statement-breakpoint
CREATE TABLE `portfolio_history_entries` (
	`user_id` text NOT NULL,
	`state_id` text NOT NULL,
	`item_id` text NOT NULL,
	`position` integer NOT NULL,
	`item_json` text NOT NULL,
	PRIMARY KEY(`user_id`, `state_id`, `item_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_portfolio_history_user_state_position` ON `portfolio_history_entries` (`user_id`,`state_id`,`position`);--> statement-breakpoint
CREATE TABLE `portfolio_journal_entries` (
	`user_id` text NOT NULL,
	`state_id` text NOT NULL,
	`item_id` text NOT NULL,
	`position` integer NOT NULL,
	`item_json` text NOT NULL,
	PRIMARY KEY(`user_id`, `state_id`, `item_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_portfolio_journal_user_state_position` ON `portfolio_journal_entries` (`user_id`,`state_id`,`position`);--> statement-breakpoint
CREATE TABLE `portfolio_settings` (
	`user_id` text NOT NULL,
	`state_id` text NOT NULL,
	`settings_json` text NOT NULL,
	PRIMARY KEY(`user_id`, `state_id`)
);
--> statement-breakpoint
CREATE TABLE `portfolio_state_manifests` (
	`user_id` text NOT NULL,
	`state_id` text NOT NULL,
	`revision` integer NOT NULL,
	`schema_version` integer NOT NULL,
	`is_demo` integer DEFAULT 0 NOT NULL,
	`onboarding_completed` integer DEFAULT 0 NOT NULL,
	`extra_json` text DEFAULT '{}' NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `state_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_portfolio_manifests_user_revision` ON `portfolio_state_manifests` (`user_id`,`revision`);--> statement-breakpoint
CREATE TABLE `portfolio_technical_alerts` (
	`user_id` text NOT NULL,
	`state_id` text NOT NULL,
	`item_id` text NOT NULL,
	`position` integer NOT NULL,
	`item_json` text NOT NULL,
	PRIMARY KEY(`user_id`, `state_id`, `item_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_portfolio_alerts_user_state_position` ON `portfolio_technical_alerts` (`user_id`,`state_id`,`position`);--> statement-breakpoint
CREATE TABLE `portfolio_transaction_audit` (
	`event_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`state_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`revision` integer NOT NULL,
	`action` text NOT NULL,
	`before_json` text,
	`after_json` text,
	`changed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_portfolio_audit_user_revision` ON `portfolio_transaction_audit` (`user_id`,`revision`);--> statement-breakpoint
CREATE TABLE `portfolio_transactions` (
	`user_id` text NOT NULL,
	`state_id` text NOT NULL,
	`item_id` text NOT NULL,
	`position` integer NOT NULL,
	`item_json` text NOT NULL,
	PRIMARY KEY(`user_id`, `state_id`, `item_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_portfolio_transactions_user_state_position` ON `portfolio_transactions` (`user_id`,`state_id`,`position`);--> statement-breakpoint
CREATE TABLE `portfolio_watchlist_items` (
	`user_id` text NOT NULL,
	`state_id` text NOT NULL,
	`item_id` text NOT NULL,
	`position` integer NOT NULL,
	`item_json` text NOT NULL,
	PRIMARY KEY(`user_id`, `state_id`, `item_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_portfolio_watchlist_user_state_position` ON `portfolio_watchlist_items` (`user_id`,`state_id`,`position`);
