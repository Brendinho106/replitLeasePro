import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const syncConnectionsTable = pgTable("sync_connections", {
  id: serial("id").primaryKey(),
  provider: text("provider").notNull().default("sharepoint"),
  siteUrl: text("site_url").notNull(),
  siteId: text("site_id"),
  driveId: text("drive_id"),
  rootFolderId: text("root_folder_id"),
  rootFolderPath: text("root_folder_path").notNull(),
  deltaLink: text("delta_link"),
  syncStatus: text("sync_status").notNull().default("idle"), // idle | syncing | error
  lastSyncError: text("last_sync_error"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSyncConnectionSchema = createInsertSchema(syncConnectionsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertSyncConnection = z.infer<typeof insertSyncConnectionSchema>;
export type SyncConnection = typeof syncConnectionsTable.$inferSelect;
