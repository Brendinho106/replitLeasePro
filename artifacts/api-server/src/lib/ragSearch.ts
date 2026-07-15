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
 * Search document chunks using a two-layer strategy:
 *
 * Layer 1 — Seed context: always pull chunk_index=0 from every ready document.
 *   This guarantees the LLM has baseline portfolio coverage for every query,
 *   including broad commands like "show portfolio summary" where keyword search
 *   would return nothing useful.
 *
 * Layer 2 — Keyword relevance: run websearch_to_tsquery (FTS) first; fall back
 *   to multi-keyword ILIKE. Merge with seed chunks, deduplicating by chunk id.
 *
 * Result: seeds fill gaps; keyword hits sharpen precision for targeted questions.
 */
export async function searchChunks(query: string, limit = 6): Promise<RelevantChunk[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  // Run seed fetch and keyword search in parallel
  const [seedRows, keywordRows] = await Promise.all([
    fetchSeedChunks(),
    fetchKeywordChunks(trimmed, limit),
  ]);

  // Merge: start with keyword hits (highest relevance), then append seeds not already included
  const seen = new Set<number>();
  const merged: RelevantChunk[] = [];

  for (const row of keywordRows) {
    if (!seen.has(row.documentId * 10000 + row.chunkIndex)) {
      seen.add(row.documentId * 10000 + row.chunkIndex);
      merged.push(row);
    }
  }

  for (const row of seedRows) {
    if (!seen.has(row.documentId * 10000 + row.chunkIndex)) {
      seen.add(row.documentId * 10000 + row.chunkIndex);
      merged.push(row);
    }
  }

  logger.info(
    { query: trimmed, keywordHits: keywordRows.length, seedHits: seedRows.length, total: merged.length },
    "RAG chunks assembled",
  );

  return merged;
}

/**
 * Fetch the first chunk (chunk_index = 0) from every ready document.
 * This is the "seed" layer — ensures every doc has baseline representation.
 */
async function fetchSeedChunks(): Promise<RelevantChunk[]> {
  const result = await db.execute(sql`
    SELECT
      c.document_id   AS "documentId",
      d.filename,
      d.original_name AS "originalName",
      c.content,
      c.chunk_index   AS "chunkIndex",
      0.0             AS rank
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE d.status = 'ready'
      AND c.chunk_index = 0
      AND LENGTH(c.content) > 0
    ORDER BY d.id
  `);
  return result.rows as RelevantChunk[];
}

/**
 * Keyword-based chunk search: FTS via websearch_to_tsquery, falling back to ILIKE.
 */
async function fetchKeywordChunks(query: string, limit: number): Promise<RelevantChunk[]> {
  try {
    // websearch_to_tsquery handles natural language — "base rent schedule" works as-is
    const ftsResult = await db.execute(sql`
      SELECT
        c.document_id   AS "documentId",
        d.filename,
        d.original_name AS "originalName",
        c.content,
        c.chunk_index   AS "chunkIndex",
        ts_rank(
          to_tsvector('english', c.content),
          websearch_to_tsquery('english', ${query})
        ) AS rank
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE d.status = 'ready'
        AND LENGTH(c.content) > 0
        AND to_tsvector('english', c.content) @@ websearch_to_tsquery('english', ${query})
      ORDER BY rank DESC
      LIMIT ${limit}
    `);

    if (ftsResult.rows.length > 0) {
      return ftsResult.rows as RelevantChunk[];
    }

    // ILIKE fallback: OR across meaningful keywords
    const keywords = query
      .replace(/[^a-zA-Z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 6);

    if (keywords.length === 0) return [];

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
        0.01            AS rank
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE d.status = 'ready'
        AND LENGTH(c.content) > 0
        AND (${conditions})
      ORDER BY rank DESC
      LIMIT ${limit}
    `));

    return fallbackResult.rows as RelevantChunk[];
  } catch (err) {
    logger.error({ err, query }, "Keyword search error");
    return [];
  }
}

/**
 * Build a context string from retrieved chunks for the LLM system prompt.
 * Each chunk is tagged with a numbered source reference [N] so the LLM can
 * cite specific documents inline (e.g. "the rent is $X [2]").
 *
 * Returns both the formatted context string and the source legend.
 */
export function buildContext(chunks: RelevantChunk[]): {
  context: string;
  legend: string;
} {
  if (chunks.length === 0) {
    return {
      context: "No lease documents are currently indexed in the database.",
      legend: "",
    };
  }

  // Assign a stable citation number to each unique document
  const docNumbers = new Map<number, number>();
  let nextNum = 1;
  for (const chunk of chunks) {
    if (!docNumbers.has(chunk.documentId)) {
      docNumbers.set(chunk.documentId, nextNum++);
    }
  }

  // Group chunks by document
  const byDoc = new Map<number, RelevantChunk[]>();
  for (const chunk of chunks) {
    const existing = byDoc.get(chunk.documentId) ?? [];
    existing.push(chunk);
    byDoc.set(chunk.documentId, existing);
  }

  // Build context blocks with citation tags
  const sections: string[] = [];
  for (const [docId, docChunks] of byDoc) {
    const num = docNumbers.get(docId)!;
    const docName = docChunks[0].originalName;
    sections.push(`[${num}] ${docName}`);
    for (const chunk of docChunks) {
      sections.push(chunk.content);
    }
  }

  // Build legend mapping numbers to document names
  const legendLines: string[] = ["Source index:"];
  for (const [docId, num] of docNumbers) {
    const docChunks = byDoc.get(docId)!;
    legendLines.push(`  [${num}] ${docChunks[0].originalName}`);
  }

  return {
    context: sections.join("\n\n"),
    legend: legendLines.join("\n"),
  };
}
