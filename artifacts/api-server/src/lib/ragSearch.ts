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
 * Layer 1 — Seed context: pull chunks 0-2 from every ready document.
 *   chunk 0 is often a cover page or TOC; grabbing 0-2 ensures we reach
 *   actual content for baseline portfolio coverage.
 *
 * Layer 2 — Keyword relevance: run websearch_to_tsquery (FTS) first; fall
 *   back to multi-keyword ILIKE. For each matching chunk, also fetch its
 *   immediate neighbors (±1) so clauses that span chunk boundaries are not
 *   truncated. Additionally, when a document has many keyword hits, pull
 *   more of its chunks (up to PER_DOC_CAP) so tables like rent rolls are
 *   read completely.
 *
 * Result: seeds fill gaps; keyword hits + neighbors sharpen precision.
 */
export async function searchChunks(query: string, limit = 20): Promise<RelevantChunk[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  // Run seed fetch and keyword search in parallel
  const [seedRows, keywordRows] = await Promise.all([
    fetchSeedChunks(),
    fetchKeywordChunks(trimmed, limit),
  ]);

  // For documents that already have keyword hits, expand by fetching neighbors
  // and, if the doc has many hits (≥3), pull a fuller slice of that document.
  const neighborRows = keywordRows.length > 0
    ? await fetchNeighborsAndExpansions(keywordRows)
    : [];

  // Merge: keyword hits first (highest relevance), then neighbors, then seeds
  const seen = new Set<string>();
  const merged: RelevantChunk[] = [];

  const key = (r: RelevantChunk) => `${r.documentId}:${r.chunkIndex}`;

  for (const row of [...keywordRows, ...neighborRows, ...seedRows]) {
    const k = key(row);
    if (!seen.has(k)) {
      seen.add(k);
      merged.push(row);
    }
  }

  logger.info(
    {
      query: trimmed,
      keywordHits: keywordRows.length,
      neighborHits: neighborRows.length,
      seedHits: seedRows.length,
      total: merged.length,
    },
    "RAG chunks assembled",
  );

  return merged;
}

/**
 * Fetch the first 3 chunks (chunk_index 0-2) from every ready document.
 * Chunk 0 is often a cover page or TOC, so 0-2 ensures real content is included.
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
      AND c.chunk_index <= 2
      AND LENGTH(c.content) > 0
    ORDER BY d.id, c.chunk_index
  `);
  return result.rows as RelevantChunk[];
}

const STOPWORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with",
  "by","from","is","are","was","were","be","been","being","have","has",
  "had","do","does","did","will","would","could","should","may","might",
  "shall","can","not","this","that","these","those","what","which","who",
  "how","when","where","about","into","than","then","them","they","their",
  "there","its","our","your","his","her","we","you","it","as","if","any",
  "all","each","also","just","more","some","such","only","very","also",
  "tell","show","give","find","list","please","me","my","i","am","look",
  "same","does","just","need","want","like","does","make","take","know",
]);

/**
 * Extract keywords from a natural language query, keeping:
 *  - numbers / section references (e.g. "3.3", "52") — extracted BEFORE
 *    punctuation is stripped so "3.3" isn't split into "3" and "3"
 *  - meaningful words (length > 3, not a stopword, not a pure digit string)
 */
function extractKeywords(query: string): { words: string[]; numbers: string[] } {
  // Pull numeric tokens (integers and decimals like "3.3") before any stripping
  const numbers = [...new Set(query.match(/\b\d+(?:\.\d+)?\b/g) ?? [])].slice(0, 6);

  const words = query
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .split(/\s+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w))
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 8);

  return { words, numbers };
}

/**
 * Keyword-based chunk search.
 *
 * Two parallel passes run every time:
 *  1. FTS (OR logic) — finds chunks matching any meaningful word term,
 *     ranked by how many they hit.
 *  2. Number ILIKE — explicitly searches for any numeric tokens from the query
 *     (e.g. "3.3", "52") so section-number references are never dropped.
 *
 * Results from both passes are merged before returning.
 */
async function fetchKeywordChunks(query: string, limit: number): Promise<RelevantChunk[]> {
  try {
    const { words, numbers } = extractKeywords(query);

    const [ftsRows, numberRows] = await Promise.all([
      // --- Pass 1: OR-logic FTS over meaningful words ---
      (async (): Promise<RelevantChunk[]> => {
        if (words.length === 0) return [];

        const tsQueryStr = words.join(" | ");
        try {
          const result = await db.execute(sql`
            SELECT
              c.document_id   AS "documentId",
              d.filename,
              d.original_name AS "originalName",
              c.content,
              c.chunk_index   AS "chunkIndex",
              ts_rank(
                to_tsvector('english', c.content),
                to_tsquery('english', ${tsQueryStr})
              ) AS rank
            FROM chunks c
            JOIN documents d ON d.id = c.document_id
            WHERE d.status = 'ready'
              AND LENGTH(c.content) > 0
              AND to_tsvector('english', c.content) @@ to_tsquery('english', ${tsQueryStr})
            ORDER BY rank DESC
            LIMIT ${limit}
          `);

          if (result.rows.length > 0) return result.rows as RelevantChunk[];
        } catch (_ftsErr) {
          // FTS parse error — fall through to ILIKE
        }

        // ILIKE fallback for words
        const conditions = words
          .map((kw) => `c.content ILIKE '%${kw.replace(/'/g, "''")}%'`)
          .join(" OR ");
        const countExpr = words
          .map((kw) => `(CASE WHEN c.content ILIKE '%${kw.replace(/'/g, "''")}%' THEN 1 ELSE 0 END)`)
          .join(" + ");

        const fb = await db.execute(sql.raw(`
          SELECT
            c.document_id   AS "documentId",
            d.filename,
            d.original_name AS "originalName",
            c.content,
            c.chunk_index   AS "chunkIndex",
            (${countExpr})::float / 10.0 AS rank
          FROM chunks c
          JOIN documents d ON d.id = c.document_id
          WHERE d.status = 'ready'
            AND LENGTH(c.content) > 0
            AND (${conditions})
          ORDER BY rank DESC, c.document_id, c.chunk_index
          LIMIT ${limit}
        `));
        return fb.rows as RelevantChunk[];
      })(),

      // --- Pass 2: ILIKE for numeric/section-number tokens ---
      // "3.3" → ILIKE '%3.3%'; "52" → ILIKE '%52%'
      // This guarantees "Look at Sections 3.3 and 52" actually finds those sections.
      (async (): Promise<RelevantChunk[]> => {
        if (numbers.length === 0) return [];

        const numConditions = numbers
          .map((n) => `c.content ILIKE '%${n.replace(/'/g, "''")}%'`)
          .join(" OR ");
        const numCountExpr = numbers
          .map((n) => `(CASE WHEN c.content ILIKE '%${n.replace(/'/g, "''")}%' THEN 1 ELSE 0 END)`)
          .join(" + ");

        const result = await db.execute(sql.raw(`
          SELECT
            c.document_id   AS "documentId",
            d.filename,
            d.original_name AS "originalName",
            c.content,
            c.chunk_index   AS "chunkIndex",
            (${numCountExpr})::float / 10.0 AS rank
          FROM chunks c
          JOIN documents d ON d.id = c.document_id
          WHERE d.status = 'ready'
            AND LENGTH(c.content) > 0
            AND (${numConditions})
          ORDER BY rank DESC, c.document_id, c.chunk_index
          LIMIT ${limit}
        `));
        return result.rows as RelevantChunk[];
      })(),
    ]);

    // Merge: number hits first (most targeted), then FTS/word hits
    const seen = new Set<string>();
    const merged: RelevantChunk[] = [];
    for (const row of [...numberRows, ...ftsRows]) {
      const k = `${row.documentId}:${row.chunkIndex}`;
      if (!seen.has(k)) { seen.add(k); merged.push(row); }
    }
    return merged;
  } catch (err) {
    logger.error({ err, query }, "Keyword search error");
    return [];
  }
}

/**
 * For each keyword-matched chunk, fetch the chunk immediately before and after
 * it (±1) so clause text that spans a chunk boundary isn't cut off.
 *
 * Additionally, if a document has 3 or more keyword hits (suggesting the answer
 * lives mostly within that document — e.g. a rent roll with many tenants), fetch
 * a larger contiguous slice of that document (up to PER_DOC_EXPANSION_CAP chunks
 * starting from the lowest matched chunk_index).
 */
async function fetchNeighborsAndExpansions(
  keywordRows: RelevantChunk[],
): Promise<RelevantChunk[]> {
  const PER_DOC_EXPANSION_CAP = 30;

  // Group by document
  const byDoc = new Map<number, { indices: number[]; row: RelevantChunk }>();
  for (const row of keywordRows) {
    const existing = byDoc.get(row.documentId);
    if (existing) {
      existing.indices.push(row.chunkIndex);
    } else {
      byDoc.set(row.documentId, { indices: [row.chunkIndex], row });
    }
  }

  const allResults: RelevantChunk[] = [];

  for (const [docId, { indices, row }] of byDoc) {
    const minIdx = Math.min(...indices);
    const maxIdx = Math.max(...indices);
    const hitCount = indices.length;

    // Determine the fetch range:
    // - Always fetch ±1 neighbors around each hit
    // - If doc has ≥3 hits, pull a full slice from minIdx-1 onward (up to cap)
    let fetchFrom: number;
    let fetchCount: number;

    if (hitCount >= 3) {
      // Document is heavily relevant — pull a wider slice
      fetchFrom = Math.max(0, minIdx - 1);
      fetchCount = PER_DOC_EXPANSION_CAP;
    } else {
      // Just neighbors: from minIdx-1 to maxIdx+1
      fetchFrom = Math.max(0, minIdx - 1);
      fetchCount = maxIdx - fetchFrom + 2; // +2 for the trailing +1 neighbor
    }

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
      WHERE c.document_id = ${docId}
        AND c.chunk_index >= ${fetchFrom}
        AND LENGTH(c.content) > 0
      ORDER BY c.chunk_index
      LIMIT ${fetchCount}
    `);

    allResults.push(...(result.rows as RelevantChunk[]));
  }

  return allResults;
}

/**
 * Shorten a filename into a readable citation label.
 * "Red Gate Third Amendment Signed.pdf" → "Red Gate Third Amendment"
 */
function toCitationLabel(originalName: string): string {
  return originalName
    .replace(/\.[^/.]+$/, "")        // strip extension
    .replace(/\s+(signed|executed|final|v\d+)$/i, "") // strip trailing noise words
    .trim();
}

/**
 * Build a context string from retrieved chunks for the LLM system prompt.
 * Chunks are sorted by document and chunk_index so the LLM reads them in
 * document order (critical for rent rolls and sequential clause numbering).
 *
 * Returns both the formatted context string and an instruction reminder.
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

  // Sort by document id then chunk_index so sequential content reads naturally
  const sorted = [...chunks].sort(
    (a, b) => a.documentId - b.documentId || a.chunkIndex - b.chunkIndex,
  );

  // Group chunks by document
  const byDoc = new Map<number, RelevantChunk[]>();
  for (const chunk of sorted) {
    const existing = byDoc.get(chunk.documentId) ?? [];
    existing.push(chunk);
    byDoc.set(chunk.documentId, existing);
  }

  // Build context blocks — each chunk is preceded by its source label
  const sections: string[] = [];
  for (const [, docChunks] of byDoc) {
    const label = toCitationLabel(docChunks[0].originalName);
    for (const chunk of docChunks) {
      sections.push(`[Source: ${label}]\n${chunk.content}`);
    }
  }

  const legend =
    "When citing facts, use the exact label from the [Source: ...] tag above the relevant text, " +
    "formatted as **[Source Name]** at the end of the sentence. Example: " +
    '"Base rent is $35.41/SF **[Penrose III Rent Roll]**."';

  return {
    context: sections.join("\n\n"),
    legend,
  };
}
