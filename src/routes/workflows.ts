import { Router } from "express";
import prisma from "../lib/prisma";
import { requireRole, getScope, auditLog } from "../middleware/auth";

export const workflowRoutes = Router();

// ── List workflows ──
workflowRoutes.get("/", async (req, res) => {
  try {
    const { orgId } = getScope(req);
    const { category, search } = req.query;

    const where: any = { orgId, isActive: true };
    if (category) where.category = category;
    if (search) where.name = { contains: String(search), mode: "insensitive" };

    const workflows = await prisma.workflow.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      include: {
        _count: { select: { templates: true, variables: true, matters: true } },
      },
    });

    res.json(workflows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Get workflow with full detail ──
workflowRoutes.get("/:id", async (req, res) => {
  try {
    const { orgId } = getScope(req);

    const workflow = await prisma.workflow.findFirst({
      where: { id: req.params.id, orgId },
      include: {
        templates: {
          orderBy: { displayOrder: "asc" },
          include: { template: { select: { id: true, name: true, format: true, parsedSchema: true } } },
        },
        variables: { orderBy: [{ groupName: "asc" }, { displayOrder: "asc" }] },
        interviewSections: { orderBy: { displayOrder: "asc" } },
        _count: { select: { matters: true } },
      },
    });

    if (!workflow) return res.status(404).json({ error: "Workflow not found" });

    res.json(workflow);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Create workflow ──
workflowRoutes.post("/", requireRole("editor"), async (req, res) => {
  try {
    const { orgId } = getScope(req);
    const { name, description, category } = req.body;

    if (!name) return res.status(400).json({ error: "name is required" });

    const workflow = await prisma.workflow.create({
      data: { orgId, name, description, category },
    });

    await auditLog(orgId, req.auth!.userId, "workflow.created", "workflow", workflow.id, { name });

    res.status(201).json(workflow);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Update workflow ──
workflowRoutes.put("/:id", requireRole("editor"), async (req, res) => {
  try {
    const { orgId } = getScope(req);
    const { name, description, category } = req.body;

    const workflow = await prisma.workflow.updateMany({
      where: { id: req.params.id, orgId },
      data: { name, description, category },
    });
    if (workflow.count === 0) return res.status(404).json({ error: "Workflow not found" });

    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Add template to workflow ──
workflowRoutes.post("/:id/templates", requireRole("editor"), async (req, res) => {
  try {
    const { orgId } = getScope(req);
    const { templateId, displayOrder, variableMapping } = req.body;

    // Verify both workflow and template belong to this org
    const [workflow, template] = await Promise.all([
      prisma.workflow.findFirst({ where: { id: req.params.id, orgId } }),
      prisma.template.findFirst({ where: { id: templateId, orgId } }),
    ]);
    if (!workflow) return res.status(404).json({ error: "Workflow not found" });
    if (!template) return res.status(404).json({ error: "Template not found" });

    const wt = await prisma.workflowTemplate.create({
      data: {
        workflowId: workflow.id,
        templateId: template.id,
        displayOrder: displayOrder || 0,
        variableMapping,
      },
    });

    res.status(201).json(wt);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Remove template from workflow ──
workflowRoutes.delete("/:id/templates/:wtId", requireRole("editor"), async (req, res) => {
  try {
    await prisma.workflowTemplate.delete({ where: { id: req.params.wtId } });
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Update template variable mapping (includes document conditions) ──
workflowRoutes.patch("/:id/templates/:wtId/mapping", requireRole("editor"), async (req, res) => {
  try {
    const { variableMapping } = req.body;

    const wt = await prisma.workflowTemplate.update({
      where: { id: req.params.wtId },
      data: { variableMapping },
    });

    res.json(wt);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Update variables (bulk) ──
workflowRoutes.put("/:id/variables", requireRole("editor"), async (req, res) => {
  try {
    const { orgId } = getScope(req);
    const { variables } = req.body; // Array of variable objects

    if (!Array.isArray(variables)) {
      return res.status(400).json({ error: "variables must be an array" });
    }

    const workflow = await prisma.workflow.findFirst({ where: { id: req.params.id, orgId } });
    if (!workflow) return res.status(404).json({ error: "Workflow not found" });

    // Delete existing variables and replace with new set
    await prisma.$transaction([
      prisma.variable.deleteMany({ where: { workflowId: workflow.id } }),
      ...variables.map((v: any, i: number) =>
        prisma.variable.create({
          data: {
            workflowId: workflow.id,
            name: v.name,
            displayLabel: v.displayLabel || v.name,
            type: v.type || "text",
            required: v.required || false,
            defaultValue: v.defaultValue,
            validation: v.validation,
            helpText: v.helpText,
            condition: v.condition,
            groupName: v.groupName,
            displayOrder: v.displayOrder ?? i,
            isComputed: v.isComputed || false,
            expression: v.expression,
          },
        })
      ),
    ]);

    const updated = await prisma.variable.findMany({
      where: { workflowId: workflow.id },
      orderBy: [{ groupName: "asc" }, { displayOrder: "asc" }],
    });

    await auditLog(orgId, req.auth!.userId, "workflow.variables_updated", "workflow", workflow.id, {
      variableCount: variables.length,
    });

    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Get interview structure ──
workflowRoutes.get("/:id/interview", async (req, res) => {
  try {
    const { orgId } = getScope(req);

    const workflow = await prisma.workflow.findFirst({
      where: { id: req.params.id, orgId },
      include: {
        interviewSections: { orderBy: { displayOrder: "asc" } },
        variables: { orderBy: [{ groupName: "asc" }, { displayOrder: "asc" }] },
      },
    });

    if (!workflow) return res.status(404).json({ error: "Workflow not found" });

    // Group variables by section
    const sections = workflow.interviewSections.map((section) => ({
      ...section,
      variables: workflow.variables.filter((v) => v.groupName === section.name),
    }));

    // Variables without a matching section go into "Other"
    const ungrouped = workflow.variables.filter(
      (v) => !workflow.interviewSections.some((s) => s.name === v.groupName)
    );
    if (ungrouped.length > 0) {
      sections.push({
        id: "ungrouped",
        workflowId: workflow.id,
        name: "Other",
        description: null,
        displayOrder: 999,
        condition: null,
        variables: ungrouped,
      });
    }

    res.json({ workflowId: workflow.id, workflowName: workflow.name, sections });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Update interview sections ──
workflowRoutes.put("/:id/interview", requireRole("editor"), async (req, res) => {
  try {
    const { orgId } = getScope(req);
    const { sections } = req.body;

    const workflow = await prisma.workflow.findFirst({ where: { id: req.params.id, orgId } });
    if (!workflow) return res.status(404).json({ error: "Workflow not found" });

    await prisma.$transaction([
      prisma.interviewSection.deleteMany({ where: { workflowId: workflow.id } }),
      ...sections.map((s: any, i: number) =>
        prisma.interviewSection.create({
          data: {
            workflowId: workflow.id,
            name: s.name,
            description: s.description,
            displayOrder: s.displayOrder ?? i,
            condition: s.condition,
          },
        })
      ),
    ]);

    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Duplicate workflow ──
workflowRoutes.post("/:id/duplicate", requireRole("editor"), async (req, res) => {
  try {
    const { orgId } = getScope(req);
    const { name } = req.body;

    const source = await prisma.workflow.findFirst({
      where: { id: req.params.id, orgId },
      include: {
        templates: true,
        variables: true,
        interviewSections: true,
      },
    });
    if (!source) return res.status(404).json({ error: "Workflow not found" });

    const newWorkflow = await prisma.workflow.create({
      data: {
        orgId,
        name: name || `${source.name} (Copy)`,
        description: source.description,
        category: source.category,
      },
    });

    // Copy templates, variables, and sections
    await prisma.$transaction([
      ...source.templates.map((t) =>
        prisma.workflowTemplate.create({
          data: {
            workflowId: newWorkflow.id,
            templateId: t.templateId,
            displayOrder: t.displayOrder,
            variableMapping: t.variableMapping as any,
          },
        })
      ),
      ...source.variables.map((v) =>
        prisma.variable.create({
          data: {
            workflowId: newWorkflow.id,
            name: v.name,
            displayLabel: v.displayLabel,
            type: v.type,
            required: v.required,
            defaultValue: v.defaultValue,
            validation: v.validation as any,
            helpText: v.helpText,
            condition: v.condition,
            groupName: v.groupName,
            displayOrder: v.displayOrder,
            isComputed: v.isComputed,
            expression: v.expression,
          },
        })
      ),
      ...source.interviewSections.map((s) =>
        prisma.interviewSection.create({
          data: {
            workflowId: newWorkflow.id,
            name: s.name,
            description: s.description,
            displayOrder: s.displayOrder,
            condition: s.condition,
          },
        })
      ),
    ]);

    res.status(201).json(newWorkflow);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
