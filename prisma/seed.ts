import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding Abbado Draft database...");

  // Clean existing data
  await prisma.activityEntry.deleteMany();
  await prisma.auditLogEntry.deleteMany();
  await prisma.adapterSyncLog.deleteMany();
  await prisma.generationConflict.deleteMany();
  await prisma.editJournalEntry.deleteMany();
  await prisma.generatedDocument.deleteMany();
  await prisma.matter.deleteMany();
  await prisma.variable.deleteMany();
  await prisma.interviewSection.deleteMany();
  await prisma.workflowTemplate.deleteMany();
  await prisma.templateVersion.deleteMany();
  await prisma.template.deleteMany();
  await prisma.workflow.deleteMany();
  await prisma.storageAdapter.deleteMany();
  await prisma.webhook.deleteMany();
  await prisma.apiKey.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();

  // ── Organization ──
  const org = await prisma.organization.create({
    data: {
      name: "Founders Law",
      slug: "founders-law",
      plan: "pro",
      settings: {
        defaultDocMode: "live",
        autoOpenAddin: true,
      },
    },
  });
  console.log(`  ✓ Organization: ${org.name} (${org.id})`);

  // ── Users ──
  const admin = await prisma.user.create({
    data: {
      orgId: org.id,
      authId: "auth-placeholder-admin",
      name: "Neilton Meewes",
      email: "nmeewes@founderslaw.com",
      role: "admin",
    },
  });

  const editor = await prisma.user.create({
    data: {
      orgId: org.id,
      authId: "auth-placeholder-editor",
      name: "Matt McElwee",
      email: "matt@founderslaw.com",
      role: "editor",
    },
  });

  const user = await prisma.user.create({
    data: {
      orgId: org.id,
      authId: "auth-placeholder-user",
      name: "Associate Attorney",
      email: "associate@founderslaw.com",
      role: "user",
    },
  });
  console.log(`  ✓ Users: 3 created`);

  // ── Storage Adapter (local for now) ──
  const adapter = await prisma.storageAdapter.create({
    data: {
      orgId: org.id,
      adapterType: "local",
      name: "Abbado Draft Storage",
      isDefault: true,
      healthStatus: "healthy",
      lastHealthCheck: new Date(),
      config: { bucket: "draft-documents" },
    },
  });
  console.log(`  ✓ Storage adapter: ${adapter.name}`);

  // ── Templates ──
  const certTemplate = await prisma.template.create({
    data: {
      orgId: org.id,
      name: "Certificate of Incorporation",
      description: "Delaware Certificate of Incorporation template",
      format: "docx",
      category: "formation",
      parsedSchema: {
        variables: [
          { name: "company_name", type: "text", label: "Company Legal Name" },
          { name: "incorporation_date", type: "date", label: "Incorporation Date" },
          { name: "authorized_shares", type: "number", label: "Authorized Shares" },
          { name: "business_description", type: "text", label: "Business Description" },
          { name: "registered_agent", type: "dropdown", label: "Registered Agent" },
        ],
      },
    },
  });

  const bylawsTemplate = await prisma.template.create({
    data: {
      orgId: org.id,
      name: "Corporate Bylaws",
      description: "Standard corporate bylaws template",
      format: "docx",
      category: "formation",
      parsedSchema: {
        variables: [
          { name: "company_name", type: "text" },
          { name: "board_size", type: "number" },
          { name: "fiscal_year_end", type: "text" },
        ],
      },
    },
  });

  const spaTemplate = await prisma.template.create({
    data: {
      orgId: org.id,
      name: "Stock Purchase Agreement",
      description: "Restricted stock purchase agreement per founder",
      format: "docx",
      category: "formation",
      parsedSchema: {
        variables: [
          { name: "company_name", type: "text" },
          { name: "founders", type: "collection" },
        ],
      },
    },
  });

  const capTableTemplate = await prisma.template.create({
    data: {
      orgId: org.id,
      name: "Capitalization Table",
      description: "Cap table spreadsheet",
      format: "xlsx",
      category: "formation",
      parsedSchema: {
        variables: [
          { name: "company_name", type: "text" },
          { name: "authorized_shares", type: "number" },
          { name: "founders", type: "collection" },
        ],
      },
    },
  });

  console.log(`  ✓ Templates: 4 created`);

  // ── Workflow: Delaware Incorporation ──
  const workflow = await prisma.workflow.create({
    data: {
      orgId: org.id,
      name: "Delaware Incorporation",
      description: "Complete Delaware C-Corp incorporation package with certificate, bylaws, stock purchase agreements, and cap table",
      category: "formation",
    },
  });

  // Link templates to workflow
  await prisma.workflowTemplate.createMany({
    data: [
      { workflowId: workflow.id, templateId: certTemplate.id, displayOrder: 1 },
      { workflowId: workflow.id, templateId: bylawsTemplate.id, displayOrder: 2 },
      { workflowId: workflow.id, templateId: spaTemplate.id, displayOrder: 3 },
      { workflowId: workflow.id, templateId: capTableTemplate.id, displayOrder: 4 },
    ],
  });

  // ── Variables ──
  const variables = [
    // Company Information
    { name: "company_name", displayLabel: "Company Legal Name", type: "text", required: true, groupName: "Company Information", displayOrder: 1, helpText: "Include entity type (e.g., Acme Inc.)" },
    { name: "company_type", displayLabel: "Business Type", type: "dropdown", required: true, groupName: "Company Information", displayOrder: 2, validation: { options: ["Corporation", "Limited Liability Company"] } },
    { name: "incorporation_date", displayLabel: "Incorporation Date", type: "date", required: true, groupName: "Company Information", displayOrder: 3, defaultValue: null },
    { name: "business_description", displayLabel: "Business Description", type: "text", required: true, groupName: "Company Information", displayOrder: 4, helpText: "Max 35 characters", validation: { maxLength: 35 } },
    { name: "authorized_shares", displayLabel: "Total Authorized Shares", type: "number", required: true, groupName: "Company Information", displayOrder: 5, defaultValue: "10000000" },
    { name: "issued_shares", displayLabel: "Shares to Issue", type: "number", required: true, groupName: "Company Information", displayOrder: 6, defaultValue: "9000000" },
    { name: "board_size", displayLabel: "Board Size", type: "number", required: true, groupName: "Company Information", displayOrder: 7, defaultValue: "3" },
    { name: "fiscal_year_end", displayLabel: "Fiscal Year End", type: "text", required: true, groupName: "Company Information", displayOrder: 8, defaultValue: "December 31" },

    // Company Address
    { name: "company_street", displayLabel: "Street Address", type: "text", required: true, groupName: "Company Address", displayOrder: 1 },
    { name: "company_city", displayLabel: "City", type: "text", required: true, groupName: "Company Address", displayOrder: 2 },
    { name: "company_state", displayLabel: "State", type: "dropdown", required: true, groupName: "Company Address", displayOrder: 3 },
    { name: "company_zip", displayLabel: "ZIP Code", type: "text", required: true, groupName: "Company Address", displayOrder: 4 },

    // Registered Agent
    { name: "registered_agent", displayLabel: "Registered Agent", type: "dropdown", required: true, groupName: "Registered Agent", displayOrder: 1, defaultValue: "SingleFile", validation: { options: ["SingleFile", "Harvard Business Services", "Cogency Global", "Northwest Registered Agent", "Other"] } },

    // Incorporator
    { name: "incorporator_name", displayLabel: "Incorporator Name", type: "text", required: true, groupName: "Incorporator", displayOrder: 1 },
    { name: "incorporator_street", displayLabel: "Incorporator Address", type: "text", required: true, groupName: "Incorporator", displayOrder: 2 },
    { name: "incorporator_city", displayLabel: "City", type: "text", required: true, groupName: "Incorporator", displayOrder: 3 },
    { name: "incorporator_state", displayLabel: "State", type: "text", required: true, groupName: "Incorporator", displayOrder: 4 },
    { name: "incorporator_zip", displayLabel: "ZIP", type: "text", required: true, groupName: "Incorporator", displayOrder: 5 },

    // Officers
    { name: "ceo_name", displayLabel: "CEO Name", type: "text", required: true, groupName: "Officers", displayOrder: 1 },
    { name: "secretary_name", displayLabel: "Secretary Name", type: "text", required: true, groupName: "Officers", displayOrder: 2 },
    { name: "secretary_phone", displayLabel: "Secretary Phone", type: "phone", required: true, groupName: "Officers", displayOrder: 3 },

    // Founders (repeating)
    { name: "founders", displayLabel: "Founders", type: "text", required: true, groupName: "Founders", displayOrder: 0, helpText: "Add each founder with their details" },
    { name: "founders.$.name", displayLabel: "Founder Name", type: "text", required: true, groupName: "Founders", displayOrder: 1 },
    { name: "founders.$.email", displayLabel: "Email", type: "email", required: true, groupName: "Founders", displayOrder: 2 },
    { name: "founders.$.shares", displayLabel: "Number of Shares", type: "number", required: true, groupName: "Founders", displayOrder: 3 },
    { name: "founders.$.has_vesting", displayLabel: "Shares Vest?", type: "boolean", required: true, groupName: "Founders", displayOrder: 4, defaultValue: "true" },
    { name: "founders.$.vesting_months", displayLabel: "Vesting Duration (months)", type: "number", groupName: "Founders", displayOrder: 5, defaultValue: "48", condition: "founders.$.has_vesting == true" },
    { name: "founders.$.cliff_months", displayLabel: "Cliff Duration (months)", type: "number", groupName: "Founders", displayOrder: 6, defaultValue: "12", condition: "founders.$.has_vesting == true" },
    { name: "founders.$.is_board_member", displayLabel: "Board Member?", type: "boolean", groupName: "Founders", displayOrder: 7, defaultValue: "true" },
    { name: "founders.$.street", displayLabel: "Street Address", type: "text", required: true, groupName: "Founders", displayOrder: 8 },
    { name: "founders.$.city", displayLabel: "City", type: "text", required: true, groupName: "Founders", displayOrder: 9 },
    { name: "founders.$.state", displayLabel: "State", type: "text", required: true, groupName: "Founders", displayOrder: 10 },
    { name: "founders.$.zip", displayLabel: "ZIP", type: "text", required: true, groupName: "Founders", displayOrder: 11 },

    // Computed
    { name: "esop_shares", displayLabel: "ESOP Reserved Shares", type: "number", groupName: "Company Information", displayOrder: 9, isComputed: true, expression: "authorized_shares - issued_shares" },
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
        groupName: v.groupName,
        displayOrder: v.displayOrder,
        isComputed: v.isComputed || false,
        expression: v.expression || null,
      },
    });
  }
  console.log(`  ✓ Variables: ${variables.length} created for Delaware Incorporation`);

  // ── Interview Sections ──
  const sections = [
    { name: "Company Information", description: "Basic company details", displayOrder: 1 },
    { name: "Company Address", description: "Principal office address", displayOrder: 2 },
    { name: "Registered Agent", description: "Delaware registered agent", displayOrder: 3 },
    { name: "Incorporator", description: "Person filing the certificate", displayOrder: 4 },
    { name: "Founders", description: "Add each founder with their details and ownership", displayOrder: 5 },
    { name: "Officers", description: "CEO, Secretary, and other officers", displayOrder: 6 },
  ];

  for (const s of sections) {
    await prisma.interviewSection.create({
      data: { workflowId: workflow.id, ...s },
    });
  }
  console.log(`  ✓ Interview sections: ${sections.length} created`);
  console.log(`  ✓ Workflow: ${workflow.name} (${workflow.id})`);

  // ── Sample Matter ──
  const matter = await prisma.matter.create({
    data: {
      orgId: org.id,
      workflowId: workflow.id,
      name: "TechNova Inc. — Delaware Incorporation",
      status: "complete",
      createdBy: editor.id,
      completedAt: new Date(),
      variableValues: {
        company_name: "TechNova Inc.",
        company_type: "Corporation",
        incorporation_date: "2026-04-15",
        business_description: "AI healthcare analytics",
        authorized_shares: 10000000,
        issued_shares: 9000000,
        board_size: 3,
        fiscal_year_end: "December 31",
        company_street: "100 Innovation Drive",
        company_city: "San Francisco",
        company_state: "California",
        company_zip: "94107",
        registered_agent: "SingleFile",
        incorporator_name: "Sarah Chen",
        incorporator_street: "100 Innovation Drive",
        incorporator_city: "San Francisco",
        incorporator_state: "California",
        incorporator_zip: "94107",
        ceo_name: "Sarah Chen",
        secretary_name: "Sarah Chen",
        secretary_phone: "415-555-0100",
        founders: [
          { name: "Sarah Chen", email: "sarah@technova.io", shares: 4500000, has_vesting: true, vesting_months: 48, cliff_months: 12, is_board_member: true, street: "100 Innovation Drive", city: "San Francisco", state: "CA", zip: "94107" },
          { name: "James Park", email: "james@technova.io", shares: 3000000, has_vesting: true, vesting_months: 48, cliff_months: 12, is_board_member: true, street: "200 Tech Lane", city: "Palo Alto", state: "CA", zip: "94301" },
          { name: "Priya Patel", email: "priya@technova.io", shares: 1500000, has_vesting: true, vesting_months: 48, cliff_months: 12, is_board_member: true, street: "50 Startup Blvd", city: "Mountain View", state: "CA", zip: "94041" },
        ],
      },
    },
  });
  console.log(`  ✓ Sample matter: ${matter.name}`);

  // ── Activity entries ──
  await prisma.activityEntry.createMany({
    data: [
      { orgId: org.id, matterId: matter.id, activityType: "matter.created", actorId: editor.id, summary: "Matter created from Delaware Incorporation workflow" },
      { orgId: org.id, matterId: matter.id, activityType: "documents.generated", actorId: editor.id, summary: "Generated 4 documents in live mode" },
    ],
  });

  console.log("\n✅ Seed complete!");
  console.log(`   Org ID: ${org.id}`);
  console.log(`   Workflow ID: ${workflow.id}`);
  console.log(`   Matter ID: ${matter.id}`);
}

main()
  .catch((e) => {
    console.error("Seed error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
