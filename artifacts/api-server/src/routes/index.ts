import { Router } from "express";
import healthRouter from "./health";
import documentsRouter from "./documents";
import openaiRouter from "./openai";

const router = Router();

router.use(healthRouter);
router.use(documentsRouter);
router.use(openaiRouter);

export default router;
