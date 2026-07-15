import { Router, type IRouter } from "express";
import multer from "multer";
import path from "path";
import { mkdir } from "fs/promises";
import { eq, sql, count } from "drizzle-orm";
import { db } from "@workspace/db";
import { documentsTable, chunksTable } from "@workspace/db";
import {
  ListDocumentsResponse,
  GetDocumentStatsResponse,
  GetDocumentParams,
  GetDocumentResponse,
  DeleteDocumentParams,
} from "@workspace/api-zod";
import { extractText, chunkText } from "../../lib/docProcessor";
import { logger } from "../../lib/logger";

const router: IRouter = Router();

const UPLOADS_DIR = path.join(process.cwd(), "uploads");

// Set up multer for file uploads
const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    await mkdir(UPLOADS_DIR, { recursive: true });
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, "_");
    const unique = `${Date.now()}_${base}${ext}`;
    cb(null, unique);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [".pdf", ".xlsx", ".xls", ".csv", ".docx", ".doc", ".txt"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${ext}`));
    }
  },
});

// POST /documents/upload — multipart file upload
router.post("/documents/upload", upload.single("file"), async (req, res): Promise<void> => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }

  const ext = path.extname(req.file.originalname).toLowerCase().replace(".", "");
  const [doc] = await db
    .insert(documentsTable)
    .values({
      filename: req.file.filename,
      originalName: req.file.originalname,
      fileType: ext,
      filePath: req.file.path,
      status: "pending",
    })
    .returning();

  // Process asynchronously (don't await)
  processDocument(doc.id, req.file.path, ext).catch((err) => {
    logger.error({ err, docId: doc.id }, "Document processing failed");
  });

  res.status(201).json(GetDocumentResponse.parse(doc));
});

// GET /documents — list all documents
router.get("/documents", async (_req, res): Promise<void> => {
  const docs = await db
    .select()
    .from(documentsTable)
    .orderBy(documentsTable.uploadedAt);
  res.json(ListDocumentsResponse.parse(docs));
});

// GET /documents/stats — portfolio stats
router.get("/documents/stats", async (_req, res): Promise<void> => {
  const [totals] = await db
    .select({
      totalDocuments: count(documentsTable.id),
    })
    .from(documentsTable);

  const statusCounts = await db.execute(sql`
    SELECT status, COUNT(*)::int as cnt FROM documents GROUP BY status
  `);

  const [chunkTotals] = await db
    .select({ totalChunks: count(chunksTable.id) })
    .from(chunksTable);

  const fileTypeCounts = await db.execute(sql`
    SELECT file_type as "fileType", COUNT(*)::int as count FROM documents GROUP BY file_type ORDER BY count DESC
  `);

  const byStatus: Record<string, number> = {};
  for (const row of statusCounts.rows as { status: string; cnt: number }[]) {
    byStatus[row.status] = row.cnt;
  }

  res.json(
    GetDocumentStatsResponse.parse({
      totalDocuments: totals.totalDocuments,
      readyDocuments: byStatus["ready"] ?? 0,
      processingDocuments: byStatus["processing"] ?? 0,
      errorDocuments: byStatus["error"] ?? 0,
      totalChunks: chunkTotals.totalChunks,
      fileTypeBreakdown: fileTypeCounts.rows,
    }),
  );
});

// GET /documents/:id — get single document
router.get("/documents/:id", async (req, res): Promise<void> => {
  const params = GetDocumentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [doc] = await db
    .select()
    .from(documentsTable)
    .where(eq(documentsTable.id, params.data.id));

  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  res.json(GetDocumentResponse.parse(doc));
});

// DELETE /documents/:id — delete document and chunks
router.delete("/documents/:id", async (req, res): Promise<void> => {
  const params = DeleteDocumentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [doc] = await db
    .delete(documentsTable)
    .where(eq(documentsTable.id, params.data.id))
    .returning();

  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  res.sendStatus(204);
});

/**
 * Process a document: extract text, chunk it, insert chunks.
 */
async function processDocument(docId: number, filePath: string, fileType: string): Promise<void> {
  await db
    .update(documentsTable)
    .set({ status: "processing" })
    .where(eq(documentsTable.id, docId));

  try {
    const text = await extractText(filePath, fileType);
    const chunks = chunkText(text);

    if (chunks.length > 0) {
      await db.insert(chunksTable).values(
        chunks.map((content, idx) => ({
          documentId: docId,
          content,
          chunkIndex: idx,
        })),
      );
    }

    await db
      .update(documentsTable)
      .set({
        status: "ready",
        chunkCount: chunks.length,
        processedAt: new Date(),
      })
      .where(eq(documentsTable.id, docId));

    logger.info({ docId, chunkCount: chunks.length }, "Document processed successfully");
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({ err, docId }, "Document processing error");

    await db
      .update(documentsTable)
      .set({ status: "error", errorMessage })
      .where(eq(documentsTable.id, docId));
  }
}

export default router;
