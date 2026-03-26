import { Router } from "express";
import prisma from "../lib/prisma";
import { requireRole, getScope, auditLog } from "../middleware/auth";

export const matterRoutes = Router();

// ── List matters ──
matterRoutes.get("/", async (req, res) => {
  try {
    const { orgId } = getScope(req);
    const { workflowId, status, search } = req.query;

    const where: any = { orgId };
    if (workflowId) where.workflowId = workflowId;
    if (status) where.status = status;
    if (search) where.name = { contains: String(search), mode: "insensitive" };

    const matters = await prisma.matter.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      include: {
        workflow: { select: { id: true, name: true, category: true } },
        creator: { select: { id: true, name: true } },
        _count: { select: { generatedDocs: true } },
      },
      take: Number(req.query.page_size) || 50,
      skip: ((Number(req.query.page_number) || 1) - 1) * (Number(req.query.page_size) || 50),
    });

    const total = await prisma.matter.count({ where });

    res.json({ data: matters, total, page: Number(req.query.page_number) || 1 });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Get matter detail ──
matterRoutes.get("/:id", async (req, res) => {
  try {
    const { orgId } = getScope(req);

    const matter = await prisma.matter.findFirst({
      where: { id: req.params.id, orgId },
      include: {
        workflow: {
          include: {
            variables: { orderBy: [{ groupName: "asc" }, { displayOrder: "asc" }] },
          },
        },
        generatedDocs: {
          include: {
            template: { select: { id: true, name: true, format: true } },
            _count: { select: { editJournal: true, conflicts: true } },
          },
          orderBy: { generatedAt: "desc" },
        },
        creator: { select: { id: true, name: true } },
      },
    });

    if (!matter) return res.status(404).json({ error: "Matter not found" });

    res.json(matter);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Create matter ──
matterRoutes.post("/", requireRole("user"), async (req, res) => {
  try {
    const { orgId } = getScope(req);
    const { workflowId, name, prefillData } = req.body;

    if (!workflowId || !name) {
      return res.status(400).json({ error: "workflowId and name are required" });
    }

    // Verify workflow belongs to org
    const workflow = await prisma.workflow.findFirst({ where: { id: workflowId, orgId } });
    if (!workflow) return res.status(404).json({ error: "Workflow not found" });

    // Initialize variable values with defaults + prefill
    const variables = await prisma.variable.findMany({ where: { workflowId } });
    const initialValues: Record<string, any> = {};
    for (const v of variables) {
      if (v.defaultValue) initialValues[v.name] = v.defaultValue;
    }
    // Override with any prefill data (e.g., from Abbado entity data)
    if (prefillData && typeof prefillData === "object") {
      Object.assign(initialValues, prefillData);
    }

    const matter = await prisma.matter.create({
      data: {
        orgId,
        workflowId,
        name,
        status: "draft",
        variableValues: initialValues,
        createdBy: req.auth!.userId,
      },
      include: {
        workflow: { select: { id: true, name: true } },
      },
    });

    // Log activity
    await prisma.activityEntry.create({
      data: {
        orgId,
        matterId: matter.id,
        activityType: "matter.created",
        actorId: req.auth!.userId,
        summary: `Matter "${name}" created from workflow "${workflow.name}"`,
      },
    });

    await auditLog(orgId, req.auth!.userId, "matter.created", "matter", matter.id, { name, workflowId });

    res.status(201).json(matter);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Update variable values ──
matterRoutes.patch("/:id/variables", requireRole("user"), async (req, res) => {
  try {
    const { orgId } = getScope(req);
    const { variables, source } = req.body; // source: "interview" | "addin" | "api"

    if (!variables || typeof variables !== "object") {
      return res.status(400).json({ error: "variables object is required" });
    }

    const matter = await prisma.matter.findFirst({ where: { id: req.params.id, orgId } });
    if (!matter) return res.status(404).json({ error: "Matter not found" });

    // Merge new values into existing
    const currentValues = (matter.variableValues as Record<string, any>) || {};
    const updatedValues = { ...currentValues, ...variables };

    // Identify what changed
    const changes: Record<string, { from: any; to: any }> = {};
    for (const [key, value] of Object.entries(variables)) {
      if (JSON.stringify(currentValues[key]) !== JSON.stringify(value)) {
        changes[key] = { from: currentValues[key], to: value };
      }
    }

    if (Object.keys(changes).length === 0) {
      return res.json({ matter, changes: {}, message: "No changes detected" });
    }

    const updated = await prisma.matter.update({
      where: { id: matter.id },
      data: { variableValues: updatedValues, status: "in_progress" },
    });

    // Log activity
    await prisma.activityEntry.create({
      data: {
        orgId,
        matterId: matter.id,
        activityType: "variable.changed",
        actorId: req.auth!.userId,
        summary: `${Object.keys(changes).length} variable(s) updated via ${source || "api"}`,
        details: { changes, source },
      },
    });

    await auditLog(orgId, req.auth!.userId, "matter.variables_changed", "matter", matter.id, {
      changeCount: Object.keys(changes).length,
      source,
    });

    res.json({ matter: updated, changes });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Update interview state (save/resume) ──
matterRoutes.patch("/:id/interview-state", requireRole("user"), async (req, res) => {
  try {
    const { orgId } = getScope(req);
    const { interviewState } = req.body;

    const matter = await prisma.matter.updateMany({
      where: { id: req.params.id, orgId },
      data: { interviewState },
    });

    if (matter.count === 0) return res.status(404).json({ error: "Matter not found" });

    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Generate documents ──
// This endpoint triggers document generation for all templates in the workflow
// The actual generation logic will be in the Word/PDF/Excel engines
matterRoutes.post("/:id/generate", requireRole("user"), async (req, res) => {
  try {
    const { orgId } = getScope(req);
    const { mode } = req.body; // "live" (default) or "final"

    const matter = await prisma.matter.findFirst({
      where: { id: req.params.id, orgId },
      include: {
        workflow: {
          include: {
            templates: {
              include: { template: true },
              orderBy: { displayOrder: "asc" },
            },
          },
        },
      },
    });

    if (!matter) return res.status(404).json({ error: "Matter not found" });

    const generatedDocs = [];

    for (const wt of matter.workflow.templates) {
      // TODO: Call the appropriate engine based on template format
      // For now, create the generated document record as a placeholder
      const genDoc = await prisma.generatedDocument.create({
        data: {
          matterId: matter.id,
          templateId: wt.template.id,
          variableSnapshot: matter.variableValues as any,
          structuralTagRegistry: {}, // Will be populated by engine
          mode: mode || "live",
          generationHash: "", // Will be computed by engine
        },
      });

      generatedDocs.push({
        ...genDoc,
        templateName: wt.template.name,
        templateFormat: wt.template.format,
      });
    }

    // Update matter status
    await prisma.matter.update({
      where: { id: matter.id },
      data: { status: "complete", completedAt: new Date() },
    });

    // Log activity
    await prisma.activityEntry.create({
      data: {
        orgId,
        matterId: matter.id,
        activityType: "documents.generated",
        actorId: req.auth!.userId,
        summary: `Generated ${generatedDocs.length} document(s) in ${mode || "live"} mode`,
        details: { documentIds: generatedDocs.map((d) => d.id), mode: mode || "live" },
      },
    });

    await auditLog(orgId, req.auth!.userId, "matter.generated", "matter", matter.id, {
      documentCount: generatedDocs.length,
      mode: mode || "live",
    });

    res.json({ documents: generatedDocs });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Regenerate documents (after variable changes) ──
matterRoutes.post("/:id/regenerate", requireRole("user"), async (req, res) => {
  try {
    const { orgId } = getScope(req);

    const matter = await prisma.matter.findFirst({
      where: { id: req.params.id, orgId },
      include: {
        generatedDocs: {
          where: { mode: "live" },
          include: {
            template: true,
            editJournal: {
              where: { status: "active" },
              orderBy: { createdAt: "asc" },
            },
          },
        },
      },
    });

    if (!matter) return res.status(404).json({ error: "Matter not found" });

    const results = [];

    for (const doc of matter.generatedDocs) {
      // TODO: Full regeneration pipeline:
      // 1. Generate "Clean New" from template + new variables
      // 2. Replay edit journal: for each entry, find anchor tag → apply or drop
      // 3. Store result via storage adapter
      // 4. Create new version

      const appliedEdits: string[] = [];
      const droppedEdits: string[] = [];

      // For now, simulate the journal replay
      for (const entry of doc.editJournal) {
        // In the real engine, we'd check if the anchor tag exists in Clean New
        // For now, mark all as applied (placeholder)
        appliedEdits.push(entry.id);
      }

      // Update the generated document record
      await prisma.generatedDocument.update({
        where: { id: doc.id },
        data: {
          variableSnapshot: matter.variableValues as any,
          regeneratedAt: new Date(),
          regenerationCount: { increment: 1 },
        },
      });

      results.push({
        documentId: doc.id,
        templateName: doc.template.name,
        applied: appliedEdits.length,
        dropped: droppedEdits.length,
        droppedDetails: [], // Will contain { entryId, reason } in real implementation
      });
    }

    // Log activity
    await prisma.activityEntry.create({
      data: {
        orgId,
        matterId: matter.id,
        activityType: "documents.regenerated",
        actorId: req.auth!.userId,
        summary: `Regenerated ${results.length} document(s)`,
        details: { results },
      },
    });

    res.json({ results });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── List generated documents for a matter ──
matterRoutes.get("/:id/documents", async (req, res) => {
  try {
    const { orgId } = getScope(req);

    const matter = await prisma.matter.findFirst({ where: { id: req.params.id, orgId } });
    if (!matter) return res.status(404).json({ error: "Matter not found" });

    const docs = await prisma.generatedDocument.findMany({
      where: { matterId: matter.id },
      include: {
        template: { select: { id: true, name: true, format: true } },
        _count: { select: { editJournal: true, conflicts: true } },
      },
      orderBy: { generatedAt: "desc" },
    });

    res.json(docs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Edit journal: get entries for a document ──
matterRoutes.get("/:id/documents/:docId/journal", async (req, res) => {
  try {
    const entries = await prisma.editJournalEntry.findMany({
      where: { generatedDocumentId: req.params.docId },
      orderBy: { createdAt: "asc" },
      include: {
        creator: { select: { id: true, name: true } },
      },
    });

    res.json(entries);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Edit journal: append entry (from add-in) ──
matterRoutes.post("/:id/documents/:docId/journal", requireRole("user"), async (req, res) => {
  try {
    const { operationType, anchorTag, targetTag, contentXml, label } = req.body;

    if (!operationType || !anchorTag) {
      return res.status(400).json({ error: "operationType and anchorTag are required" });
    }

    const validOps = ["INSERT_AFTER", "INSERT_BEFORE", "MODIFY", "DELETE", "MOVE", "INSERT_TABLE_ROW", "MODIFY_CELL"];
    if (!validOps.includes(operationType)) {
      return res.status(400).json({ error: `operationType must be one of: ${validOps.join(", ")}` });
    }

    const entry = await prisma.editJournalEntry.create({
      data: {
        generatedDocumentId: req.params.docId,
        operationType,
        anchorTag,
        targetTag,
        contentXml,
        label,
        status: "active",
        createdBy: req.auth!.userId,
      },
    });

    res.status(201).json(entry);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Conflicts: list for a document ──
matterRoutes.get("/:id/documents/:docId/conflicts", async (req, res) => {
  try {
    const conflicts = await prisma.generationConflict.findMany({
      where: { generatedDocumentId: req.params.docId },
      orderBy: { createdAt: "desc" },
    });

    res.json(conflicts);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Conflicts: resolve ──
matterRoutes.patch("/:id/documents/:docId/conflicts/:conflictId", requireRole("user"), async (req, res) => {
  try {
    const { resolution } = req.body; // accept, reject, manual_fix

    const conflict = await prisma.generationConflict.update({
      where: { id: req.params.conflictId },
      data: {
        resolved: true,
        resolvedBy: req.auth!.userId,
        resolvedAt: new Date(),
        resolution,
      },
    });

    res.json(conflict);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
