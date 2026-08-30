import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { syncFoldersTable } from "./syncFolders";

export const documentsTable = pgTable("documents", {
  id: serial("id").primaryKey(),
  filename: text("filename").notNull(),
  originalName: text("original_name").notNull(),
  fileType: text("file_type").notNull(),
  filePath: text("file_path").notNull(),
  status: text("status").notNull().default("pending"), // pending | processing | ready | error
  chunkCount: integer("chunk_count"),
  errorMessage: text("error_message"),
  folderId: integer("folder_id").references(() => syncFoldersTable.id, { onDelete: "set null" }),
  externalItemId: text("external_item_id"),
  source: text("source").notNull().default("upload"), // upload | sharepoint
  relativePath: text("relative_path"),
  visibility: text("visibility").notNull().default("all"), // all | restricted (future RBAC)
  externalEtag: text("external_etag"),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
});

export const insertDocumentSchema = createInsertSchema(documentsTable).omit({
  id: true,
  uploadedAt: true,
});
export type InsertDocument = z.infer<typeof insertDocumentSchema>;
export type Document = typeof documentsTable.$inferSelect;
