CREATE TABLE `seen_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`subscription_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`url` text NOT NULL,
	`first_seen` integer NOT NULL,
	`notified` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `seen_entries_sub_entry_idx` ON `seen_entries` (`subscription_id`,`entry_id`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`chat_id` integer NOT NULL,
	`blog_url` text NOT NULL,
	`blog_title` text,
	`feed_url` text,
	`sitemap_url` text,
	`monitor_type` text NOT NULL,
	`last_checked` integer,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_user_blog_idx` ON `subscriptions` (`user_id`,`blog_url`);