import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

export type RelevantChunk = {
  documentId: number;
  filename: string;
  originalName: string;
  content: string;
  chunkIndex: number;
  rank: number;
};

/**
 * Search document chunks using PostgreSQL full-text search.
 * Falls back to ILIKE if no FTS results found.
 */
export async function searchChunks(query: string, limit = 8): Promise<RelevantChunk[]> {
  // Sanitize query for tsquery — strip special chars, join words with &
  const tsQuery = query
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .join(" & ");

  if (!tsQuery) {
    return [];
  }

  try {
    // Full-text search using to_tsquery
    const ftsResult = await db.execute(sql`
      SELECT
        c.document_id as "documentId",
        d.filename,
        d.original_name as "originalName",
        c.content,
        c.chunk_index as "chunkIndex",
        ts_rank(to_tsvector('english', c.content), to_tsquery('english', ${tsQuery})) as rank
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE d.status = 'ready'
        AND to_tsvector('english', c.content) @@ to_tsquery('english', ${tsQuery})
      ORDER BY rank DESC
      LIMIT ${limit}
    `);

    const rows = ftsResult.rows as RelevantChunk[];

    if (rows.length > 0) {
      return rows;
    }

    // Fallback: ILIKE search on keywords
    const keywords = query.split(/\s+/).filter((w) => w.length > 3);
    if (keywords.length === 0) return [];

    const likePattern = `%${keywords[0]}%`;
    const fallbackResult = await db.execute(sql`
      SELECT
        c.document_id as "documentId",
        d.filename,
        d.original_name as "originalName",
        c.content,
        c.chunk_index as "chunkIndex",
        0.1 as rank
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE d.status = 'ready'
        AND c.content ILIKE ${likePattern}
      ORDER BY c.document_id, c.chunk_index
      LIMIT ${limit}
    `);

    return fallbackResult.rows as RelevantChunk[];
  } catch (err) {
    logger.error({ err }, "RAG search error");
    return [];
  }
}

/**
 * Build a context string from retrieved chunks for the LLM prompt.
 */
export function buildContext(chunks: RelevantChunk[]): string {
  if (chunks.length === 0) {
    return "No relevant lease documents found in the database.";
  }

  // Group by document for cleaner context
  const byDoc = new Map<number, RelevantChunk[]>();
  for (const chunk of chunks) {
    const existing = byDoc.get(chunk.documentId) ?? [];
    existing.push(chunk);
    byDoc.set(chunk.documentId, existing);
  }

  const sections: string[] = [];
  for (const [, docChunks] of byDoc) {
    const doc = docChunks[0];
    sections.push(`--- Document: ${doc.originalName} ---`);
    for (const chunk of docChunks) {
      sections.push(chunk.content);
    }
  }

  return sections.join("\n\n");
}
