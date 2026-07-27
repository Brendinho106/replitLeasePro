---
name: LeasePro RAG Architecture
description: Key decisions and quirks for the LeasePro RAG pipeline (OCR, chunking, concurrency, DB).
---

## RAG approach
- Full-text search via PostgreSQL tsvector (not embeddings)
- OpenAI key used directly (not Replit AI Integrations proxy)
- Model: gpt-4.1-mini with 70k-char context cap

## OCR pipeline
- pdf-parse for text extraction first; falls back to ocrmypdf if text is sparse or garbage
- isGarbageText() detects repeated-char runs (>25% threshold) and forces OCR
- Whole-doc OCR: 3-min timeout → on timeout falls back to page-by-page
- Page-by-page OCR: 3-min per-page timeout (raised from 90s after CPU-starvation issue)
- Documents process **sequentially** (not concurrently) — OCR is CPU-heavy; parallel runs cause every page to hit the timeout ceiling

**Why sequential matters:** when two OCR jobs run simultaneously they starve each other. Each page appears to time out not because Tesseract is slow but because the CPU is split. Fix: `await processOne(doc)` inside the startup loop, not fire-and-forget.

## Known un-ingestible doc patterns
- DocuSign/Adobe Sign executed leases often have content-extraction security flags that prevent ocrmypdf from reading page image data — whole-doc AND page-by-page both time out at the hard limit
- Image-only stacking plans (floor plans) yield no text even with OCR — need source files with a text layer
- Workaround for signed PDFs: print-to-PDF in Acrobat strips the security restrictions

## Startup recovery
- On startup, server resets any `processing` docs → `pending` then processes them sequentially
- Pool unhandled error events (`terminating connection`) previously crashed Node mid-OCR; fixed with `pool.on("error", ...)` handler
