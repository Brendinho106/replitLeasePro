---
name: LeasePro RAG Architecture
description: Key decisions for the LeasePro lease intelligence app — RAG approach, auth, and upload pipeline
---

## RAG without embeddings
PostgreSQL `tsvector`/`tsquery` full-text search is used for chunk retrieval instead of vector embeddings. The OpenAI embeddings API is not available via Replit AI Integrations. Falls back to ILIKE when FTS returns no results.

**Why:** OpenAI Replit AI Integration doesn't support the embeddings API. User provided their own `OPENAI_API_KEY` for chat completions (gpt-4o).

**How to apply:** If better semantic search is needed later, add pgvector extension and use OpenAI embeddings directly via the user's API key.

## Document processing
- Async: upload returns immediately, processing happens in background
- Supported: PDF (pdf-parse), Excel/CSV (xlsx), Word (mammoth), TXT
- `pdf-parse`, `xlsx`, `mammoth` are externalized in esbuild (not bundled) — they use CJS/native patterns that break when bundled
- Chunks: ~600 chars, 100-char overlap, break at paragraph/sentence boundaries

## Auth
- Clerk (Replit-managed) with proxy middleware
- Cookie-based session for web (no Bearer tokens needed in frontend fetch calls)

## File upload
- Raw `fetch + FormData` POST to `/api/documents/upload` — NOT via generated hooks
- Multer handles multipart on server side

## Streaming chat
- SSE via `ReadableStream` / `getReader()` in frontend (not EventSource, which only supports GET)
- Each chunk: `data: {"content": "..."}`, final: `data: {"done": true}`
