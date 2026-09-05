CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner_id` text,
	`prefix` text NOT NULL,
	`token_hash` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_token_hash_unique` ON `api_keys` (`token_hash`);--> statement-breakpoint
CREATE INDEX `api_keys_owner_idx` ON `api_keys` (`owner_id`);--> statement-breakpoint
CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bots` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner_id` text,
	`telegram_bot_id` text,
	`telegram_username` text,
	`encrypted_token` text NOT NULL,
	`token_hint` text,
	`enabled` integer DEFAULT true NOT NULL,
	`encrypted_webhook_secret` text NOT NULL,
	`allowed_updates` text DEFAULT '[]' NOT NULL,
	`webhook_state` text DEFAULT 'not_configured' NOT NULL,
	`webhook_url` text,
	`webhook_last_error` text,
	`webhook_last_set_at` integer,
	`last_update_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `bots_owner_idx` ON `bots` (`owner_id`);--> statement-breakpoint
CREATE INDEX `bots_enabled_idx` ON `bots` (`enabled`);--> statement-breakpoint
CREATE UNIQUE INDEX `bots_telegram_bot_id_unique` ON `bots` (`telegram_bot_id`);--> statement-breakpoint
CREATE TABLE `deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`route_id` text,
	`destination_id` text,
	`destination_url` text NOT NULL,
	`destination_method` text DEFAULT 'POST' NOT NULL,
	`event_type` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer NOT NULL,
	`next_attempt_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`response_status` integer,
	`duration_ms` integer,
	`last_error` text,
	`locked_at` integer,
	`locked_by` text,
	`is_replay` integer DEFAULT false NOT NULL,
	`replay_of_delivery_id` text,
	`is_test` integer DEFAULT false NOT NULL,
	`request_headers` text,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `telegram_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`route_id`) REFERENCES `routes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`destination_id`) REFERENCES `destinations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `deliveries_queue_idx` ON `deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `deliveries_event_idx` ON `deliveries` (`event_id`);--> statement-breakpoint
CREATE INDEX `deliveries_bot_created_idx` ON `deliveries` (`bot_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `deliveries_destination_idx` ON `deliveries` (`destination_id`);--> statement-breakpoint
CREATE INDEX `deliveries_created_idx` ON `deliveries` (`created_at`);--> statement-breakpoint
CREATE TABLE `delivery_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`delivery_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`duration_ms` integer,
	`response_status` integer,
	`response_body` text,
	`error_code` text,
	`error_message` text,
	`succeeded` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`delivery_id`) REFERENCES `deliveries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `delivery_attempts_delivery_idx` ON `delivery_attempts` (`delivery_id`,`attempt`);--> statement-breakpoint
CREATE TABLE `destinations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner_id` text,
	`url` text NOT NULL,
	`method` text DEFAULT 'POST' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`timeout_ms` integer,
	`headers` text,
	`signing_enabled` integer DEFAULT true NOT NULL,
	`encrypted_signing_secret` text,
	`signing_secret_hint` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `destinations_owner_idx` ON `destinations` (`owner_id`);--> statement-breakpoint
CREATE TABLE `routes` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`destination_id` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`update_types` text DEFAULT '[]' NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`chat_id_filter` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`destination_id`) REFERENCES `destinations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `routes_bot_idx` ON `routes` (`bot_id`);--> statement-breakpoint
CREATE INDEX `routes_destination_idx` ON `routes` (`destination_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`csrf_token` text NOT NULL,
	`user_agent` text,
	`ip_address` text,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `telegram_events` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`telegram_update_id` integer,
	`event_type` text NOT NULL,
	`chat_id` text,
	`payload` text NOT NULL,
	`is_test` integer DEFAULT false NOT NULL,
	`received_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_events_bot_update_unique` ON `telegram_events` (`bot_id`,`telegram_update_id`);--> statement-breakpoint
CREATE INDEX `telegram_events_bot_received_idx` ON `telegram_events` (`bot_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `telegram_events_type_idx` ON `telegram_events` (`event_type`);--> statement-breakpoint
CREATE INDEX `telegram_events_received_idx` ON `telegram_events` (`received_at`);--> statement-breakpoint
CREATE INDEX `telegram_events_chat_idx` ON `telegram_events` (`chat_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'manager' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`display_name` text,
	`must_change_password` integer DEFAULT false NOT NULL,
	`is_bootstrap` integer DEFAULT false NOT NULL,
	`last_login_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);