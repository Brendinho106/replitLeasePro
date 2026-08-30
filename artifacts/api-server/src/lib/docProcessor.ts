import { readFile, unlink } from "fs/promises";
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
  if (path.isAbsolute(filePath)) {
    return { localPath: filePath, cleanup: async () => {} };
  }

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

type PdfParseFn = (buf: Buffer) => Promise<{ text: string; numpages: number; info?: Record<string, unknown> }>;

// Minimum meaningful characters before we consider text extraction successful.
const MIN_TEXT_LENGTH = 100;

// Whole-doc OCR: scale with page count (Replit CPU is slower than desktop).
const OCR_MIN_WHOLE_DOC_MS = 8 * 60 * 1000;
const OCR_MAX_WHOLE_DOC_MS = 25 * 60 * 1000;
const OCR_MS_PER_PAGE = 45 * 1000;

// Page-by-page fallback: short per-page cap; abort if pages look restricted.
const OCR_PER_PAGE_TIMEOUT_MS = 2 * 60 * 1000;
const OCR_MAX_CONSECUTIVE_PAGE_FAILURES = 3;

function isGarbageText(text: string): boolean {
  const runs = text.match(/(.)\1{4,}/g) ?? [];
  const runCharCount = runs.reduce((sum, r) => sum + r.length, 0);
  return runCharCount / text.length > 0.25;
}

/** Heuristic: vector-only PDFs (Print-to-PDF) need --force-ocr; image scans use --skip-text. */
async function pdfLikelyNeedsForceOcr(
  filePath: string,
  pdfParse: PdfParseFn,
): Promise<boolean> {
  const buf = await readFile(filePath);
  const sample = buf.subarray(0, Math.min(buf.length, 2_000_000));
  const hasFont = sample.includes(Buffer.from("/Font"));
  const hasImage =
    sample.includes(Buffer.from("/Subtype /Image")) ||
    sample.includes(Buffer.from("/Subtype/Image"));

  try {
    const meta = await pdfParse(buf);
    const producer = String(meta.info?.Producer ?? meta.info?.producer ?? "").toLowerCase();
    const creator = String(meta.info?.Creator ?? meta.info?.creator ?? "").toLowerCase();
    if (producer.includes("print to pdf") || creator.includes("print to pdf")) {
      return true;
    }
  } catch {
    /* metadata optional */
  }

  // Vector-only: images absent, no font dictionary — ocrmypdf --skip-text will skip every page.
  if (!hasFont && !hasImage) return true;
  // Image-only scan: force-ocr is fine but skip-text is faster; prefer skip-text first.
  return false;
}

function wholeDocOcrTimeoutMs(numPages: number): number {
  const scaled = numPages * OCR_MS_PER_PAGE;
  return Math.min(OCR_MAX_WHOLE_DOC_MS, Math.max(OCR_MIN_WHOLE_DOC_MS, scaled));
}

function ocrArgs(mode: "skip-text" | "force-ocr"): string[] {
  const base = [
    mode === "force-ocr" ? "--force-ocr" : "--skip-text",
    "--deskew",
    "--rotate-pages",
    "-l",
    "eng",
    "--optimize",
    "1",
    "--output-type",
    "pdf",
    "--quiet",
    "--jobs",
    "1",
  ];
  return base;
}

export type ParsedDoc = {
  text: string;
  metadata: Record<string, string>;
};

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
  const pdfParse = require("pdf-parse") as PdfParseFn;

  const buf = await readFile(filePath);
  const data = await pdfParse(buf);
  const text = data.text.trim();

  if (text.length >= MIN_TEXT_LENGTH && !isGarbageText(text)) {
    return text;
  }

  const reason = text.length < MIN_TEXT_LENGTH ? "sparse text layer" : "garbage text detected";
  logger.info({ filePath, textLength: text.length, reason, pages: data.numpages }, "Running OCR");
  return runOcrAndExtract(filePath, pdfParse, data.numpages ?? 1);
}

async function runOcrWholeDoc(
  filePath: string,
  pdfParse: PdfParseFn,
  mode: "skip-text" | "force-ocr",
  timeoutMs: number,
): Promise<string> {
  const ocrOutputPath = filePath.replace(/\.pdf$/i, `_ocr_${mode}.pdf`);
  try {
    await execFileAsync("ocrmypdf", [...ocrArgs(mode), filePath, ocrOutputPath], {
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });

    logger.info({ ocrOutputPath, mode }, "ocrmypdf whole-doc completed");
    const ocrBuf = await readFile(ocrOutputPath);
    const ocrData = await pdfParse(ocrBuf);
    return ocrData.text.trim();
  } finally {
    unlink(ocrOutputPath).catch(() => {});
  }
}

/**
 * OCR pipeline aligned with the desktop LeasePro workflow:
 * 1. Try whole-doc (--skip-text for scans, or --force-ocr for vector Print-to-PDF)
 * 2. If text still sparse, retry whole-doc with --force-ocr
 * 3. If whole-doc times out, page-by-page with short per-page caps and early abort
 */
async function runOcrAndExtract(
  filePath: string,
  pdfParse: PdfParseFn,
  numPages: number,
): Promise<string> {
  const timeoutMs = wholeDocOcrTimeoutMs(numPages);
  const needsForce = await pdfLikelyNeedsForceOcr(filePath, pdfParse);
  const primaryMode: "skip-text" | "force-ocr" = needsForce ? "force-ocr" : "skip-text";

  logger.info({ filePath, numPages, timeoutMs, primaryMode }, "Starting whole-doc OCR");

  try {
    let text = await runOcrWholeDoc(filePath, pdfParse, primaryMode, timeoutMs);
    if (text.length >= MIN_TEXT_LENGTH && !isGarbageText(text)) {
      return text;
    }

    if (primaryMode === "skip-text") {
      logger.info({ filePath, textLength: text.length }, "Sparse OCR result — retrying with --force-ocr");
      text = await runOcrWholeDoc(filePath, pdfParse, "force-ocr", timeoutMs);
      if (text.length >= MIN_TEXT_LENGTH && !isGarbageText(text)) {
        return text;
      }
    }

    if (text.length > 0) {
      logger.warn({ filePath, textLength: text.length }, "OCR returned thin text — using page-by-page fallback");
      return runOcrPageByPage(filePath, pdfParse, numPages);
    }
  } catch (err) {
    const e = err as Record<string, unknown>;
    const isTimeout = e["killed"] === true || e["signal"] === "SIGKILL";
    if (isTimeout) {
      logger.warn(
        { filePath, timeoutMs, numPages },
        "Whole-doc OCR timed out — falling back to page-by-page",
      );
      return runOcrPageByPage(filePath, pdfParse, numPages);
    }
    throw err;
  }

  return runOcrPageByPage(filePath, pdfParse, numPages);
}

async function runOcrPageByPage(
  filePath: string,
  pdfParse: PdfParseFn,
  numPages: number,
): Promise<string> {
  logger.info({ filePath, numPages }, "Starting page-by-page OCR");

  const texts: string[] = [];
  let successCount = 0;
  let skipCount = 0;
  let consecutiveFailures = 0;
  const mode: "skip-text" | "force-ocr" = "force-ocr";

  for (let page = 1; page <= numPages; page++) {
    if (consecutiveFailures >= OCR_MAX_CONSECUTIVE_PAGE_FAILURES) {
      logger.warn(
        { filePath, page, numPages, consecutiveFailures },
        "Aborting page-by-page OCR — likely DocuSign/restricted PDF",
      );
      break;
    }

    const pageOutputPath = filePath.replace(/\.pdf$/i, `_ocr_p${page}.pdf`);
    try {
      await execFileAsync(
        "ocrmypdf",
        [...ocrArgs(mode), "--pages", String(page), filePath, pageOutputPath],
        {
          timeout: OCR_PER_PAGE_TIMEOUT_MS,
          killSignal: "SIGKILL",
        },
      );

      const ocrBuf = await readFile(pageOutputPath);
      const ocrData = await pdfParse(ocrBuf);
      const pageText = ocrData.text.trim();
      if (pageText.length > 0) {
        texts.push(pageText);
        successCount++;
        consecutiveFailures = 0;
      } else {
        skipCount++;
        consecutiveFailures++;
      }
    } catch (err) {
      const e = err as Record<string, unknown>;
      const isTimeout = e["killed"] === true || e["signal"] === "SIGKILL";
      logger.warn(
        { filePath, page, numPages, isTimeout },
        isTimeout ? "Page OCR timed out — skipping" : "Page OCR failed — skipping",
      );
      skipCount++;
      consecutiveFailures++;
    } finally {
      unlink(pageOutputPath).catch(() => {});
    }
  }

  logger.info({ filePath, numPages, successCount, skipCount }, "Page-by-page OCR complete");
  return texts.join("\n\n");
}

async function extractSpreadsheet(filePath: string, ext: string): Promise<string> {
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
  const mammoth = require("mammoth") as typeof import("mammoth");
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value;
}

export function chunkText(text: string, chunkSize = 600, overlap = 100): string[] {
  const cleaned = text
    .replace(/\0/g, "")
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
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
