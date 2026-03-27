import prisma from "../lib/prisma";
import { supabase } from "../lib/supabase";
import { generateDocument } from "../engines/word";
import type { GenerationOptions } from "../engines/word";
import { evaluateLogicVariables, shouldGenerateDocument } from "./logic";

// ── Types ──

export interface GenerateAllResult {
  documents: {
    id: string;
    templateName: string;
    templateFormat: string;
    filePath: string | null;
    mode: string;
  }[];
  skipped: { templateId: string; templateName: string; reason: string }[];
  errors: { templateId: string; error: string }[];
}

// ── Generate all documents for a matter ──

export async function generateAllDocuments(
  matterId: string,
  orgId: string,
  userId: string,
  mode: "live" | "final" = "live"
): Promise<GenerateAllResult> {
  // Load matter with workflow, templates, AND workflow variables (for logic evaluation)
  const matter = await prisma.matter.findFirst({
    where: { id: matterId, orgId },
    include: {
      workflow: {
        include: {
          templates: {
            include: { template: true },
            orderBy: { displayOrder: "asc" },
          },
          variables: {
            orderBy: { displayOrder: "asc" },
          },
        },
      },
    },
  });

  if (!matter) throw new Error("Matter not found");

  const interviewValues = (matter.variableValues as Record<string, any>) || {};

  // ── Preprocess interview values ──
  const processed = preprocessValues(interviewValues, matter.workflow.variables);

  // ── Evaluate Logic tab hidden variables ──
  const computedValues = evaluateLogicVariables(
    matter.workflow.variables.map((v: any) => ({
      name: v.name,
      type: v.type,
      isComputed: v.isComputed,
      validation: v.validation,
      expression: v.expression,
    })),
    processed
  );

  // Merge: interview values + computed logic values
  const values = { ...processed, ...computedValues };

  const results: GenerateAllResult = { documents: [], skipped: [], errors: [] };

  for (const wt of matter.workflow.templates) {
    const template = wt.template;

    // ── Check document output condition ──
    const mapping = wt.variableMapping as any;
    const generateCondition = mapping?.generateCondition;
    if (!shouldGenerateDocument(generateCondition, values)) {
      results.skipped.push({
        templateId: template.id,
        templateName: template.name,
        reason: "Document condition not met",
      });
      continue;
    }

    try {
      if (template.format === "docx") {
        // Fetch template file from storage
        const templateBuffer = await fetchTemplateFile(template.filePath);

        if (!templateBuffer) {
          // No template file uploaded yet — create a placeholder record
          const genDoc = await prisma.generatedDocument.create({
            data: {
              matterId: matter.id,
              templateId: template.id,
              variableSnapshot: values,
              structuralTagRegistry: {},
              mode,
              generationHash: "",
            },
          });

          results.documents.push({
            id: genDoc.id,
            templateName: template.name,
            templateFormat: template.format,
            filePath: null,
            mode,
          });
          continue;
        }

        // Run the Word generation engine
        const options: GenerationOptions = {
          matterId: matter.id,
          workflowId: matter.workflowId,
          templateId: template.id,
          mode,
        };

        const genResult = await generateDocument(templateBuffer, values, options);

        // Store generated document in Supabase Storage
        const storagePath = `generated/${matter.id}/${template.id}/${mode}_${Date.now()}.docx`;
        const { error: uploadError } = await supabase.storage
          .from("draft-documents")
          .upload(storagePath, genResult.buffer, {
            contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            upsert: true,
          });

        if (uploadError) {
          throw new Error(`Storage upload failed: ${uploadError.message}`);
        }

        // Create database record
        const genDoc = await prisma.generatedDocument.create({
          data: {
            matterId: matter.id,
            templateId: template.id,
            filePath: storagePath,
            variableSnapshot: genResult.variableSnapshot,
            structuralTagRegistry: genResult.structuralTagRegistry,
            generationHash: genResult.generationHash,
            mode,
          },
        });

        results.documents.push({
          id: genDoc.id,
          templateName: template.name,
          templateFormat: template.format,
          filePath: storagePath,
          mode,
        });
      } else {
        // PDF and Excel engines — placeholder for now
        const genDoc = await prisma.generatedDocument.create({
          data: {
            matterId: matter.id,
            templateId: template.id,
            variableSnapshot: values,
            structuralTagRegistry: {},
            mode,
            generationHash: "",
          },
        });

        results.documents.push({
          id: genDoc.id,
          templateName: template.name,
          templateFormat: template.format,
          filePath: null,
          mode,
        });
      }
    } catch (err: any) {
      results.errors.push({
        templateId: template.id,
        error: err.message,
      });
    }
  }

  // Update matter status
  await prisma.matter.update({
    where: { id: matter.id },
    data: {
      status: "complete",
      completedAt: new Date(),
    },
  });

  // Log activity
  await prisma.activityEntry.create({
    data: {
      orgId,
      matterId: matter.id,
      activityType: "documents.generated",
      actorId: userId,
      summary: `Generated ${results.documents.length} document(s) in ${mode} mode`,
      details: {
        documentIds: results.documents.map((d) => d.id),
        errors: results.errors,
        mode,
      },
    },
  });

  return results;
}

// ── Regenerate documents after variable changes ──

export async function regenerateDocuments(
  matterId: string,
  orgId: string,
  userId: string
): Promise<{
  results: {
    documentId: string;
    templateName: string;
    applied: number;
    dropped: number;
    droppedDetails: { entryId: string; reason: string }[];
  }[];
}> {
  const matter = await prisma.matter.findFirst({
    where: { id: matterId, orgId },
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

  if (!matter) throw new Error("Matter not found");

  // Load workflow variables for preprocessing
  const wfVars = await prisma.variable.findMany({ where: { workflowId: matter.workflowId } });
  const rawValues = (matter.variableValues as Record<string, any>) || {};
  const values = preprocessValues(rawValues, wfVars);
  const results = [];

  for (const doc of matter.generatedDocs) {
    const appliedEntries: string[] = [];
    const droppedEntries: { entryId: string; reason: string }[] = [];

    if (doc.template.format === "docx" && doc.template.filePath) {
      try {
        // Fetch the original template
        const templateBuffer = await fetchTemplateFile(doc.template.filePath);

        if (templateBuffer) {
          // Generate "Clean New" from template + new variables
          const options: GenerationOptions = {
            matterId: matter.id,
            workflowId: matter.workflowId,
            templateId: doc.template.id,
            mode: "live",
          };

          const genResult = await generateDocument(templateBuffer, values, options);
          const newTagRegistry = genResult.structuralTagRegistry;

          // Replay edit journal
          for (const entry of doc.editJournal) {
            // Check if the anchor tag exists in the new document
            const anchorExists =
              entry.anchorTag in newTagRegistry ||
              Object.keys(newTagRegistry).some((k) => k === entry.anchorTag);

            if (anchorExists) {
              appliedEntries.push(entry.id);
              // In a full implementation, we would apply the XML edit here
              // For now, mark as applied
              await prisma.editJournalEntry.update({
                where: { id: entry.id },
                data: { status: "applied" },
              });
            } else {
              const reason = `Anchor tag "${entry.anchorTag}" no longer exists in regenerated document`;
              droppedEntries.push({ entryId: entry.id, reason });

              await prisma.editJournalEntry.update({
                where: { id: entry.id },
                data: { status: "dropped", dropReason: reason },
              });
            }
          }

          // Store regenerated document
          const storagePath = `generated/${matter.id}/${doc.template.id}/live_regen_${Date.now()}.docx`;
          await supabase.storage
            .from("draft-documents")
            .upload(storagePath, genResult.buffer, {
              contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              upsert: true,
            });

          // Update the generated document record
          await prisma.generatedDocument.update({
            where: { id: doc.id },
            data: {
              filePath: storagePath,
              variableSnapshot: genResult.variableSnapshot,
              structuralTagRegistry: genResult.structuralTagRegistry,
              generationHash: genResult.generationHash,
              regeneratedAt: new Date(),
              regenerationCount: { increment: 1 },
            },
          });
        }
      } catch (err: any) {
        console.error(`Regeneration error for doc ${doc.id}:`, err.message);
      }
    }

    results.push({
      documentId: doc.id,
      templateName: doc.template.name,
      applied: appliedEntries.length,
      dropped: droppedEntries.length,
      droppedDetails: droppedEntries,
    });
  }

  // Log activity
  await prisma.activityEntry.create({
    data: {
      orgId,
      matterId: matter.id,
      activityType: "documents.regenerated",
      actorId: userId,
      summary: `Regenerated ${results.length} document(s)`,
      details: { results },
    },
  });

  return { results };
}

// ── Helper: Fetch template file from storage ──

async function fetchTemplateFile(filePath: string | null): Promise<Buffer | null> {
  if (!filePath) return null;

  try {
    const { data, error } = await supabase.storage
      .from("draft-documents")
      .download(filePath);

    if (error || !data) return null;

    const arrayBuffer = await data.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch {
    return null;
  }
}

// ── Preprocess interview values for the engine ──

function preprocessValues(
  raw: Record<string, any>,
  variables: any[]
): Record<string, any> {
  const result: Record<string, any> = {};

  // Build a type map from workflow variables
  const typeMap: Record<string, string> = {};
  for (const v of variables) {
    typeMap[v.name] = v.type;
  }

  // First pass: copy all values and normalize types
  for (const [key, value] of Object.entries(raw)) {
    // Skip sub-question flat keys (Parent.$.field) — they'll be assembled below
    if (key.includes(".$.")) continue;

    if (typeMap[key] === "address" && typeof value === "object" && value !== null) {
      // Address: store both the object (for dot notation) and a formatted string
      result[key] = formatAddress(value);
      // Also store sub-fields for dot notation access: {{address.street}} etc.
      for (const [field, fieldVal] of Object.entries(value)) {
        result[`${key}.${field}`] = fieldVal;
      }
    } else if (typeMap[key] === "phone" && typeof value === "object" && value !== null) {
      // Phone: use formatted string
      result[key] = value.formatted || value.number || String(value);
      result[`${key}.number`] = value.number;
      result[`${key}.dialCode`] = value.dialCode;
      result[`${key}.countryCode`] = value.countryCode;
    } else if (typeMap[key] === "boolean" || typeof value === "boolean") {
      // Normalize booleans to string "true"/"false" for condition evaluation
      result[key] = value === true || value === "true" || value === "Yes" || value === "yes" ? "true" : "false";
    } else if (typeMap[key] === "date" && value) {
      // Format dates nicely
      try {
        const d = new Date(value);
        if (!isNaN(d.getTime())) {
          result[key] = d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
          result[`${key}_raw`] = value; // Keep ISO format too
        } else {
          result[key] = value;
        }
      } catch {
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }

  // Second pass: assemble repeating items from flat interview data
  // The interview stores repeating data as: { "founders_0_name": "John", "founders_0_shares": "1000", "founders_1_name": "Jane" }
  // Or possibly as: { "founders": [{name: "John", shares: 1000}] } if the interview sends it as an array
  for (const v of variables) {
    if (v.type !== "repeating") continue;

    const name = v.name;

    // Check if it's already an array (some interview implementations send arrays directly)
    if (Array.isArray(raw[name])) {
      result[name] = raw[name];
      continue;
    }

    // Try to assemble from indexed flat keys: founders_0_name, founders_1_name, etc.
    const items: Record<string, any>[] = [];
    const indexPattern = new RegExp(`^${name}_(\\d+)_(.+)$`);

    for (const [key, value] of Object.entries(raw)) {
      const match = key.match(indexPattern);
      if (match) {
        const idx = parseInt(match[1]);
        const field = match[2];
        while (items.length <= idx) items.push({});
        items[idx][field] = value;
      }
    }

    // Also try dot notation: founders.0.name
    const dotPattern = new RegExp(`^${name}\\.(\\d+)\\.(.+)$`);
    for (const [key, value] of Object.entries(raw)) {
      const match = key.match(dotPattern);
      if (match) {
        const idx = parseInt(match[1]);
        const field = match[2];
        while (items.length <= idx) items.push({});
        items[idx][field] = value;
      }
    }

    if (items.length > 0) {
      result[name] = items;
    } else if (!result[name]) {
      result[name] = []; // Empty array for {{#each}} to handle
    }
  }

  return result;
}

function formatAddress(addr: any): string {
  if (!addr || typeof addr !== "object") return String(addr || "");
  const parts: string[] = [];
  if (addr.street) parts.push(addr.street);
  if (addr.street2) parts.push(addr.street2);
  const cityStateZip: string[] = [];
  if (addr.city) cityStateZip.push(addr.city);
  if (addr.state) cityStateZip.push(addr.state);
  if (cityStateZip.length > 0) parts.push(cityStateZip.join(", "));
  if (addr.zip) parts.push(addr.zip);
  if (addr.country && addr.country !== "US") parts.push(addr.country);
  return parts.join(", ") || addr.formatted || "";
}
