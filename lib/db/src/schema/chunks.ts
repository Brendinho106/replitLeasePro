import { pgTable, text, serial, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";
import { documentsTable } from "./documents";

export const chunksTable = pgTable(
  "chunks",
  {
    id: serial("id").primaryKey(),
    documentId: integer("document_id")
      .notNull()
      .references(() => documentsTable.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    // We store a generated tsvector column for full-text search
    // This is populated by a DB trigger set up via SQL migration
    searchVector: text("search_vector"),
  },
  (table) => ({
    documentIdIdx: index("chunks_document_id_idx").on(table.documentId),
  }),
);

export const insertChunkSchema = createInsertSchema(chunksTable).omit({
  id: true,
});
export type InsertChunk = z.infer<typeof insertChunkSchema>;
export type Chunk = typeof chunksTable.$inferSelect;
