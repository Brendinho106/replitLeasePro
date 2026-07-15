import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

// POST /api/verify-access — checks the app-level passphrase
// The passcode lives in ACCESS_PASSCODE env secret and never leaves the server.
router.post("/verify-access", (req, res) => {
  const { passcode } = req.body as { passcode?: string };
  const expected = process.env.ACCESS_PASSCODE;

  if (!expected) {
    // Server not configured — fail open in dev so we don't block local work
    res.json({ ok: true });
    return;
  }

  if (passcode && passcode.trim() === expected.trim()) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: "Invalid passphrase" });
  }
});

export default router;
