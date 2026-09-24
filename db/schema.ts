import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  owner: text('owner').notNull(),
  revision: integer('revision').notNull(),
  document: text('document').notNull(),
  updatedAt: text('updated_at').notNull(),
}, table => [index('projects_owner_updated_idx').on(table.owner, table.updatedAt)]);

export const assets = sqliteTable('assets', {
  id: text('id').primaryKey(),
  owner: text('owner').notNull(),
  mime: text('mime').notNull(),
  name: text('name').notNull(),
});
