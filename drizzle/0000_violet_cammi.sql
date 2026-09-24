CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`mime` text NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`revision` integer NOT NULL,
	`document` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `projects_owner_updated_idx` ON `projects` (`owner`,`updated_at`);