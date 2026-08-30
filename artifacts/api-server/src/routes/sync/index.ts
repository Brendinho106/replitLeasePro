import { Router, type IRouter } from "express";
import { getSyncStatus, runSharePointSync, getDocumentTree } from "../../lib/sharePointSync";
import { logger } from "../../lib/logger";

const router: IRouter = Router();

/** GET /sync/status — SharePoint connection and stub/config state */
router.get("/sync/status", async (_req, res): Promise<void> => {
  const status = await getSyncStatus();
  res.json(status);
});

/** POST /sync/run — trigger SharePoint mirror sync (stub-safe until Azure is connected) */
router.post("/sync/run", async (_req, res): Promise<void> => {
  try {
    const result = await runSharePointSync();
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Sync run failed");
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/** GET /documents/tree — nested folder tree for SharePoint-style library UI */
router.get("/documents/tree", async (_req, res): Promise<void> => {
  const data = await getDocumentTree();
  res.json(data);
});

export default router;
