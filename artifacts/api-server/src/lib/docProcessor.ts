import { readFile, unlink, writeFile } from "fs/promises";
import { createRequire } from "module";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { logger } from "./logger";
import { objectStorageClient } from "./objectStorage";

/**
 * If filePath is a GCS key (relative, no leading slash) download it to a
 * temp file and return { localPath, cleanup }.  If it's already a local
 * absolute path just return it with a no-op cleanup.
 */
export async function resolveLocalPath(
  filePath: string,
  fileType: string,
): Promise<{ localPath: string; cleanup: () => Promise<void> }> {
  // Absolute path → already on local disk (dev environment or legacy)
  if (path.isAbsolute(filePath)) {
    return { localPath: filePath, cleanup: async () => {} };
  }

  // Relative path → GCS object key (e.g. "uploads/timestamp_name.pdf")
  const bucketId = process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"];
  if (!bucketId) throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID not set");

  const tmpPath = path.join(tmpdir(), `${randomUUID()}.${fileType}`);
  logger.info({ filePath, tmpPath }, "Downloading file from GCS for processing");
  await objectStorageClient.bucket(bucketId).file(filePath).download({ destination: tmpPath });

  return {
    localPath: tmpPath,
    cleanup: () => unlink(tmpPath).catch(() => {}),
  };
}

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

// Minimum meaningful characters before we consider text extraction successful.
// Scanned PDFs typically return whitespace-only or near-empty strings.
const MIN_TEXT_LENGTH = 100;

/**
 * Returns true if the text looks like garbled PDF encoding output — e.g.
 * "DoDDDDDDDDDD...FlFlFlFlFl...eiiiiiiiiii" — rather than real prose.
 * These strings pass the length check but contain mostly repeated-character
 * runs and should be sent through OCR instead of being stored as-is.
 */
function isGarbageText(text: string): boolean {
  // Count characters that appear in runs of 5 or more
  const runs = text.match(/(.)\1{4,}/g) ?? [] as string[];
  const runCharCount = (runs as string[]).reduce((sum: number, r: string) => sum + r.length, 0);
  return runCharCount / text.length > 0.25;
}

export type ParsedDoc = {
  text: string;
  metadata: Record<string, string>;
};

/**
 * Extract text from a file based on its extension.
 * filePath may be an absolute local path OR a GCS object key (relative path).
 * GCS keys are downloaded to a temp file first, then cleaned up automatically.
 */
export async function extractText(filePath: string, fileType: string): Promise<string> {
  const { localPath, cleanup } = await resolveLocalPath(filePath, fileType);
  try {
    return await extractTextLocal(localPath, fileType);
  } finally {
    await cleanup();
  }
}

async function extractTextLocal(filePath: string, fileType: string): Promise<string> {
  const ext = fileType.toLowerCase();

  if (ext === "pdf") {
    return extractPdf(filePath);
  }
  if (ext === "xlsx" || ext === "xls" || ext === "csv") {
    return extractSpreadsheet(filePath, ext);
  }
  if (ext === "docx" || ext === "doc") {
    return extractWord(filePath);
  }
  if (ext === "txt") {
    const buf = await readFile(filePath);
    return buf.toString("utf-8");
  }
  throw new Error(`Unsupported file type: ${ext}`);
}

async function extractPdf(filePath: string): Promise<string> {
  // Use createRequire to reliably load this CJS module in an ESM context
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pdfParse = require("pdf-parse") as (buf: Buffer) => Promise<{ text: string; numpages: number }>;

  const buf = await readFile(filePath);
  const data = await pdfParse(buf);
  const text = data.text.trim();

  // If the PDF has a usable, non-garbage text layer, return it directly
  if (text.length >= MIN_TEXT_LENGTH && !isGarbageText(text)) {
    return text;
  }

  const reason = text.length < MIN_TEXT_LENGTH ? "sparse text layer" : "garbage text detected";
  logger.info({ filePath, textLength: text.length, reason }, "Running OCR");
  return runOcrAndExtract(filePath, pdfParse);
}

// Whole-document OCR timeout: 3 minutes.  If the full doc finishes within
// this window we're done quickly.  If it hangs we fall back to page-by-page.
const OCR_WHOLE_DOC_TIMEOUT_MS = 3 * 60 * 1000;

// Per-page timeout used in the page-by-page fallback.  Most pages OCR in
// a few seconds; 3 minutes gives even high-res scanned pages a fair chance
// when running without CPU competition from other concurrent OCR jobs.
const OCR_PER_PAGE_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Run ocrmypdf on the whole PDF first (fast path, 3-minute cap).
 * If the whole-doc run times out, fall back to page-by-page OCR so we can
 * still extract text from the pages that Tesseract can handle.
 */
async function runOcrAndExtract(
  filePath: string,
  pdfParse: (buf: Buffer) => Promise<{ text: string; numpages: number }>,
): Promise<string> {
  const ocrOutputPath = filePath.replace(/\.pdf$/i, "_ocr.pdf");
  let wholeDocTimedOut = false;

  try {
    // --skip-text: skip pages that already have a text layer (no re-OCR on mixed docs)
    // --output-type pdf: standard PDF output
    // --jobs 1: single-threaded to avoid OOM on constrained production instances
    await execFileAsync("ocrmypdf", [
      "--skip-text",
      "--output-type", "pdf",
      "--quiet",
      "--jobs", "1",
      filePath,
      ocrOutputPath,
    ], {
      timeout: OCR_WHOLE_DOC_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });

    logger.info({ ocrOutputPath }, "ocrmypdf whole-doc completed successfully");
    const ocrBuf = await readFile(ocrOutputPath);
    const ocrData = await pdfParse(ocrBuf);
    return ocrData.text.trim();
  } catch (err) {
    const e = err as Record<string, unknown>;
    const isTimeout = e["killed"] === true || e["signal"] === "SIGKILL";
    if (isTimeout) {
      logger.warn({ filePath }, "Whole-doc OCR timed out after 3 minutes — falling back to page-by-page");
      wholeDocTimedOut = true;
    } else {
      throw err; // real error — let the caller handle it
    }
  } finally {
    unlink(ocrOutputPath).catch(() => {});
  }

  if (!wholeDocTimedOut) return "";

  // --- Page-by-page fallback ---
  return runOcrPageByPage(filePath, pdfParse);
}

/**
 * OCR one page at a time.  Pages that timeout or error are skipped; the rest
 * are concatenated.  Logs per-page progress so we can see how many pages
 * each document yields.
 */
async function runOcrPageByPage(
  filePath: string,
  pdfParse: (buf: Buffer) => Promise<{ text: string; numpages: number }>,
): Promise<string> {
  // Get page count from pdf-parse metadata (already available, no extra tool needed)
  let numPages = 1;
  try {
    const buf = await readFile(filePath);
    const meta = await pdfParse(buf);
    numPages = meta.numpages ?? 1;
  } catch {
    logger.warn({ filePath }, "pdf-parse metadata read failed — defaulting to 1 page for page-by-page OCR");
  }

  logger.info({ filePath, numPages }, "Starting page-by-page OCR");

  const texts: string[] = [];
  let successCount = 0;
  let skipCount = 0;

  for (let page = 1; page <= numPages; page++) {
    const pageOutputPath = filePath.replace(/\.pdf$/i, `_ocr_p${page}.pdf`);
    try {
      await execFileAsync("ocrmypdf", [
        "--skip-text",
        "--output-type", "pdf",
        "--quiet",
        "--jobs", "1",
        "--pages", String(page),
        filePath,
        pageOutputPath,
      ], {
        timeout: OCR_PER_PAGE_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });

      const ocrBuf = await readFile(pageOutputPath);
      const ocrData = await pdfParse(ocrBuf);
      const pageText = ocrData.text.trim();
      if (pageText.length > 0) {
        texts.push(pageText);
        successCount++;
      } else {
        skipCount++;
      }
    } catch (err) {
      const e = err as Record<string, unknown>;
      const isTimeout = e["killed"] === true || e["signal"] === "SIGKILL";
      logger.warn({ filePath, page, numPages, isTimeout },
        isTimeout ? "Page OCR timed out — skipping" : "Page OCR failed — skipping");
      skipCount++;
    } finally {
      unlink(pageOutputPath).catch(() => {});
    }
  }

  logger.info({ filePath, numPages, successCount, skipCount }, "Page-by-page OCR complete");
  return texts.join("\n\n");
}

async function extractSpreadsheet(filePath: string, ext: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const XLSX = require("xlsx") as typeof import("xlsx");
  const workbook = XLSX.readFile(filePath);
  const lines: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    lines.push(`=== Sheet: ${sheetName} ===`);
    lines.push(csv);
    lines.push("");
  }
  return lines.join("\n");
}

async function extractWord(filePath: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mammoth = require("mammoth") as typeof import("mammoth");
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value;
}

/**
 * Split text into overlapping chunks of ~600 characters.
 */
export function chunkText(text: string, chunkSize = 600, overlap = 100): string[] {
  const cleaned = text
    .replace(/\0/g, "")                       // strip null bytes (PostgreSQL rejects them)
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") // strip other non-printable control chars
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (cleaned.length <= chunkSize) {
    return [cleaned];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < cleaned.length) {
    let end = start + chunkSize;

    // Try to break at a paragraph or sentence boundary
    if (end < cleaned.length) {
      const paragraphBreak = cleaned.lastIndexOf("\n\n", end);
      const sentenceBreak = cleaned.lastIndexOf(". ", end);

      if (paragraphBreak > start + chunkSize / 2) {
        end = paragraphBreak + 2;
      } else if (sentenceBreak > start + chunkSize / 2) {
        end = sentenceBreak + 2;
      }
    }

    const chunk = cleaned.slice(start, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    start = end - overlap;
  }

  return chunks;
}
