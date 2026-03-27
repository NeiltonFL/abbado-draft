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

    // Create workflow
    const workflow = await prisma.workflow.create({
      data: {
        orgId,
        name: "Delaware Corporation Formation",
        description: "Complete workflow for incorporating a Delaware C-Corporation. Generates Certificate of Incorporation with conditional indemnification and repeating founder blocks.",
        category: "Corporate Formation",
        status: "active",
      },
    });

    // Create interview sections (pages)
    const sections = [
      { name: "Company Information", description: JSON.stringify({ section: "Company Details", text: "Basic information about the corporation being formed." }), displayOrder: 0 },
      { name: "Registered Agent", description: JSON.stringify({ section: "Company Details", text: "The registered agent receives legal documents on behalf of the corporation." }), displayOrder: 1 },
      { name: "Stock Structure", description: JSON.stringify({ section: "Equity", text: "Define the authorized shares and par value." }), displayOrder: 2 },
      { name: "Founders", description: JSON.stringify({ section: "Equity", text: "Add each founder and their share allocation." }), displayOrder: 3 },
      { name: "Additional Provisions", description: JSON.stringify({ section: "Legal", text: "Optional legal provisions for the certificate." }), displayOrder: 4 },
    ];

    for (const s of sections) {
      await prisma.interviewSection.create({
        data: { workflowId: workflow.id, ...s },
      });
    }

    // Create variables (questions)
    const variables = [
      // Company Information page
      { name: "company_name", displayLabel: "Legal Name of the Corporation", type: "text", required: true, groupName: "Company Information", displayOrder: 0, helpText: "Must match exactly what will appear on the Certificate of Incorporation." },
      { name: "state", displayLabel: "State of Incorporation", type: "state", required: true, groupName: "Company Information", displayOrder: 1, defaultValue: "DE" },
      { name: "business_purpose", displayLabel: "Nature of Business", type: "rich_text", required: true, groupName: "Company Information", displayOrder: 2, helpText: "Describe the business activities. For a broad purpose, use: 'any lawful act or activity for which corporations may be organized under the General Corporation Law of Delaware.'" },
      { name: "formation_date", displayLabel: "Formation Date", type: "date", required: true, groupName: "Company Information", displayOrder: 3 },

      // Registered Agent page
      { name: "registered_agent_name", displayLabel: "Registered Agent Name", type: "text", required: true, groupName: "Registered Agent", displayOrder: 10, helpText: "The person or company that will receive legal documents on behalf of the corporation in the state of incorporation." },
      { name: "registered_agent_address", displayLabel: "Registered Agent Address", type: "address", required: true, groupName: "Registered Agent", displayOrder: 11 },

      // Stock Structure page
      { name: "authorized_shares", displayLabel: "Total Authorized Shares", type: "number", required: true, groupName: "Stock Structure", displayOrder: 20, defaultValue: "10000000", helpText: "Common number for startups: 10,000,000", validation: { min: 1 } },
      { name: "par_value", displayLabel: "Par Value per Share ($)", type: "currency", required: true, groupName: "Stock Structure", displayOrder: 21, defaultValue: "0.0001", helpText: "Standard par value for Delaware corporations: $0.0001" },

      // Founders (repeating item + sub-questions)
      { name: "founders", displayLabel: "Founders", type: "repeating", required: true, groupName: "Founders", displayOrder: 30, validation: { itemLabel: "Founder", minItems: 1, maxItems: 10, subQuestions: [
        { field: "name", label: "Full Legal Name", type: "text", required: true },
        { field: "email", label: "Email Address", type: "email", required: true },
        { field: "title", label: "Title", type: "dropdown", required: false, validation: { options: ["CEO", "CTO", "COO", "CFO", "President", "Secretary", "Director", "Other"] } },
        { field: "shares", label: "Number of Shares", type: "number", required: true, validation: { min: 1 } },
        { field: "vesting", label: "Subject to Vesting?", type: "boolean", required: false },
        { field: "vesting_months", label: "Vesting Period (months)", type: "number", required: false, condition: JSON.stringify({ groupLogic: "all", groups: [{ logic: "all", negate: false, rules: [{ variable: "vesting", operator: "eq", value: "true", negate: false }] }] }) },
      ] } },
      // Sub-questions (flattened)
      { name: "founders.$.name", displayLabel: "Full Legal Name", type: "text", required: true, groupName: "Founders", displayOrder: 31 },
      { name: "founders.$.email", displayLabel: "Email Address", type: "email", required: true, groupName: "Founders", displayOrder: 32 },
      { name: "founders.$.title", displayLabel: "Title", type: "dropdown", required: false, groupName: "Founders", displayOrder: 33, validation: { options: ["CEO", "CTO", "COO", "CFO", "President", "Secretary", "Director", "Other"] } },
      { name: "founders.$.shares", displayLabel: "Number of Shares", type: "number", required: true, groupName: "Founders", displayOrder: 34, validation: { min: 1 } },
      { name: "founders.$.vesting", displayLabel: "Subject to Vesting?", type: "boolean", required: false, groupName: "Founders", displayOrder: 35 },
      { name: "founders.$.vesting_months", displayLabel: "Vesting Period (months)", type: "number", required: false, groupName: "Founders", displayOrder: 36, condition: JSON.stringify({ groupLogic: "all", groups: [{ logic: "all", negate: false, rules: [{ variable: "vesting", operator: "eq", value: "true", negate: false }] }] }) },

      // Additional Provisions page
      { name: "incorporator_name", displayLabel: "Incorporator Name", type: "text", required: true, groupName: "Additional Provisions", displayOrder: 40 },
      { name: "incorporator_address", displayLabel: "Incorporator Mailing Address", type: "text", required: true, groupName: "Additional Provisions", displayOrder: 41 },
      { name: "has_indemnification", displayLabel: "Include Indemnification Provision?", type: "boolean", required: false, groupName: "Additional Provisions", displayOrder: 42, helpText: "If yes, the Certificate will include a standard indemnification clause protecting directors and officers." },

      // Logic variables (hidden)
      { name: "entity_label", displayLabel: "Entity Label", type: "computed", isComputed: true, displayOrder: 100,
        validation: { logicType: "formula", formula: '{{company_name}}, a {{state}} corporation' }, expression: '{{company_name}}, a {{state}} corporation' },
      { name: "total_founder_shares", displayLabel: "Total Founder Shares", type: "computed", isComputed: true, displayOrder: 101,
        validation: { logicType: "formula", formula: 'sum(founders.$.shares)' }, expression: 'sum(founders.$.shares)' },
      { name: "founder_count_text", displayLabel: "Founder Count Text", type: "computed", isComputed: true, displayOrder: 102,
        validation: { logicType: "formula", formula: 'count(founders)' }, expression: 'count(founders)' },
    ];

    for (const v of variables) {
      await prisma.variable.create({
        data: {
          workflowId: workflow.id,
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

    // Generate and upload the sample template
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const b = "<w:rPr><w:b/></w:rPr>";
    const bLg = '<w:rPr><w:b/><w:sz w:val="36"/></w:rPr>';
    const bMd = '<w:rPr><w:b/><w:sz w:val="28"/></w:rPr>';
    const ctr = '<w:pPr><w:jc w:val="center"/></w:pPr>';
    const p = (text: string, bold?: boolean, center?: boolean) =>
      `<w:p>${center ? ctr : ""}<w:r>${bold ? b : ""}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

    const body = [
      `<w:p>${ctr}<w:r>${bLg}<w:t>CERTIFICATE OF INCORPORATION</w:t></w:r></w:p>`,
      `<w:p>${ctr}<w:r><w:t>of</w:t></w:r></w:p>`,
      `<w:p>${ctr}<w:r>${bMd}<w:t>{{company_name}}</w:t></w:r></w:p>`,
      "<w:p/>",
      p("ARTICLE I - NAME", true),
      p('The name of the corporation is {{company_name}} (the "Corporation").'),
      "<w:p/>",
      p("ARTICLE II - REGISTERED AGENT", true),
      p("The address of the registered office of the Corporation in the State of {{state}} is {{registered_agent_address}}. The name of the registered agent at such address is {{registered_agent_name}}."),
      "<w:p/>",
      p("ARTICLE III - PURPOSE", true),
      p("The purpose of the Corporation is to engage in {{business_purpose}}."),
      "<w:p/>",
      p("ARTICLE IV - AUTHORIZED STOCK", true),
      p("The total number of shares of stock which the Corporation shall have authority to issue is {{authorized_shares}} shares of Common Stock, each having a par value of ${{par_value}} per share."),
      "<w:p/>",
      p("ARTICLE V - INCORPORATOR", true),
      p("The name and mailing address of the incorporator is {{incorporator_name}}, {{incorporator_address}}."),
      "<w:p/>",
      p("{{#if has_indemnification}}"),
      p("ARTICLE VI - INDEMNIFICATION", true),
      p("The Corporation shall indemnify any person who was or is a party to any proceeding by reason of the fact that such person is or was a director or officer of the Corporation, to the fullest extent permitted by the General Corporation Law of the State of Delaware."),
      p("{{/if}}"),
      "<w:p/>",
      p("INITIAL STOCKHOLDERS", true),
      p("{{#each founders}}"),
      p("{{@index}}. {{this.name}} ({{this.title}}) - {{this.shares}} shares - {{this.email}}"),
      p("{{/each}}"),
      "<w:p/>",
      p("IN WITNESS WHEREOF, the undersigned incorporator has executed this Certificate of Incorporation on {{formation_date}}."),
      "<w:p/>", "<w:p/>",
      p("_____________________________"),
      p("{{incorporator_name}}, Incorporator"),
    ].join("");

    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${ns}><w:body>${body}</w:body></w:document>`;
    const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
    const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
    const wordRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';

    zip.file("[Content_Types].xml", contentTypes);
    zip.file("_rels/.rels", rels);
    zip.file("word/_rels/document.xml.rels", wordRels);
    zip.file("word/document.xml", documentXml);

    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

    // Upload template to storage
    const storagePath = `templates/${orgId}/${workflow.id}/cert_of_incorporation.docx`;
    const { parseTemplate } = await import("../engines/word");
    const schema = await parseTemplate(buffer);

    await supabase.storage.from("draft-documents").upload(storagePath, buffer, {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      upsert: true,
    });

    // Create template record
    const template = await prisma.template.create({
      data: {
        orgId,
        name: "Certificate of Incorporation",
        description: "Delaware C-Corporation formation document with conditional indemnification and founder listing",
        format: "docx",
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
        changeNote: "Auto-generated demo template",
        createdBy: req.auth!.userId,
      },
    });

    // Link template to workflow
    await prisma.workflowTemplate.create({
      data: {
        workflowId: workflow.id,
        templateId: template.id,
        displayOrder: 1,
      },
    });

    res.status(201).json({
      workflow,
      message: "Demo workflow created with 5 pages, 16 questions, 3 logic variables, 1 template (Certificate of Incorporation). Go to the workflow builder to explore, or create a matter to test generation.",
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
