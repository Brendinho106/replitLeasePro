import app from "./app";
import { logger } from "./lib/logger";
import { db } from "@workspace/db";
import { documentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { extractText, chunkText } from "./lib/docProcessor";
import { chunksTable } from "@workspace/db";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Process any documents left in 'pending' state (e.g. from a previous crash,
  // or scanned PDFs that previously errored and have been reset for retry).
  processPendingDocuments().catch((e) =>
    logger.error({ err: e }, "Startup pending-document processing failed"),
  );
});

async function processPendingDocuments(): Promise<void> {
  // Also pick up any docs left in "processing" state — these were mid-flight
  // when the server was last killed (e.g. a publish/restart) and will never
  // self-recover unless we reset and retry them here.
  await db
    .update(documentsTable)
    .set({ status: "pending" })
    .where(eq(documentsTable.status, "processing"));

  const pending = await db
    .select()
    .from(documentsTable)
    .where(eq(documentsTable.status, "pending"));

  if (pending.length === 0) return;

  logger.info({ count: pending.length }, "Processing pending documents on startup");

  for (const doc of pending) {
    // Mark as processing immediately so concurrent restarts don't double-process
    await db
      .update(documentsTable)
      .set({ status: "processing" })
      .where(eq(documentsTable.id, doc.id));

    processOne(doc).catch((e) =>
      logger.error({ err: e, docId: doc.id }, "Startup processing error"),
    );
  }
}

async function processOne(doc: typeof documentsTable.$inferSelect): Promise<void> {
  try {
    const text = await extractText(doc.filePath, doc.fileType);
    const chunks = chunkText(text).filter((c) => c.trim().length > 20);

    if (chunks.length === 0) {
      await db
        .update(documentsTable)
        .set({
          status: "error",
          errorMessage:
            "No readable text could be extracted even after OCR. The file may be corrupted or use an unsupported encoding.",
        })
        .where(eq(documentsTable.id, doc.id));
      logger.warn({ docId: doc.id }, "Startup processing: no text extracted");
      return;
    }

    await db.insert(chunksTable).values(
      chunks.map((content, idx) => ({
        documentId: doc.id,
        content,
        chunkIndex: idx,
      })),
    );

    await db
      .update(documentsTable)
      .set({ status: "ready", chunkCount: chunks.length, processedAt: new Date() })
      .where(eq(documentsTable.id, doc.id));

    logger.info({ docId: doc.id, chunkCount: chunks.length }, "Startup processing complete");
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({ err, docId: doc.id }, "Startup processing error");
    await db
      .update(documentsTable)
      .set({ status: "error", errorMessage })
      .where(eq(documentsTable.id, doc.id));
  }
}
