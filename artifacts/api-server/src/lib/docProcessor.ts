import { readFile } from "fs/promises";
import path from "path";
import { logger } from "./logger";

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
  // pdf-parse exports the function directly
  const pdfParseModule = await import("pdf-parse");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfParse = (pdfParseModule as any).default ?? pdfParseModule;
  const buf = await readFile(filePath);
  const data = await pdfParse(buf);
  return data.text;
}

async function extractSpreadsheet(filePath: string, ext: string): Promise<string> {
  const XLSX = (await import("xlsx")).default;
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
  const mammoth = await import("mammoth");
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
