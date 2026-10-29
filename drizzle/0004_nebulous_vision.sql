CREATE TABLE `portfolio_sync_operations` (
	`user_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`applied_revision` integer NOT NULL,
	`applied_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `operation_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_portfolio_sync_operations_user_applied` ON `portfolio_sync_operations` (`user_id`,`applied_at`);