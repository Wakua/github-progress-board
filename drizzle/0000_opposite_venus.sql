CREATE TABLE `progress_workspace_chunks` (
	`user_id` text NOT NULL,
	`version` integer NOT NULL,
	`part` integer NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`user_id`, `version`, `part`)
);
--> statement-breakpoint
CREATE TABLE `progress_workspace_versions` (
	`user_id` text NOT NULL,
	`version` integer NOT NULL,
	`updated_at` text NOT NULL,
	`chunk_count` integer NOT NULL,
	`digest` text NOT NULL,
	PRIMARY KEY(`user_id`, `version`)
);
--> statement-breakpoint
CREATE TABLE `progress_workspaces` (
	`user_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`updated_at` text NOT NULL,
	`last_write_id` text NOT NULL,
	`chunk_count` integer NOT NULL,
	`digest` text NOT NULL
);
