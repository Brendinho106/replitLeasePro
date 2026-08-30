---
name: LeasePro RAG Architecture
description: Key decisions and quirks for the LeasePro RAG pipeline (OCR, chunking, concurrency, DB).
---

## RAG approach
- Full-text search via PostgreSQL tsvector (not embeddings)
- OpenAI key used directly (not Replit AI Integrations proxy)
- Model: gpt-4.1-mini with 70k-char context cap

## OCR pipeline (docProcessor.ts)
- pdf-parse for text extraction first; falls back to ocrmypdf if text is sparse (<100 chars) or garbage
- isGarbageText() detects repeated-char runs (>25% threshold) and forces OCR
- **Vector Print-to-PDF** (Microsoft Print To PDF, no /Font in bytes): uses `--force-ocr` — `--skip-text` skips every page on these files
- **Image scans** (Canon/Konica): `--skip-text` first (faster); if result still sparse, retry whole-doc with `--force-ocr`
- Whole-doc OCR timeout scales with page count: min 8 min, max 25 min (~45s/page)
- ocrmypdf flags: `--deskew --rotate-pages -l eng --optimize 1 --jobs 1`
- Page-by-page fallback only when whole-doc times out or returns thin text
  - 2 min per page (not 15 min — restricted PDFs were burning hours)
  - Abort after 3 consecutive page failures/timeouts (DocuSign/restricted PDF pattern)
- Documents process **sequentially** (not concurrently) — OCR is CPU-heavy; parallel runs starve CPU and cause false timeouts

**Why sequential matters:** when two OCR jobs run simultaneously they starve each other. Each page appears to time out not because Tesseract is slow but because the CPU is split. Fix: `await processOne(doc)` inside the startup loop, not fire-and-forget.

## Local preprocessing (optional workaround)
For very large scans or when Replit CPU is insufficient, preprocess locally:
1. ocrmypdf `--skip-text` (scans) or `--force-ocr` (Print-to-PDF)
2. Ghostscript compress (`-dPDFSETTINGS=/ebook`) if over 50 MB upload limit
3. Upload the searchable PDF — server skips OCR when text layer is present

## Known un-ingestible doc patterns
- DocuSign/Adobe Sign executed leases often have content-extraction security flags that prevent ocrmypdf from reading page image data — whole-doc AND page-by-page both fail quickly now (3 consecutive page abort)
- Image-only stacking plans (floor plans) yield no text even with OCR — need source files with a text layer
- Workaround for signed PDFs: print-to-PDF in Acrobat strips the security restrictions

## Startup recovery
- On startup, server resets any `processing` docs → `pending` then processes them sequentially
- Pool unhandled error events (`terminating connection`) previously crashed Node mid-OCR; fixed with `pool.on("error", ...)` handler
