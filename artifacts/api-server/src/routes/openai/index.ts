import { Router, type IRouter } from "express";
import { eq, asc } from "drizzle-orm";
import { db } from "@workspace/db";
import { conversationsTable, messagesTable } from "@workspace/db";
import {
  ListOpenaiConversationsResponse,
  CreateOpenaiConversationBody,
  CreateOpenaiConversationResponse,
  GetOpenaiConversationParams,
  GetOpenaiConversationResponse,
  DeleteOpenaiConversationParams,
  ListOpenaiMessagesParams,
  ListOpenaiMessagesResponse,
  SendOpenaiMessageParams,
  SendOpenaiMessageBody,
} from "@workspace/api-zod";
import { searchChunks, buildContext } from "../../lib/ragSearch";
import { logger } from "../../lib/logger";
import OpenAI from "openai";

const router: IRouter = Router();

if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is required");
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are an expert commercial real estate attorney and lease analyst. Your sole purpose is to help the user review, analyze, and extract data from the provided commercial lease documents.

Follow these strict execution rules:
1. TRUTH TO SOURCE: Base your answers ONLY on the provided lease text snippets. If the answer cannot be found in the provided context, state clearly: "I cannot find that information in the provided lease documents." Do not make up assumptions.
2. CITATION REQUIREMENT: Whenever you cite a term, condition, or obligation, you must explicitly mention the section, section title, or page number if it is available in the text snippet (e.g., "Per Section 4.2 (Base Rent Escalation)...").
3. HANDLE AMBIGUITY: Commercial leases often have conflicting terms or amendments. If the context contains overlapping dates or conflicting terms, highlight both and flag it as a potential discrepancy for the user to review manually.
4. FORMATTING: Use bold text for key dates, financial figures, and entity names so they are highly scannable. Use bullet points or markdown tables for complex schedules (like rent step-ups or CAM calculations).
5. NO FORMAL LEGAL ADVICE DISCLAIMER: Do not clutter the chat with repetitive "I am an AI, not a lawyer" disclaimers on every single turn unless specifically asked for a legal opinion. The user knows your role. Focus entirely on extraction and analysis.`;

// GET /openai/conversations
router.get("/openai/conversations", async (_req, res): Promise<void> => {
  const convs = await db
    .select()
    .from(conversationsTable)
    .orderBy(asc(conversationsTable.createdAt));
  res.json(ListOpenaiConversationsResponse.parse(convs));
});

// POST /openai/conversations
router.post("/openai/conversations", async (req, res): Promise<void> => {
  const parsed = CreateOpenaiConversationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [conv] = await db
    .insert(conversationsTable)
    .values({ title: parsed.data.title })
    .returning();

  res.status(201).json(CreateOpenaiConversationResponse.parse(conv));
});

// GET /openai/conversations/:id
router.get("/openai/conversations/:id", async (req, res): Promise<void> => {
  const params = GetOpenaiConversationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [conv] = await db
    .select()
    .from(conversationsTable)
    .where(eq(conversationsTable.id, params.data.id));

  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  const msgs = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, params.data.id))
    .orderBy(asc(messagesTable.createdAt));

  res.json(
    GetOpenaiConversationResponse.parse({
      ...conv,
      messages: msgs,
    }),
  );
});

// DELETE /openai/conversations/:id
router.delete("/openai/conversations/:id", async (req, res): Promise<void> => {
  const params = DeleteOpenaiConversationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [conv] = await db
    .delete(conversationsTable)
    .where(eq(conversationsTable.id, params.data.id))
    .returning();

  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  res.sendStatus(204);
});

// GET /openai/conversations/:id/messages
router.get("/openai/conversations/:id/messages", async (req, res): Promise<void> => {
  const params = ListOpenaiMessagesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const msgs = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, params.data.id))
    .orderBy(asc(messagesTable.createdAt));

  res.json(ListOpenaiMessagesResponse.parse(msgs));
});

// POST /openai/conversations/:id/messages — RAG-powered streaming chat
router.post("/openai/conversations/:id/messages", async (req, res): Promise<void> => {
  const params = SendOpenaiMessageParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = SendOpenaiMessageBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const convId = params.data.id;
  const userContent = body.data.content;

  // Verify conversation exists
  const [conv] = await db
    .select()
    .from(conversationsTable)
    .where(eq(conversationsTable.id, convId));

  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  // Auto-title conversation based on first message
  if (conv.title === "New Chat" || conv.title === "") {
    const shortTitle =
      userContent.length > 50 ? userContent.slice(0, 50) + "..." : userContent;
    await db
      .update(conversationsTable)
      .set({ title: shortTitle })
      .where(eq(conversationsTable.id, convId));
  }

  // Save user message
  await db.insert(messagesTable).values({
    conversationId: convId,
    role: "user",
    content: userContent,
  });

  // Retrieve conversation history (last 10 messages for context)
  const history = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, convId))
    .orderBy(asc(messagesTable.createdAt));

  const recentHistory = history.slice(-10);

  // RAG: search for relevant chunks
  const relevantChunks = await searchChunks(userContent, 8);
  const context = buildContext(relevantChunks);

  req.log.info(
    { convId, chunkCount: relevantChunks.length },
    "RAG search complete",
  );

  // Build messages for LLM
  const chatMessages: OpenAI.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: `${SYSTEM_PROMPT}\n\n## Lease Document Context\n\n${context}`,
    },
    ...recentHistory.slice(0, -1).map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    { role: "user", content: userContent },
  ];

  // Set up SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let fullResponse = "";

  try {
    const stream = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 4096,
      messages: chatMessages,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        fullResponse += content;
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }

    // Save assistant message
    await db.insert(messagesTable).values({
      conversationId: convId,
      role: "assistant",
      content: fullResponse,
    });

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch (err) {
    req.log.error({ err }, "OpenAI streaming error");
    res.write(`data: ${JSON.stringify({ error: "LLM error occurred" })}\n\n`);
  } finally {
    res.end();
  }
});

export default router;
