import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';

export const workspaces = sqliteTable('progress_workspaces', {
  userId: text('user_id').primaryKey(),
  version: integer('version').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastWriteId: text('last_write_id').notNull(),
  chunkCount: integer('chunk_count').notNull(),
  digest: text('digest').notNull(),
});
export const versions = sqliteTable('progress_workspace_versions', {
  userId: text('user_id').notNull(),
  version: integer('version').notNull(),
  updatedAt: text('updated_at').notNull(),
  chunkCount: integer('chunk_count').notNull(),
  digest: text('digest').notNull(),
}, table => [primaryKey({ columns: [table.userId, table.version] })]);
export const chunks = sqliteTable('progress_workspace_chunks', {
  userId: text('user_id').notNull(),
  version: integer('version').notNull(),
  part: integer('part').notNull(),
  payload: text('payload').notNull(),
}, table => [primaryKey({ columns: [table.userId, table.version, table.part] })]);
