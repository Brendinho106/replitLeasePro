# LeasePro

A RAG-powered commercial lease intelligence platform for property managers. Upload PDF, Excel, and Word lease documents, then ask questions in plain English — the AI searches across all indexed content and answers with precise, citation-backed responses.

## Run & Operate

- `pnpm --filter @workspace/lease-pro run dev` — run frontend (port from $PORT)
- `pnpm --filter @workspace/api-server run dev` — run API server (port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL`, `OPENAI_API_KEY`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`
- SharePoint sync (optional, stub defaults until configured):
  - `SHAREPOINT_SITE_URL` — e.g. `https://contoso.sharepoint.com/sites/leasing` (defaults to stub URL)
  - `SHAREPOINT_ROOT_FOLDER` — e.g. `Shared Documents/Leases` (defaults to stub path)
  - `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` — Azure app credentials for Graph API

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite, Tailwind v4, Wouter routing, Clerk auth
- API: Express 5 with SSE streaming
- DB: PostgreSQL + Drizzle ORM
- AI: OpenAI gpt-4o with RAG via PostgreSQL full-text search (tsvector)
- Validation: Zod (zod/v4), drizzle-zod
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — API contract (source of truth)
- `lib/db/src/schema/` — Drizzle schema: documents, chunks, conversations, messages, sync_connections, sync_folders
- `artifacts/api-server/src/routes/documents/` — document upload + processing pipeline
- `artifacts/api-server/src/routes/sync/` — SharePoint sync status, run, document tree
- `artifacts/api-server/src/lib/sharePointSync.ts` — stub layout, tree builder, sync orchestration
- `artifacts/api-server/src/lib/microsoftGraphClient.ts` — Graph API client (client credentials)
- `artifacts/api-server/src/routes/openai/` — RAG chat routes (SSE streaming)
- `artifacts/api-server/src/lib/docProcessor.ts` — PDF/Excel/Word text extraction + chunking
- `artifacts/api-server/src/lib/ragSearch.ts` — PostgreSQL full-text search for chunk retrieval
- `artifacts/lease-pro/src/` — React frontend: chat UI, document library, Clerk auth

## Architecture decisions

- **RAG without embeddings**: Uses PostgreSQL `tsvector`/`tsquery` full-text search instead of vector embeddings. Effective for lease documents (precise keyword search). Falls back to ILIKE for broader matching.
- **Chunking**: Documents split into ~600-char overlapping chunks (100-char overlap) at paragraph/sentence boundaries for coherent context windows.
- **Async processing**: Document ingestion runs asynchronously after upload — status polling via the documents list endpoint.
- **Multipart upload**: File upload via raw `fetch + FormData` (not generated hooks) since OpenAPI codegen doesn't handle multipart well.
- **SSE streaming**: Chat responses stream via SSE; frontend uses `ReadableStream` not `EventSource` (which only supports GET).

## Product

- **Landing page**: Clean marketing page with Clerk sign-in/sign-up
- **Chat interface**: Sidebar conversation list, streaming markdown-rendered responses, quick-action chips (Expirations, Deadlines, Escalations, Portfolio summary)
- **Document library**: Drag-and-drop upload, SharePoint-style folder tree, sync status banner, processing status, portfolio stats dashboard
- **Supported file types**: PDF, Excel (.xlsx/.xls), CSV, Word (.docx/.doc), plain text

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- After schema changes, run `pnpm --filter @workspace/db run push` then `pnpm run typecheck:libs`
- `pdf-parse`, `xlsx`, and `mammoth` are externalized in esbuild (not bundled) due to CJS/native module issues
- Clerk dev key warning in browser console is expected in development — not an error
- The `uploads/` directory is created automatically on first file upload

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
