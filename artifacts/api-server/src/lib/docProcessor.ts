import { readFile, unlink } from "fs/promises";
import { createRequire } from "module";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { logger } from "./logger";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

// Minimum meaningful characters before we consider text extraction successful.
// Scanned PDFs typically return whitespace-only or near-empty strings.
const MIN_TEXT_LENGTH = 100;

export type ParsedDoc = {
  text: string;
  metadata: Record<string, string>;
};

/**
 * Extract text from a file based on its extension.
 */
export async function extractText(filePath: string, fileType: string): Promise<string> {
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
  const pdfParse = require("pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;

  const buf = await readFile(filePath);
  const data = await pdfParse(buf);
  const text = data.text.trim();

  // If the PDF has a usable text layer, return it directly
  if (text.length >= MIN_TEXT_LENGTH) {
    return text;
  }

  // Text layer is absent or too sparse — this is likely a scanned PDF.
  // Run ocrmypdf to add a text layer via Tesseract, then re-extract.
  logger.info({ filePath, textLength: text.length }, "Sparse text layer detected — running OCR");
  return runOcrAndExtract(filePath, pdfParse);
}

/**
 * Run ocrmypdf on a scanned PDF, then extract the resulting text.
 * Cleans up the temporary OCR'd file when done.
 */
async function runOcrAndExtract(
  filePath: string,
  pdfParse: (buf: Buffer) => Promise<{ text: string }>,
): Promise<string> {
  const ocrOutputPath = filePath.replace(/\.pdf$/i, "_ocr.pdf");

  try {
    // --skip-text: skip pages that already have a text layer (no re-OCR on mixed docs)
    // --output-type pdf: standard PDF output
    await execFileAsync("ocrmypdf", [
      "--skip-text",
      "--output-type", "pdf",
      "--quiet",
      filePath,
      ocrOutputPath,
    ]);

    logger.info({ ocrOutputPath }, "ocrmypdf completed successfully");

    const ocrBuf = await readFile(ocrOutputPath);
    const ocrData = await pdfParse(ocrBuf);
    return ocrData.text.trim();
  } finally {
    // Always clean up the temp file
    unlink(ocrOutputPath).catch(() => {/* ignore if it doesn't exist */});
  }
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
  const cleaned = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

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
