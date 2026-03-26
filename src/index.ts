import express from "express";
import cors from "cors";
import { authenticate, auditMiddleware } from "./middleware/auth";
import { templateRoutes } from "./routes/templates";
import { workflowRoutes } from "./routes/workflows";
import { matterRoutes } from "./routes/matters";
import { adminRoutes } from "./routes/admin";
import { engineRoutes } from "./routes/engine";
import { authRoutes } from "./routes/auth";

const app = express();
const PORT = parseInt(process.env.PORT || "8080");

// ── CORS ──
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests from configured origins + no-origin (Postman, add-in, etc.)
      const allowed = (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim());
      if (!origin || allowed.includes(origin) || allowed.includes("*")) {
        callback(null, true);
      } else {
        callback(null, true); // Permissive during development; tighten for production
      }
    },
    credentials: true,
  })
);

// ── Body parsing ──
app.use(express.json({ limit: "50mb" })); // Large for document XML payloads

// ── Health check (no auth) ──
app.get("/health", async (_req, res) => {
  let dbOk = false;
  let dbError = "";
  try {
    const { default: prisma } = await import("./lib/prisma");
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch (err: any) {
    dbError = err.message;
  }

  res.json({
    status: dbOk ? "healthy" : "degraded",
    service: "abbado-draft-api",
    version: "1.0.0",
    database: dbOk ? "connected" : `error: ${dbError}`,
    timestamp: new Date().toISOString(),
  });
});

// ── Auth routes (register + accept-invite are public, sync + me require auth) ──
app.use("/api/auth", authRoutes);

// ── Protected routes (all require auth) ──
app.use("/api/templates", authenticate, auditMiddleware, templateRoutes);
app.use("/api/workflows", authenticate, auditMiddleware, workflowRoutes);
app.use("/api/matters", authenticate, auditMiddleware, matterRoutes);
app.use("/api/admin", authenticate, auditMiddleware, adminRoutes);
app.use("/api/engine", authenticate, auditMiddleware, engineRoutes);

// ── Activity feed (cross-cutting, any authenticated user) ──
app.get("/api/activity", authenticate, async (req, res) => {
  try {
    const { default: prisma } = await import("./lib/prisma");
    const orgId = req.auth!.orgId;
    const { matterId } = req.query;

    const where: any = { orgId };
    if (matterId) where.matterId = matterId;

    const entries = await prisma.activityEntry.findMany({
      where,
      orderBy: { timestamp: "desc" },
      take: Number(req.query.limit) || 50,
    });

    res.json(entries);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── 404 handler ──
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ── Error handler ──
app.use((err: any, _req: any, res: any, _next: any) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`🎵 Abbado Draft API running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Env: ${process.env.NODE_ENV || "development"}`);
});
