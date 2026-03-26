import { Router } from "express";
import prisma from "../lib/prisma";
import { requireRole, getScope, auditLog } from "../middleware/auth";

export const templateRoutes = Router();

// ── List templates ──
templateRoutes.get("/", async (req, res) => {
  try {
    const { orgId } = getScope(req);
    const { format, category, search } = req.query;

    const where: any = { orgId, isActive: true };
    if (format) where.format = format;
    if (category) where.category = category;
    if (search) where.name = { contains: String(search), mode: "insensitive" };

    const templates = await prisma.template.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      include: {
        _count: { select: { workflowTemplates: true, versions: true } },
      },
    });

    res.json(templates);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Get single template with parsed schema ──
templateRoutes.get("/:id", async (req, res) => {
  try {
    const { orgId } = getScope(req);

    const template = await prisma.template.findFirst({
      where: { id: req.params.id, orgId },
      include: {
        versions: { orderBy: { versionNumber: "desc" }, take: 10 },
        workflowTemplates: {
          include: { workflow: { select: { id: true, name: true } } },
        },
      },
    });

    if (!template) return res.status(404).json({ error: "Template not found" });

    res.json(template);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Upload new template ──
// Note: actual file upload goes to Supabase Storage first,
// then this endpoint records the metadata and triggers parsing
templateRoutes.post("/", requireRole("editor"), async (req, res) => {
  try {
    const { orgId } = getScope(req);
    const { name, description, format, filePath, fileHash, category, parsedSchema } = req.body;

    if (!name || !format) {
      return res.status(400).json({ error: "name and format are required" });
    }

    const template = await prisma.template.create({
      data: {
        orgId,
        name,
        description,
        format,
        filePath,
        fileHash,
        parsedSchema,
        category,
      },
    });

    // Create initial version record
    await prisma.templateVersion.create({
      data: {
        templateId: template.id,
        versionNumber: 1,
        filePath: filePath || "",
        fileHash: fileHash || "",
        parsedSchema,
        changeNote: "Initial upload",
        createdBy: req.auth!.userId,
      },
    });

    await auditLog(orgId, req.auth!.userId, "template.created", "template", template.id, { name, format });

    res.status(201).json(template);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Upload new version of a template ──
templateRoutes.put("/:id", requireRole("editor"), async (req, res) => {
  try {
    const { orgId } = getScope(req);
    const { filePath, fileHash, parsedSchema, changeNote } = req.body;

    const existing = await prisma.template.findFirst({
      where: { id: req.params.id, orgId },
    });
    if (!existing) return res.status(404).json({ error: "Template not found" });

    const newVersion = existing.version + 1;

    const [template] = await prisma.$transaction([
      prisma.template.update({
        where: { id: existing.id },
        data: {
          filePath,
          fileHash,
          parsedSchema,
          version: newVersion,
        },
      }),
      prisma.templateVersion.create({
        data: {
          templateId: existing.id,
          versionNumber: newVersion,
          filePath: filePath || "",
          fileHash: fileHash || "",
          parsedSchema,
          changeNote,
          createdBy: req.auth!.userId,
        },
      }),
    ]);

    await auditLog(orgId, req.auth!.userId, "template.updated", "template", existing.id, { version: newVersion });

    res.json(template);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Soft delete template ──
templateRoutes.delete("/:id", requireRole("editor"), async (req, res) => {
  try {
    const { orgId } = getScope(req);

    const template = await prisma.template.updateMany({
      where: { id: req.params.id, orgId },
      data: { isActive: false },
    });

    if (template.count === 0) return res.status(404).json({ error: "Template not found" });

    await auditLog(orgId, req.auth!.userId, "template.deleted", "template", req.params.id);

    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
