import { Router } from "express";
import prisma from "../lib/prisma";
import { requireRole, getScope, auditLog } from "../middleware/auth";
import { supabase } from "../lib/supabase";

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

// ── Seed demo workflow (Delaware Incorporation) ──
workflowRoutes.post("/seed-demo", requireRole("editor"), async (req, res) => {
  try {
    const { orgId } = getScope(req);
    const fs = await import("fs");
    const path = await import("path");

    // ── Create workflow + sections + variables in a single transaction ──
    // (PgBouncer can route sequential queries to different connections,
    //  causing FK violations if the workflow isn't visible yet)
    const workflow = await prisma.$transaction(async (tx) => {
      const wf = await tx.workflow.create({
        data: {
          orgId,
          name: "Delaware Incorporation",
          description: "Complete workflow for incorporating a Delaware C-Corporation. Generates Certificate of Incorporation, Action of Incorporator, Initial Bylaws, Organizational Board Consent, SS-4 Authorization, and per-founder RSPA, EIACA, and 83(b) Election documents.",
          category: "Corporate Formation",
        },
      });

      // ── Interview Sections ──
      const sections = [
        { name: "Company Information", description: JSON.stringify({ section: "Company Details", text: "Basic information about the corporation being formed." }), displayOrder: 0 },
        { name: "Company Address", description: JSON.stringify({ section: "Company Details", text: "Principal office address for the corporation." }), displayOrder: 1 },
        { name: "Registered Agent", description: JSON.stringify({ section: "Company Details", text: "The registered agent receives legal documents on behalf of the corporation in Delaware." }), displayOrder: 2 },
        { name: "Stock Structure", description: JSON.stringify({ section: "Equity", text: "Define the authorized shares for the corporation." }), displayOrder: 3 },
        { name: "Founders", description: JSON.stringify({ section: "Equity", text: "Add each founder with their share allocation, vesting, and roles." }), displayOrder: 4 },
        { name: "Officers", description: JSON.stringify({ section: "Leadership", text: "Designate the CEO, Secretary, and any additional officers or directors." }), displayOrder: 5 },
        { name: "Incorporator", description: JSON.stringify({ section: "Filing", text: "The person who signs and files the Certificate of Incorporation." }), displayOrder: 6 },
        { name: "Designee", description: JSON.stringify({ section: "Filing", text: "Third-party designee authorized to apply for the EIN." }), displayOrder: 7 },
      ];

      for (const s of sections) {
        await tx.interviewSection.create({ data: { workflowId: wf.id, ...s } });
      }

    // ── Variables (interview questions + computed) ──
    const variables: any[] = [
      // ── Page 1: Company Information ──
      { name: "company_name", displayLabel: "Legal Name of the Corporation", type: "text", required: true, groupName: "Company Information", displayOrder: 0, helpText: "Include entity type (e.g., 'TechNova Inc.'). Must match exactly what will appear on the Certificate of Incorporation." },
      { name: "incorporation_date", displayLabel: "Incorporation Date", type: "date", required: true, groupName: "Company Information", displayOrder: 1, helpText: "Date the corporation will be formed. Default is typically 5 business days from today." },
      { name: "business_description", displayLabel: "Nature of Business", type: "text", required: true, groupName: "Company Information", displayOrder: 2, helpText: "Brief description of business activities. Maximum 35 characters. Example: 'AI healthcare data analytics'" },

      // ── Page 2: Company Address ──
      { name: "company_address", displayLabel: "Principal Office Address", type: "address", required: true, groupName: "Company Address", displayOrder: 10 },
      { name: "company_county", displayLabel: "County", type: "text", required: true, groupName: "Company Address", displayOrder: 11, helpText: "County where the principal office is located. Required for the SS-4." },

      // ── Page 3: Registered Agent ──
      { name: "agent_selection", displayLabel: "Registered Agent", type: "dropdown", required: true, groupName: "Registered Agent", displayOrder: 20, defaultValue: "SingleFile", validation: { options: ["SingleFile", "Harvard Business Services", "Cogency Global", "Northwest Registered Agent", "Other"] }, helpText: "Select a registered agent. Address auto-populates for all pre-defined options." },
      { name: "agent_name", displayLabel: "Registered Agent Name", type: "text", required: false, groupName: "Registered Agent", displayOrder: 21, helpText: "Only needed if 'Other' is selected above.", condition: JSON.stringify({ groupLogic: "all", groups: [{ logic: "all", negate: false, rules: [{ variable: "agent_selection", operator: "eq", value: "Other", negate: false }] }] }) },
      { name: "agent_address", displayLabel: "Registered Agent Address", type: "text", required: false, groupName: "Registered Agent", displayOrder: 22, helpText: "Full address in Delaware. Only needed if 'Other' is selected.", condition: JSON.stringify({ groupLogic: "all", groups: [{ logic: "all", negate: false, rules: [{ variable: "agent_selection", operator: "eq", value: "Other", negate: false }] }] }) },

      // ── Page 4: Stock Structure ──
      { name: "share_count", displayLabel: "Total Authorized Shares", type: "number", required: true, groupName: "Stock Structure", displayOrder: 30, defaultValue: "10000000", helpText: "Common for startups: 10,000,000. Typically 9M issued to founders and 1M reserved for ESOP." },

      // ── Page 5: Founders (repeating with conditional sub-questions) ──
      { name: "founders", displayLabel: "Founders", type: "repeating", required: true, groupName: "Founders", displayOrder: 40, validation: { itemLabel: "Founder", minItems: 1, maxItems: 10, subQuestions: [
        { field: "founder_name", label: "Full Legal Name", type: "text", required: true },
        { field: "founder_email", label: "Email Address", type: "email", required: true },
        { field: "founder_shares", label: "Number of Shares", type: "number", required: true },
        { field: "board_yn", label: "Board Member?", type: "boolean", required: true },
        { field: "founder_addroles_yn", label: "Additional Officer Roles?", type: "boolean", required: false },
        { field: "founder_position", label: "Officer Position", type: "text", required: false,
          condition: JSON.stringify({ groupLogic: "all", groups: [{ logic: "all", negate: false, rules: [{ variable: "founder_addroles_yn", operator: "eq", value: "true", negate: false }] }] }) },
        { field: "founder_vesting_schedule_yn", label: "Subject to Vesting?", type: "boolean", required: true },
        { field: "founder_vesting_schedule", label: "Vesting Schedule", type: "dropdown", required: false,
          validation: { options: ["Monthly, over 48 months with a 1-year cliff", "Monthly, over 48 months with no cliff", "Other"] },
          condition: JSON.stringify({ groupLogic: "all", groups: [{ logic: "all", negate: false, rules: [{ variable: "founder_vesting_schedule_yn", operator: "eq", value: "true", negate: false }] }] }) },
        { field: "founder_vesting_start", label: "Vesting Start Date", type: "date", required: false,
          condition: JSON.stringify({ groupLogic: "all", groups: [{ logic: "all", negate: false, rules: [{ variable: "founder_vesting_schedule_yn", operator: "eq", value: "true", negate: false }] }] }) },
        { field: "founder_vesting_recurrence", label: "Vesting Recurrence", type: "dropdown", required: false,
          validation: { options: ["Monthly", "Quarterly", "Semi-annually", "Annually"] },
          condition: JSON.stringify({ groupLogic: "all", groups: [{ logic: "all", negate: false, rules: [{ variable: "founder_vesting_schedule", operator: "eq", value: "Other", negate: false }] }] }) },
        { field: "founder_vesting_timeline", label: "Total Vesting (months)", type: "number", required: false,
          condition: JSON.stringify({ groupLogic: "all", groups: [{ logic: "all", negate: false, rules: [{ variable: "founder_vesting_schedule", operator: "eq", value: "Other", negate: false }] }] }) },
        { field: "founder_vesting_cliff_yn", label: "Cliff Period?", type: "boolean", required: false,
          condition: JSON.stringify({ groupLogic: "all", groups: [{ logic: "all", negate: false, rules: [{ variable: "founder_vesting_schedule", operator: "eq", value: "Other", negate: false }] }] }) },
        { field: "founder_vesting_cliff", label: "Cliff Duration (months)", type: "number", required: false,
          condition: JSON.stringify({ groupLogic: "all", groups: [{ logic: "all", negate: false, rules: [{ variable: "founder_vesting_cliff_yn", operator: "eq", value: "true", negate: false }] }] }) },
        { field: "founder_address", label: "Address", type: "address", required: true },
      ] } },
      // Flattened sub-question entries (for builder display)
      { name: "founders.$.founder_name", displayLabel: "Full Legal Name", type: "text", required: true, groupName: "Founders", displayOrder: 41 },
      { name: "founders.$.founder_email", displayLabel: "Email Address", type: "email", required: true, groupName: "Founders", displayOrder: 42 },
      { name: "founders.$.founder_shares", displayLabel: "Number of Shares", type: "number", required: true, groupName: "Founders", displayOrder: 43 },
      { name: "founders.$.board_yn", displayLabel: "Board Member?", type: "boolean", required: true, groupName: "Founders", displayOrder: 44 },
      { name: "founders.$.founder_addroles_yn", displayLabel: "Additional Officer Roles?", type: "boolean", required: false, groupName: "Founders", displayOrder: 45 },
      { name: "founders.$.founder_position", displayLabel: "Officer Position", type: "text", required: false, groupName: "Founders", displayOrder: 46, condition: JSON.stringify({ groupLogic: "all", groups: [{ logic: "all", negate: false, rules: [{ variable: "founder_addroles_yn", operator: "eq", value: "true", negate: false }] }] }) },
      { name: "founders.$.founder_vesting_schedule_yn", displayLabel: "Subject to Vesting?", type: "boolean", required: true, groupName: "Founders", displayOrder: 47 },
      { name: "founders.$.founder_vesting_schedule", displayLabel: "Vesting Schedule", type: "dropdown", required: false, groupName: "Founders", displayOrder: 48, validation: { options: ["Monthly, over 48 months with a 1-year cliff", "Monthly, over 48 months with no cliff", "Other"] }, condition: JSON.stringify({ groupLogic: "all", groups: [{ logic: "all", negate: false, rules: [{ variable: "founder_vesting_schedule_yn", operator: "eq", value: "true", negate: false }] }] }) },
      { name: "founders.$.founder_vesting_start", displayLabel: "Vesting Start Date", type: "date", required: false, groupName: "Founders", displayOrder: 49, condition: JSON.stringify({ groupLogic: "all", groups: [{ logic: "all", negate: false, rules: [{ variable: "founder_vesting_schedule_yn", operator: "eq", value: "true", negate: false }] }] }) },
      { name: "founders.$.founder_vesting_recurrence", displayLabel: "Vesting Recurrence", type: "dropdown", required: false, groupName: "Founders", displayOrder: 50, validation: { options: ["Monthly", "Quarterly", "Semi-annually", "Annually"] }, condition: JSON.stringify({ groupLogic: "all", groups: [{ logic: "all", negate: false, rules: [{ variable: "founder_vesting_schedule", operator: "eq", value: "Other", negate: false }] }] }) },
      { name: "founders.$.founder_vesting_timeline", displayLabel: "Total Vesting (months)", type: "number", required: false, groupName: "Founders", displayOrder: 51, condition: JSON.stringify({ groupLogic: "all", groups: [{ logic: "all", negate: false, rules: [{ variable: "founder_vesting_schedule", operator: "eq", value: "Other", negate: false }] }] }) },
      { name: "founders.$.founder_vesting_cliff_yn", displayLabel: "Cliff Period?", type: "boolean", required: false, groupName: "Founders", displayOrder: 52, condition: JSON.stringify({ groupLogic: "all", groups: [{ logic: "all", negate: false, rules: [{ variable: "founder_vesting_schedule", operator: "eq", value: "Other", negate: false }] }] }) },
      { name: "founders.$.founder_vesting_cliff", displayLabel: "Cliff Duration (months)", type: "number", required: false, groupName: "Founders", displayOrder: 53, condition: JSON.stringify({ groupLogic: "all", groups: [{ logic: "all", negate: false, rules: [{ variable: "founder_vesting_cliff_yn", operator: "eq", value: "true", negate: false }] }] }) },
      { name: "founders.$.founder_address", displayLabel: "Address", type: "address", required: true, groupName: "Founders", displayOrder: 54 },

      // ── Page 6: Officers ──
      { name: "company_ceo_name", displayLabel: "CEO Name", type: "text", required: true, groupName: "Officers", displayOrder: 60, helpText: "Usually a founder." },
      { name: "company_secretary_name", displayLabel: "Secretary Name", type: "text", required: true, groupName: "Officers", displayOrder: 61, helpText: "Usually a founder. Also signs the SS-4 Authorization." },
      { name: "company_secretary_phone", displayLabel: "Secretary Phone Number", type: "phone", required: true, groupName: "Officers", displayOrder: 62, helpText: "Required for the EIN application." },
      { name: "non_founder_officers_yn", displayLabel: "Any Non-Founder Officers?", type: "boolean", required: false, groupName: "Officers", displayOrder: 63 },
      { name: "non_founder_officers", displayLabel: "Non-Founder Officers", type: "repeating", required: false, groupName: "Officers", displayOrder: 64, condition: JSON.stringify({ groupLogic: "all", groups: [{ logic: "all", negate: false, rules: [{ variable: "non_founder_officers_yn", operator: "eq", value: "true", negate: false }] }] }), validation: { itemLabel: "Officer", minItems: 1, maxItems: 5, subQuestions: [
        { field: "officer_name", label: "Officer Name", type: "text", required: true },
        { field: "officer_role", label: "Officer Role", type: "text", required: true },
      ] } },
      { name: "non_founder_directors_yn", displayLabel: "Any Non-Founder Directors?", type: "boolean", required: false, groupName: "Officers", displayOrder: 65 },
      { name: "non_founder_directors", displayLabel: "Non-Founder Directors", type: "repeating", required: false, groupName: "Officers", displayOrder: 66, condition: JSON.stringify({ groupLogic: "all", groups: [{ logic: "all", negate: false, rules: [{ variable: "non_founder_directors_yn", operator: "eq", value: "true", negate: false }] }] }), validation: { itemLabel: "Director", minItems: 1, maxItems: 5, subQuestions: [
        { field: "nonfounderdirector_name", label: "Director Name", type: "text", required: true },
      ] } },

      // ── Page 7: Incorporator ──
      { name: "incorporator", displayLabel: "Incorporator Name", type: "text", required: true, groupName: "Incorporator", displayOrder: 70, helpText: "Usually the first founder or the CEO." },
      { name: "incorporator_address", displayLabel: "Incorporator Address", type: "address", required: true, groupName: "Incorporator", displayOrder: 71 },

      // ── Page 8: Designee ──
      { name: "has_designee", displayLabel: "Will a Third Party File for the EIN?", type: "boolean", required: false, groupName: "Designee", displayOrder: 80, defaultValue: "true", helpText: "Usually yes — the attorney is the designee." },
      { name: "designee", displayLabel: "Designee Name", type: "text", required: false, groupName: "Designee", displayOrder: 81, condition: JSON.stringify({ groupLogic: "all", groups: [{ logic: "all", negate: false, rules: [{ variable: "has_designee", operator: "eq", value: "true", negate: false }] }] }) },
      { name: "designee_company", displayLabel: "Designee Company", type: "text", required: false, groupName: "Designee", displayOrder: 82, condition: JSON.stringify({ groupLogic: "all", groups: [{ logic: "all", negate: false, rules: [{ variable: "has_designee", operator: "eq", value: "true", negate: false }] }] }) },
      { name: "designee_address", displayLabel: "Designee Address", type: "text", required: false, groupName: "Designee", displayOrder: 83, condition: JSON.stringify({ groupLogic: "all", groups: [{ logic: "all", negate: false, rules: [{ variable: "has_designee", operator: "eq", value: "true", negate: false }] }] }) },
      { name: "designee_phone", displayLabel: "Designee Phone", type: "text", required: false, groupName: "Designee", displayOrder: 84, condition: JSON.stringify({ groupLogic: "all", groups: [{ logic: "all", negate: false, rules: [{ variable: "has_designee", operator: "eq", value: "true", negate: false }] }] }) },

      // ── Computed / Hidden Variables ──
      // These are computed by preprocessValues() at generation time, not by the Logic tab formula evaluator
      { name: "all_directors_text", displayLabel: "Directors List (natural language)", type: "computed", isComputed: true, displayOrder: 200, validation: { logicType: "formula", formula: "Builds 'Name1, Name2, and Name3 are' from founders with board_yn + non-founder directors" }, expression: null },
      { name: "all_directors_count", displayLabel: "Director Count", type: "computed", isComputed: true, displayOrder: 201, validation: { logicType: "formula", formula: "count(directors)" }, expression: null },
      { name: "shares_to_issue", displayLabel: "Total Shares to Issue", type: "computed", isComputed: true, displayOrder: 202, validation: { logicType: "formula", formula: "sum(founders.$.founder_shares)" }, expression: null },
    ];

    for (const v of variables) {
      await tx.variable.create({
        data: {
          workflowId: wf.id,
          name: v.name,
          displayLabel: v.displayLabel,
          type: v.type,
          required: v.required || false,
          defaultValue: v.defaultValue || null,
          validation: v.validation || null,
          helpText: v.helpText || null,
          condition: v.condition || null,
          groupName: v.groupName || null,
          displayOrder: v.displayOrder,
          isComputed: v.isComputed || false,
          expression: v.expression || null,
        },
      });
    }

      return wf;
    }, { timeout: 30000 }); // end $transaction — 30s timeout for ~55 variable creates

    // ── Upload converted templates and link to workflow ──
    const ss4FieldMappings = [
      // Line 1: Legal name
      { pdfField: "1 Legal name of entity or individual for whom the EIN is being requested", value: "company_name", type: "variable" },
      // Line 3: Care of — designee
      { pdfField: "3 Executor administrator trustee care of name", value: "designee", type: "variable" },
      // Line 4a: Mailing address
      { pdfField: "4a Mailing address room apt suite no and street or PO box", value: "company_street_full", type: "variable" },
      // Line 4b: City, state, ZIP
      { pdfField: "4b City state and ZIP code if foreign see instructions", value: "company_city_state_zip", type: "variable" },
      // Line 6: County and state
      { pdfField: "6 County and state where principal business is located", value: "company_county_state", type: "variable" },
      // Line 7a: Responsible party (CEO)
      { pdfField: "7a Name of responsible party", value: "company_ceo_name", type: "variable" },
      // Line 8a: Is this for an LLC? — No
      { pdfField: "Check Box27", value: "false", type: "checkbox", checkedWhen: "false" },
      // Line 9a: Corporation checkbox
      { pdfField: "Check Box23", value: "true", type: "checkbox", checkedWhen: "true" },
      // Line 9a: Corporation form number (1120)
      { pdfField: "Type of entity check only one box Caution If 8a is Yes see the instructions for the correct box to check", value: "1120", type: "literal" },
      // Line 9b: State of incorporation
      { pdfField: "State", value: "Delaware", type: "literal" },
      // Line 10: Started new business — check the checkbox
      { pdfField: "Check Box29", value: "true", type: "checkbox", checkedWhen: "true" },
      // Line 10: Business type description
      { pdfField: "undefined_3", value: "business_description", type: "variable" },
      // Line 11: Date business started
      { pdfField: "11 Date business started or acquired month day year See instructions", value: "incorporation_date", type: "date", dateFormat: "short" },
      // Line 12: Closing month of accounting year
      { pdfField: "12 Closing month of accounting year", value: "December", type: "literal" },
      // Line 13: Employees — all zeros
      { pdfField: "Agricultural", value: "0", type: "literal" },
      { pdfField: "Household", value: "0", type: "literal" },
      { pdfField: "undefined_4", value: "0", type: "literal" },
      // Line 17: Principal line of merchandise/services
      { pdfField: "undefined_9", value: "business_description", type: "variable" },
      // Line 18: Has applicant ever applied for EIN? — No
      { pdfField: "undefined_14", value: "false", type: "checkbox", checkedWhen: "false" },
      // Third Party Designee
      { pdfField: "Designees name", value: "designee", type: "variable" },
      { pdfField: "Designees telephone number include area code", value: "designee_phone", type: "variable" },
      { pdfField: "Address and ZIP code", value: "designee_address", type: "variable" },
      // Applicant (Secretary) phone
      { pdfField: "Applicants telephone number include area code", value: "company_secretary_phone", type: "variable" },
      // Name and title line at bottom
      { pdfField: "Form SS4 Rev December 2023 Department of the Treasury Internal Revenue ServiceRow1", value: "company_secretary_name_title", type: "variable" },
    ];

    const templateFiles: { file: string; name: string; desc: string; order: number; repeatOver?: string; pdfFieldMappings?: any[] }[] = [
      { file: "certificate_of_incorporation.docx", name: "Certificate of Incorporation", desc: "Delaware C-Corp formation certificate", order: 1 },
      { file: "action_of_incorporator.docx", name: "Action of Incorporator", desc: "Written consent appointing initial directors", order: 2 },
      { file: "initial_bylaws.docx", name: "Initial Bylaws", desc: "Corporation bylaws adopted at formation", order: 3 },
      { file: "organizational_board_consent.docx", name: "Organizational Board Consent", desc: "Board resolution authorizing officers, stock issuance, and initial actions", order: 4 },
      { file: "ss4_authorization.docx", name: "SS-4 Authorization", desc: "Authorization for third-party designee to apply for EIN", order: 5 },
      { file: "form_ss4.pdf", name: "Form SS-4", desc: "IRS Application for Employer Identification Number — auto-filled PDF form", order: 6, pdfFieldMappings: ss4FieldMappings },
      { file: "founder_rspa.docx", name: "Founder RSPA", desc: "Restricted Stock Purchase Agreement — generated per founder", order: 7, repeatOver: "founders" },
      { file: "founder_eiaca.docx", name: "Founder EIACA", desc: "Employee Invention Assignment & Confidentiality Agreement — generated per founder", order: 8, repeatOver: "founders" },
      { file: "founder_83b.docx", name: "83(b) Election", desc: "IRS Section 83(b) election form — generated per founder", order: 9, repeatOver: "founders" },
    ];

    const { parseTemplate } = await import("../engines/word");
    const { parsePdfFields } = await import("../engines/pdf");

    for (const tmpl of templateFiles) {
      // Read template from bundled templates directory
      const templatePath = path.resolve(__dirname, "../../templates", tmpl.file);
      let buffer: Buffer;
      try {
        buffer = fs.readFileSync(templatePath);
      } catch {
        // If template file not found, skip it with a warning
        console.warn(`Template file not found: ${templatePath}`);
        continue;
      }

      const format = tmpl.file.endsWith(".pdf") ? "pdf" : "docx";
      const contentType = format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      const storagePath = `templates/${orgId}/${workflow.id}/${tmpl.file}`;
      const schema = format === "pdf"
        ? { format: "pdf", fields: await parsePdfFields(buffer) }
        : await parseTemplate(buffer);

      await supabase.storage.from("draft-documents").upload(storagePath, buffer, {
        contentType,
        upsert: true,
      });

      const template = await prisma.template.create({
        data: {
          orgId,
          name: tmpl.name,
          description: tmpl.desc,
          format,
          filePath: storagePath,
          parsedSchema: schema as any,
        },
      });

      await prisma.templateVersion.create({
        data: {
          templateId: template.id,
          versionNumber: 1,
          filePath: storagePath,
          fileHash: "",
          parsedSchema: schema as any,
          changeNote: "Converted from Gavel template",
          createdBy: req.auth!.userId,
        },
      });

      // Link to workflow with optional repeatOver and pdfFieldMappings
      const variableMapping: any = {};
      if (tmpl.repeatOver) variableMapping.repeatOver = tmpl.repeatOver;
      if (tmpl.pdfFieldMappings) variableMapping.pdfFieldMappings = tmpl.pdfFieldMappings;

      await prisma.workflowTemplate.create({
        data: {
          workflowId: workflow.id,
          templateId: template.id,
          displayOrder: tmpl.order,
          variableMapping: Object.keys(variableMapping).length > 0 ? variableMapping : {},
        },
      });
    }

    res.status(201).json({
      workflow,
      message: `Demo workflow "Delaware Incorporation" created with 8 interview pages, ${variables.length} questions/variables, and ${templateFiles.length} document templates (including 3 per-founder + SS-4 PDF). Delete existing demo workflows first if re-seeding.`,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Delete workflow ──
workflowRoutes.delete("/:id", requireRole("editor"), async (req, res) => {
  try {
    const { orgId } = getScope(req);

    const workflow = await prisma.workflow.findFirst({
      where: { id: req.params.id, orgId },
      include: { _count: { select: { matters: true } } },
    });

    if (!workflow) return res.status(404).json({ error: "Workflow not found" });

    if (workflow._count.matters > 0) {
      return res.status(400).json({
        error: `Cannot delete: ${workflow._count.matters} matter(s) use this workflow. Archive or delete the matters first.`,
      });
    }

    // Cascade: delete variables, sections, template links (not templates themselves)
    await prisma.$transaction([
      prisma.workflowTemplate.deleteMany({ where: { workflowId: workflow.id } }),
      prisma.variable.deleteMany({ where: { workflowId: workflow.id } }),
      prisma.interviewSection.deleteMany({ where: { workflowId: workflow.id } }),
      prisma.workflow.delete({ where: { id: workflow.id } }),
    ]);

    await auditLog(orgId, req.auth!.userId, "workflow.deleted", "workflow", workflow.id, { name: workflow.name });

    res.json({ deleted: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
