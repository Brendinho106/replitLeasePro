import { type AnyPgColumn, pgTable, text, serial, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { syncConnectionsTable } from "./syncConnections";

export const syncFoldersTable = pgTable("sync_folders", {
  id: serial("id").primaryKey(),
  connectionId: integer("connection_id")
    .notNull()
    .references(() => syncConnectionsTable.id, { onDelete: "cascade" }),
  externalId: text("external_id"),
  parentId: integer("parent_id").references((): AnyPgColumn => syncFoldersTable.id, {
    onDelete: "cascade",
  }),
  name: text("name").notNull(),
  path: text("path").notNull(),
  isLocal: boolean("is_local").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSyncFolderSchema = createInsertSchema(syncFoldersTable).omit({
  id: true,
  createdAt: true,
});
export type InsertSyncFolder = z.infer<typeof insertSyncFolderSchema>;
export type SyncFolder = typeof syncFoldersTable.$inferSelect;
