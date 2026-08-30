import { Router, type IRouter } from "express";
import multer from "multer";
import path from "path";
import { mkdir, unlink } from "fs/promises";
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
import { objectStorageClient } from "../../lib/objectStorage";

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

  // Upload to GCS so the file survives server restarts / redeploys.
  // Store a relative GCS key (e.g. "uploads/timestamp_name.pdf") as filePath.
  const gcsKey = `uploads/${req.file.filename}`;
  const bucketId = process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"];
  if (!bucketId) {
    res.status(500).json({ error: "Object storage not configured" });
    return;
  }

  try {
    await objectStorageClient
      .bucket(bucketId)
      .upload(req.file.path, { destination: gcsKey });
    logger.info({ gcsKey }, "File uploaded to GCS");
  } catch (err) {
    logger.error({ err }, "GCS upload failed");
    res.status(500).json({ error: "Failed to store file" });
    return;
  } finally {
    // Always remove the local temp copy — GCS is the source of truth
    unlink(req.file.path).catch(() => {});
  }

  const [doc] = await db
    .insert(documentsTable)
    .values({
      filename: req.file.filename,
      originalName: req.file.originalname,
      fileType: ext,
      filePath: gcsKey,   // GCS key, not local path
      status: "pending",
    })
    .returning();

  // Process asynchronously (don't await)
  processDocument(doc.id, gcsKey, ext).catch((err) => {
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

// GET /documents/:id/download — generate a signed GCS URL and redirect for download
router.get("/documents/:id/download", async (req, res): Promise<void> => {
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

  const bucketId = process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"];
  if (!bucketId) {
    res.status(500).json({ error: "Object storage not configured" });
    return;
  }

  // doc.filePath is a relative GCS key like "uploads/timestamp_name.pdf"
  const gcsKey = doc.filePath;
  const { Storage } = await import("@google-cloud/storage");
  const SIDECAR = "http://127.0.0.1:1106";
  const storage = new Storage({
    credentials: {
      audience: "replit",
      subject_token_type: "access_token",
      token_url: `${SIDECAR}/token`,
      type: "external_account",
      credential_source: {
        url: `${SIDECAR}/credential`,
        format: { type: "json", subject_token_field_name: "access_token" },
      },
      universe_domain: "googleapis.com",
    },
    projectId: "",
  });

  const signResp = await fetch(
    `${SIDECAR}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bucket_name: bucketId,
        object_name: gcsKey,
        method: "GET",
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!signResp.ok) {
    res.status(500).json({ error: "Failed to generate download URL" });
    return;
  }

  const { signed_url } = await signResp.json() as { signed_url: string };

  // Redirect — browser will follow and download the file
  res.redirect(302, signed_url);
});

// POST /documents/admin/register — re-register an existing GCS file as an error record
// Used to restore documents that were deleted from DB but whose GCS files still exist.
router.post("/documents/admin/register", async (req, res): Promise<void> => {
  const { gcsKey, originalName, fileType } = req.body as {
    gcsKey?: string;
    originalName?: string;
    fileType?: string;
  };
  if (!gcsKey || !originalName || !fileType) {
    res.status(400).json({ error: "gcsKey, originalName, and fileType are required" });
    return;
  }

  const filename = gcsKey.split("/").pop() ?? gcsKey;

  const [doc] = await db
    .insert(documentsTable)
    .values({
      filename,
      originalName,
      fileType,
      filePath: gcsKey,
      status: "error",
      errorMessage:
        "No readable text could be extracted. This PDF likely has content-extraction restrictions set by the signing platform (DocuSign/Adobe Sign). Open in Acrobat → Print → Save as PDF to remove restrictions, then re-upload.",
    })
    .returning();

  res.status(201).json({ id: doc.id, originalName: doc.originalName, status: doc.status });
});

// POST /documents/:id/reprocess — reset a failed/stuck document and retry
router.post("/documents/:id/reprocess", async (req, res): Promise<void> => {
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

  // Delete existing chunks so we start fresh
  await db.delete(chunksTable).where(eq(chunksTable.documentId, doc.id));

  // Reset to pending so the processor picks it up
  await db
    .update(documentsTable)
    .set({ status: "pending", errorMessage: null, chunkCount: 0 })
    .where(eq(documentsTable.id, doc.id));

  // Kick off processing immediately (don't await)
  processDocument(doc.id, doc.filePath, doc.fileType).catch((err) => {
    logger.error({ err, docId: doc.id }, "Reprocess failed");
  });

  res.json({ ok: true, message: "Reprocessing started" });
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
    const chunks = chunkText(text).filter((c) => c.trim().length > 20);

    if (chunks.length === 0) {
      await db
        .update(documentsTable)
        .set({
          status: "error",
          errorMessage:
            "No readable text could be extracted after OCR. Common causes: (1) DocuSign/Adobe Sign PDF with copy restrictions — open in Acrobat and Print to PDF to remove security; (2) image-only floor plan or drawing with no text; (3) corrupted upload. Re-upload a searchable PDF if possible.",
        })
        .where(eq(documentsTable.id, docId));
      logger.warn({ docId }, "Document produced no extractable text");
      return;
    }

    await db.insert(chunksTable).values(
      chunks.map((content, idx) => ({
        documentId: docId,
        content,
        chunkIndex: idx,
      })),
    );

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
