CREATE TABLE `portfolio_state_versions` (
	`user_id` text NOT NULL,
	`revision` integer NOT NULL,
	`state_json` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `revision`)
);
--> statement-breakpoint
CREATE INDEX `idx_portfolio_versions_user_revision` ON `portfolio_state_versions` (`user_id`,`revision`);