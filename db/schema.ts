import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

export const authUsers = sqliteTable('auth_users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: text('created_at').notNull(),
});
export const authSessions = sqliteTable('auth_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id').notNull().references(() => authUsers.id, {onDelete:'cascade'}),
  expiresAt: integer('expires_at').notNull(),
}, table => [index('auth_sessions_expiry_idx').on(table.expiresAt)]);
export const authAttempts = sqliteTable('auth_attempts', {
  key: text('key').primaryKey(),
  attempts: integer('attempts').notNull(),
  expiresAt: integer('expires_at').notNull(),
}, table => [index('auth_attempts_expiry_idx').on(table.expiresAt)]);

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
