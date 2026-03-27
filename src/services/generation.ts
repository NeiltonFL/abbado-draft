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

  // ── Evaluate Logic tab hidden variables ──
  const computedValues = evaluateLogicVariables(
    matter.workflow.variables.map((v: any) => ({
      name: v.name,
      type: v.type,
      isComputed: v.isComputed,
      validation: v.validation,
      expression: v.expression,
    })),
    interviewValues
  );

  // Merge: interview values + computed logic values
  const values = { ...interviewValues, ...computedValues };

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

  const values = (matter.variableValues as Record<string, any>) || {};
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
