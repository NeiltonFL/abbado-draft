import { Router } from "express";
import prisma from "../lib/prisma";
import { supabase } from "../lib/supabase";
import { requireRole, getScope, auditLog } from "../middleware/auth";
import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";

export const adminRoutes = Router();

// ════════════════════════════════════════════
// USERS
// ════════════════════════════════════════════

adminRoutes.get("/users", requireRole("admin"), async (req, res) => {
  try {
    const { orgId } = getScope(req);
    const users = await prisma.user.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
    });
    res.json(users);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

adminRoutes.post("/users/invite", requireRole("admin"), async (req, res) => {
  try {
    const { orgId } = getScope(req);
    const { email, name, role } = req.body;

    if (!email || !name || !role) {
      return res.status(400).json({ error: "email, name, and role are required" });
    }

    const validRoles = ["admin", "editor", "user", "viewer"];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${validRoles.join(", ")}` });
    }

    // Check for existing user
    const existing = await prisma.user.findFirst({ where: { orgId, email } });
    if (existing) return res.status(409).json({ error: "User with this email already exists" });

    // Create Supabase Auth user (they'll get an invite email)
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      email_confirm: false,
      user_metadata: { name, orgId, role },
    });

    if (authError) {
      return res.status(400).json({ error: `Auth error: ${authError.message}` });
    }

    // Create user record in our DB
    const user = await prisma.user.create({
      data: {
        orgId,
        authId: authData.user.id,
        name,
        email,
        role,
      },
    });

    // TODO: Send invite email via Resend

    await auditLog(orgId, req.auth!.userId, "user.invited", "user", user.id, { email, role });

    res.status(201).json(user);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

adminRoutes.patch("/users/:id", requireRole("admin"), async (req, res) => {
  try {
    const { orgId } = getScope(req);
    const { role, isActive, name } = req.body;

    const data: any = {};
    if (role) data.role = role;
    if (typeof isActive === "boolean") data.isActive = isActive;
    if (name) data.name = name;

    const user = await prisma.user.updateMany({
      where: { id: req.params.id, orgId },
      data,
    });

    if (user.count === 0) return res.status(404).json({ error: "User not found" });

    await auditLog(orgId, req.auth!.userId, "user.updated", "user", req.params.id, data);

    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ════════════════════════════════════════════
// STORAGE ADAPTERS
// ════════════════════════════════════════════

adminRoutes.get("/adapters", requireRole("admin"), async (req, res) => {
  try {
    const { orgId } = getScope(req);
    const adapters = await prisma.storageAdapter.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
    });
    // Don't expose raw config (may have credentials)
    const safe = adapters.map((a) => ({ ...a, config: a.config ? { type: (a.config as any).type || a.adapterType } : null }));
    res.json(safe);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

adminRoutes.post("/adapters", requireRole("admin"), async (req, res) => {
  try {
    const { orgId } = getScope(req);
    const { adapterType, name, config, isDefault } = req.body;

    if (!adapterType || !name) {
      return res.status(400).json({ error: "adapterType and name are required" });
    }

    // If setting as default, unset current default
    if (isDefault) {
      await prisma.storageAdapter.updateMany({
        where: { orgId, isDefault: true },
        data: { isDefault: false },
      });
    }

    const adapter = await prisma.storageAdapter.create({
      data: { orgId, adapterType, name, config, isDefault: isDefault || false },
    });

    await auditLog(orgId, req.auth!.userId, "adapter.created", "adapter", adapter.id, { adapterType, name });

    res.status(201).json(adapter);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

adminRoutes.post("/adapters/:id/health", requireRole("admin"), async (req, res) => {
  try {
    const { orgId } = getScope(req);

    const adapter = await prisma.storageAdapter.findFirst({ where: { id: req.params.id, orgId } });
    if (!adapter) return res.status(404).json({ error: "Adapter not found" });

    // TODO: Run actual health check based on adapter type
    const status = "healthy";

    await prisma.storageAdapter.update({
      where: { id: adapter.id },
      data: { lastHealthCheck: new Date(), healthStatus: status },
    });

    await prisma.adapterSyncLog.create({
      data: { adapterId: adapter.id, action: "health_check", status: "success" },
    });

    res.json({ status, checkedAt: new Date() });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ════════════════════════════════════════════
// API KEYS
// ════════════════════════════════════════════

adminRoutes.get("/api-keys", requireRole("admin"), async (req, res) => {
  try {
    const { orgId } = getScope(req);
    const keys = await prisma.apiKey.findMany({
      where: { orgId },
      select: { id: true, keyPrefix: true, name: true, scopes: true, expiresAt: true, isActive: true, lastUsedAt: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(keys);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

adminRoutes.post("/api-keys", requireRole("admin"), async (req, res) => {
  try {
    const { orgId } = getScope(req);
    const { name, scopes, expiresAt } = req.body;

    if (!name) return res.status(400).json({ error: "name is required" });

    // Generate a random API key
    const rawKey = `adk_${uuid().replace(/-/g, "")}`;
    const keyHash = await bcrypt.hash(rawKey, 10);
    const keyPrefix = rawKey.slice(0, 12);

    const apiKey = await prisma.apiKey.create({
      data: { orgId, keyHash, keyPrefix, name, scopes, expiresAt: expiresAt ? new Date(expiresAt) : null },
    });

    await auditLog(orgId, req.auth!.userId, "apikey.created", "apikey", apiKey.id, { name });

    // Return the raw key ONCE — it won't be retrievable later
    res.status(201).json({
      id: apiKey.id,
      key: rawKey,
      keyPrefix,
      name,
      scopes,
      expiresAt: apiKey.expiresAt,
      message: "Save this key — it will not be shown again.",
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

adminRoutes.delete("/api-keys/:id", requireRole("admin"), async (req, res) => {
  try {
    const { orgId } = getScope(req);
    await prisma.apiKey.updateMany({
      where: { id: req.params.id, orgId },
      data: { isActive: false },
    });

    await auditLog(orgId, req.auth!.userId, "apikey.revoked", "apikey", req.params.id);

    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ════════════════════════════════════════════
// WEBHOOKS
// ════════════════════════════════════════════

adminRoutes.get("/webhooks", requireRole("admin"), async (req, res) => {
  try {
    const { orgId } = getScope(req);
    const webhooks = await prisma.webhook.findMany({ where: { orgId }, orderBy: { createdAt: "desc" } });
    res.json(webhooks);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

adminRoutes.post("/webhooks", requireRole("admin"), async (req, res) => {
  try {
    const { orgId } = getScope(req);
    const { url, events } = req.body;

    if (!url || !events) return res.status(400).json({ error: "url and events are required" });

    const webhook = await prisma.webhook.create({
      data: { orgId, url, events },
    });

    res.status(201).json(webhook);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

adminRoutes.delete("/webhooks/:id", requireRole("admin"), async (req, res) => {
  try {
    const { orgId } = getScope(req);
    await prisma.webhook.deleteMany({ where: { id: req.params.id, orgId } });
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ════════════════════════════════════════════
// AUDIT LOG
// ════════════════════════════════════════════

adminRoutes.get("/audit", requireRole("admin"), async (req, res) => {
  try {
    const { orgId } = getScope(req);
    const { action, resourceType, userId, from, to } = req.query;

    const where: any = { orgId };
    if (action) where.action = { contains: String(action) };
    if (resourceType) where.resourceType = resourceType;
    if (userId) where.userId = userId;
    if (from) where.timestamp = { ...(where.timestamp || {}), gte: new Date(String(from)) };
    if (to) where.timestamp = { ...(where.timestamp || {}), lte: new Date(String(to)) };

    const entries = await prisma.auditLogEntry.findMany({
      where,
      orderBy: { timestamp: "desc" },
      take: Number(req.query.page_size) || 100,
      skip: ((Number(req.query.page_number) || 1) - 1) * (Number(req.query.page_size) || 100),
    });

    const total = await prisma.auditLogEntry.count({ where });

    res.json({ data: entries, total, page: Number(req.query.page_number) || 1 });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
