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
 *
 * Strategy:
 *  1. websearch_to_tsquery — handles natural language, uses OR between terms,
 *     understands quoted phrases, negations. Much better for conversational queries.
 *  2. Fallback: ILIKE across all meaningful keywords (OR'd together) if FTS returns nothing.
 */
export async function searchChunks(query: string, limit = 8): Promise<RelevantChunk[]> {
  // Skip empty queries
  const trimmed = query.trim();
  if (!trimmed) return [];

  try {
    // websearch_to_tsquery parses natural language: "base rent escalation" becomes
    // 'base' | 'rent' | 'escalat' internally — no manual tokenisation needed.
    const ftsResult = await db.execute(sql`
      SELECT
        c.document_id   AS "documentId",
        d.filename,
        d.original_name AS "originalName",
        c.content,
        c.chunk_index   AS "chunkIndex",
        ts_rank(
          to_tsvector('english', c.content),
          websearch_to_tsquery('english', ${trimmed})
        ) AS rank
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE d.status = 'ready'
        AND LENGTH(c.content) > 0
        AND to_tsvector('english', c.content) @@ websearch_to_tsquery('english', ${trimmed})
      ORDER BY rank DESC
      LIMIT ${limit}
    `);

    const rows = ftsResult.rows as RelevantChunk[];
    if (rows.length > 0) {
      logger.info({ query: trimmed, count: rows.length }, "FTS hit");
      return rows;
    }

    // Fallback: ILIKE on every meaningful keyword, OR'd together, ranked by match count
    const keywords = trimmed
      .replace(/[^a-zA-Z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 6); // cap at 6 keywords to keep the query sane

    if (keywords.length === 0) return [];

    // Build a dynamic ILIKE OR chain
    const conditions = keywords
      .map((kw) => `c.content ILIKE '%${kw.replace(/'/g, "''")}%'`)
      .join(" OR ");

    const fallbackResult = await db.execute(sql.raw(`
      SELECT
        c.document_id   AS "documentId",
        d.filename,
        d.original_name AS "originalName",
        c.content,
        c.chunk_index   AS "chunkIndex",
        0.01 AS rank
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE d.status = 'ready'
        AND LENGTH(c.content) > 0
        AND (${conditions})
      ORDER BY c.document_id, c.chunk_index
      LIMIT ${limit}
    `));

    const fallbackRows = fallbackResult.rows as RelevantChunk[];
    logger.info(
      { query: trimmed, keywords, count: fallbackRows.length },
      fallbackRows.length > 0 ? "ILIKE fallback hit" : "no chunks found",
    );
    return fallbackRows;
  } catch (err) {
    logger.error({ err, query: trimmed }, "RAG search error");
    return [];
  }
}

/**
 * Build a context string from retrieved chunks for the LLM system prompt.
 */
export function buildContext(chunks: RelevantChunk[]): string {
  if (chunks.length === 0) {
    return "No relevant lease documents found in the database.";
  }

  // Group by document for readable context blocks
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
