import prisma from "../lib/prisma";
import { supabase } from "../lib/supabase";
import { generateDocument } from "../engines/word";
import type { GenerationOptions } from "../engines/word";
import { fillPdfForm } from "../engines/pdf";
import type { PdfFieldMapping } from "../engines/pdf";
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

        // ── Per-item repeating: generate one document per collection item ──
        const repeatOver = mapping?.repeatOver as string | undefined;
        const items = repeatOver ? (values[repeatOver] as any[]) : null;
        const outputNameTemplate = mapping?.outputName as string | undefined;

        if (repeatOver && Array.isArray(items) && items.length > 0) {
          // Generate one document per item
          for (let idx = 0; idx < items.length; idx++) {
            const item = items[idx];
            // Merge: promote all item fields to top-level as "this.field"
            // and also as direct field names for backward compatibility
            const itemValues: Record<string, any> = {
              ...values,
              _currentItem: item,
              _currentIndex: idx,
            };
            // Promote item fields to top-level
            for (const [k, v] of Object.entries(item)) {
              itemValues[`this.${k}`] = v;
              // Also set as direct fields for templates that use {{founder_name}} etc.
              itemValues[k] = v;
            }

            const options: GenerationOptions = {
              matterId: matter.id,
              workflowId: matter.workflowId,
              templateId: template.id,
              mode,
            };

            const genResult = await generateDocument(templateBuffer, itemValues, options);

            // Resolve output name from template or fallback
            const displayName = resolveOutputName(outputNameTemplate, itemValues, template.name, item);
            const safeFileName = displayName.replace(/[^a-zA-Z0-9_\-. ]/g, "").replace(/\s+/g, "_").slice(0, 100);
            const storagePath = `generated/${matter.id}/${template.id}/${safeFileName}_${idx}_${Date.now()}.docx`;
            const { error: uploadError } = await supabase.storage
              .from("draft-documents")
              .upload(storagePath, genResult.buffer, {
                contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                upsert: true,
              });

            if (uploadError) {
              throw new Error(`Storage upload failed: ${uploadError.message}`);
            }

            const genDoc = await prisma.generatedDocument.create({
              data: {
                matterId: matter.id,
                templateId: template.id,
                filePath: storagePath,
                variableSnapshot: { ...genResult.variableSnapshot, _displayName: displayName },
                structuralTagRegistry: genResult.structuralTagRegistry,
                generationHash: genResult.generationHash,
                mode,
              },
            });

            results.documents.push({
              id: genDoc.id,
              templateName: displayName,
              templateFormat: template.format,
              filePath: storagePath,
              mode,
            });
          }
        } else {
          // Single document generation (existing behavior)
          const options: GenerationOptions = {
            matterId: matter.id,
            workflowId: matter.workflowId,
            templateId: template.id,
            mode,
          };

          const genResult = await generateDocument(templateBuffer, values, options);

          const displayName = resolveOutputName(outputNameTemplate, values, template.name);
          const safeFileName = displayName.replace(/[^a-zA-Z0-9_\-. ]/g, "").replace(/\s+/g, "_").slice(0, 100);
          const storagePath = `generated/${matter.id}/${template.id}/${safeFileName}_${Date.now()}.docx`;
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
              variableSnapshot: { ...genResult.variableSnapshot, _displayName: displayName },
              structuralTagRegistry: genResult.structuralTagRegistry,
              generationHash: genResult.generationHash,
              mode,
            },
          });

          results.documents.push({
            id: genDoc.id,
            templateName: displayName,
            templateFormat: template.format,
            filePath: storagePath,
            mode,
          });
        }
      } else if (template.format === "pdf") {
        // ── PDF Form Filling Engine ──
        const templateBuffer = await fetchTemplateFile(template.filePath);

        if (!templateBuffer) {
          const genDoc = await prisma.generatedDocument.create({
            data: { matterId: matter.id, templateId: template.id, variableSnapshot: values, structuralTagRegistry: {}, mode, generationHash: "" },
          });
          results.documents.push({ id: genDoc.id, templateName: template.name, templateFormat: template.format, filePath: null, mode });
          continue;
        }

        // Get field mappings from workflow template config
        const pdfMappings = (mapping?.pdfFieldMappings || []) as PdfFieldMapping[];
        if (pdfMappings.length === 0) {
          results.skipped.push({ templateId: template.id, templateName: template.name, reason: "No PDF field mappings configured" });
          continue;
        }

        const fillResult = await fillPdfForm(templateBuffer, {
          values,
          fieldMappings: pdfMappings,
          flatten: mode === "final",
        });

        const storagePath = `generated/${matter.id}/${template.id}/${mode}_${Date.now()}.pdf`;
        const { error: uploadError } = await supabase.storage
          .from("draft-documents")
          .upload(storagePath, fillResult.buffer, {
            contentType: "application/pdf",
            upsert: true,
          });

        if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

        const genDoc = await prisma.generatedDocument.create({
          data: {
            matterId: matter.id,
            templateId: template.id,
            filePath: storagePath,
            variableSnapshot: { ...values, _pdfFilled: fillResult.filledFields, _pdfSkipped: fillResult.skippedFields },
            structuralTagRegistry: {},
            generationHash: "",
            mode,
          },
        });

        results.documents.push({ id: genDoc.id, templateName: template.name, templateFormat: template.format, filePath: storagePath, mode });
      } else {
        // Excel and other engines — placeholder
        const genDoc = await prisma.generatedDocument.create({
          data: { matterId: matter.id, templateId: template.id, variableSnapshot: values, structuralTagRegistry: {}, mode, generationHash: "" },
        });
        results.documents.push({ id: genDoc.id, templateName: template.name, templateFormat: template.format, filePath: null, mode });
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

  // ── Third pass: Unpack address objects into flat fields for templates ──

  // Company address: {{company_street}}, {{company_number}}, {{company_city}}, etc.
  if (result.company_address && typeof result.company_address === "string") {
    // preprocessValues first pass already converted address object to formatted string
    // We need the original object — check raw data
  }
  const rawCompanyAddr = raw.company_address;
  if (rawCompanyAddr && typeof rawCompanyAddr === "object") {
    result.company_street = rawCompanyAddr.street || "";
    result.company_number = rawCompanyAddr.street2 || "";
    result.company_city = rawCompanyAddr.city || "";
    result.company_state = rawCompanyAddr.state || "";
    result.company_zip = rawCompanyAddr.zip || "";
    result.company_country = rawCompanyAddr.country || "United States";
  }

  // Incorporator address: {{incorporator_street}}, {{incorporator_city}}, etc.
  const rawIncorpAddr = raw.incorporator_address;
  if (rawIncorpAddr && typeof rawIncorpAddr === "object") {
    result.incorporator_street = rawIncorpAddr.street || "";
    result.incorporator_number = rawIncorpAddr.street2 || "";
    result.incorporator_city = rawIncorpAddr.city || "";
    result.incorporator_state = rawIncorpAddr.state || "";
    result.incorporator_zip = rawIncorpAddr.zip || "";
    result.incorporator_country = rawIncorpAddr.country || "United States";
  }

  // ── Fourth pass: Compute derived values for templates ──

  // Enrich each founder in the founders array with computed fields
  if (Array.isArray(result.founders)) {
    for (const founder of result.founders) {
      const shares = Number(founder.founder_shares) || 0;
      const timeline = Number(founder.founder_vesting_timeline) || 0;
      const cliff = Number(founder.founder_vesting_cliff) || 0;

      founder.founder_purchase_price = shares * 0.00001;
      founder.founder_half_purchase_price = shares * 0.000005;
      founder.founder_vesting_years = timeline > 0 ? Math.floor(timeline / 12) : 0;
      founder.founder_vesting_cliff_years = cliff > 0 ? Math.floor(cliff / 12) : 0;
      founder.founder_vesting_half_years = timeline > 0 ? Math.floor(timeline / 6) : 0;
      founder.founder_vesting_quarters = timeline > 0 ? Math.floor(timeline / 3) : 0;
      founder.founder_cliff_percent = timeline > 0 ? Math.round((cliff / timeline) * 100) : 0;
      founder.founder_vesting_timeline_divisible_by_12 = timeline > 0 && timeline % 12 === 0 ? "true" : "false";
      founder.founder_vesting_cliff_divisible_by_12 = cliff > 0 && cliff % 12 === 0 ? "true" : "false";

      // Auto-populate vesting details from preset schedule selections
      // When a preset is chosen, the detail fields are hidden in the interview,
      // but templates still need the values
      if (founder.founder_vesting_schedule === "Monthly, over 48 months with a 1-year cliff") {
        founder.founder_vesting_timeline = founder.founder_vesting_timeline || 48;
        founder.founder_vesting_recurrence = founder.founder_vesting_recurrence || "Monthly";
        founder.founder_vesting_cliff_yn = "true";
        founder.founder_vesting_cliff = founder.founder_vesting_cliff || 12;
        // Recompute derived values with populated fields
        const tl = 48, cl = 12;
        founder.founder_vesting_years = 4;
        founder.founder_vesting_cliff_years = 1;
        founder.founder_vesting_half_years = 8;
        founder.founder_vesting_quarters = 16;
        founder.founder_cliff_percent = 25;
        founder.founder_vesting_timeline_divisible_by_12 = "true";
        founder.founder_vesting_cliff_divisible_by_12 = "true";
      } else if (founder.founder_vesting_schedule === "Monthly, over 48 months with no cliff") {
        founder.founder_vesting_timeline = founder.founder_vesting_timeline || 48;
        founder.founder_vesting_recurrence = founder.founder_vesting_recurrence || "Monthly";
        founder.founder_vesting_cliff_yn = "false";
        founder.founder_vesting_cliff = 0;
        founder.founder_vesting_years = 4;
        founder.founder_vesting_cliff_years = 0;
        founder.founder_vesting_half_years = 8;
        founder.founder_vesting_quarters = 16;
        founder.founder_cliff_percent = 0;
        founder.founder_vesting_timeline_divisible_by_12 = "true";
      }

      // Unpack founder_address object into flat fields for templates
      // Templates use {{founder_street}}, {{founder_city}}, etc.
      const addr = founder.founder_address;
      if (addr && typeof addr === "object") {
        founder.founder_street = addr.street || "";
        founder.founder_number = addr.street2 || "";
        founder.founder_city = addr.city || "";
        founder.founder_state = addr.state || "";
        founder.founder_zip = addr.zip || "";
        founder.founder_country = addr.country || "United States";
        // Also store formatted string version
        founder.founder_address = formatAddress(addr);
      }

      // Normalize booleans inside founder objects
      for (const key of ["board_yn", "founder_addroles_yn", "founder_vesting_schedule_yn", "founder_vesting_cliff_yn"]) {
        if (key in founder) {
          const v = founder[key];
          founder[key] = (v === true || v === "true" || v === "Yes" || v === "yes") ? "true" : "false";
        }
      }
    }
  }

  // ── SS-4 PDF computed fields ──
  // These combine address components into the format the IRS form expects
  const street = result.company_street || "";
  const suite = result.company_number || "";
  result.company_street_full = suite ? `${street}, ${suite}` : street;
  result.company_city_state_zip = [result.company_city, result.company_state].filter(Boolean).join(", ") + (result.company_zip ? ` ${result.company_zip}` : "");
  result.company_county_state = [result.company_county, result.company_state].filter(Boolean).join(", ");
  result.company_secretary_name_title = result.company_secretary_name ? `${result.company_secretary_name}, Secretary` : "";

  // Incorporator full address as single line
  const incStreet = result.incorporator_street || "";
  const incSuite = result.incorporator_number || "";
  result.incorporator_full_address = [
    incSuite ? `${incStreet}, ${incSuite}` : incStreet,
    result.incorporator_city,
    result.incorporator_state,
    result.incorporator_zip,
  ].filter(Boolean).join(", ");

  // Build all_directors list from founders + non-founder directors
  const directorNames: string[] = [];
  if (Array.isArray(result.founders)) {
    for (const f of result.founders) {
      if (f.board_yn === "true" || f.board_yn === true) {
        directorNames.push(f.founder_name || f.name || "");
      }
    }
  }
  if (Array.isArray(result.non_founder_directors)) {
    for (const d of result.non_founder_directors) {
      directorNames.push(d.nonfounderdirector_name || d.name || "");
    }
  }
  result.all_directors = directorNames;
  result.all_directors_count = directorNames.length;

  // Build natural language director text with Oxford comma + is/are
  if (directorNames.length === 0) {
    result.all_directors_text = "";
  } else if (directorNames.length === 1) {
    result.all_directors_text = `${directorNames[0]} is`;
  } else if (directorNames.length === 2) {
    result.all_directors_text = `${directorNames[0]} and ${directorNames[1]} are`;
  } else {
    const last = directorNames[directorNames.length - 1];
    const rest = directorNames.slice(0, -1).join(", ");
    result.all_directors_text = `${rest}, and ${last} are`;
  }

  // Compute total shares to issue
  if (Array.isArray(result.founders)) {
    result.shares_to_issue = result.founders.reduce(
      (sum: number, f: any) => sum + (Number(f.founder_shares) || 0), 0
    );
  }

  return result;
}

/**
 * Resolve an output name template string like "{{company_name}} - RSPA - {{this.founder_name}}"
 * against the current values. Falls back to template name + item label.
 */
function resolveOutputName(
  template: string | undefined,
  values: Record<string, any>,
  fallbackName: string,
  item?: Record<string, any>
): string {
  if (!template) {
    // Default: template name + first recognizable item label (for per-item docs)
    if (item) {
      const label = item.name || item.founder_name || item.title || "";
      return label ? `${fallbackName} - ${label}` : fallbackName;
    }
    return fallbackName;
  }

  // Replace {{variable}} placeholders with values
  return template.replace(/\{\{([^}]+)\}\}/g, (_, varExpr) => {
    const varName = varExpr.trim();

    // this.field → look in item first
    if (varName.startsWith("this.") && item) {
      const field = varName.slice(5);
      return String(item[field] ?? "");
    }

    // Direct lookup
    const val = values[varName];
    if (val !== undefined && val !== null) return String(val);

    // Dot notation
    if (varName.includes(".")) {
      const parts = varName.split(".");
      let current: any = values;
      for (const part of parts) {
        if (current === undefined || current === null) return "";
        current = current[part];
      }
      return String(current ?? "");
    }

    return "";
  }).trim() || fallbackName;
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
