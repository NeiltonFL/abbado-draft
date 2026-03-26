import { Router } from "express";
import { supabase } from "../lib/supabase";
import prisma from "../lib/prisma";
import { requireRole, getScope, auditLog } from "../middleware/auth";
import { parseTemplate } from "../engines/word";
import { readGeneratedDocument } from "../engines/word";

export const engineRoutes = Router();

// ── Parse a template file (upload .docx and extract variable schema) ──
engineRoutes.post("/parse-template", requireRole("editor"), async (req, res) => {
  try {
    const { orgId } = getScope(req);

    // Expect base64-encoded file in the body
    const { fileBase64, fileName, templateId } = req.body;

    if (!fileBase64 || !fileName) {
      return res.status(400).json({ error: "fileBase64 and fileName are required" });
    }

    const buffer = Buffer.from(fileBase64, "base64");

    // Determine format from extension
    const ext = fileName.split(".").pop()?.toLowerCase();
    if (ext !== "docx") {
      return res.status(400).json({ error: "Only .docx files are supported for parsing currently" });
    }

    // Parse the template
    const schema = await parseTemplate(buffer);

    // Store file in Supabase Storage
    const storagePath = `templates/${orgId}/${templateId || "new"}/${Date.now()}_${fileName}`;
    const { error: uploadError } = await supabase.storage
      .from("draft-documents")
      .upload(storagePath, buffer, {
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        upsert: true,
      });

    if (uploadError) {
      return res.status(500).json({ error: `Storage upload failed: ${uploadError.message}` });
    }

    // If templateId provided, update the existing template record
    if (templateId) {
      await prisma.template.update({
        where: { id: templateId },
        data: {
          filePath: storagePath,
          parsedSchema: schema as any,
        },
      });
    }

    await auditLog(orgId, req.auth!.userId, "template.parsed", "template", templateId, {
      fileName,
      variableCount: schema.variables.length,
      sdtCount: schema.rawSdtCount,
      mustacheCount: schema.rawMustacheCount,
    });

    res.json({
      storagePath,
      schema,
      summary: {
        totalVariables: schema.variables.length,
        sdtVariables: schema.rawSdtCount,
        mustacheVariables: schema.rawMustacheCount,
        conditionalBlocks: schema.conditionals.length,
        repeatingBlocks: schema.repeatingBlocks.length,
      },
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Detect changes in a re-uploaded document ──
engineRoutes.post("/detect-changes", requireRole("user"), async (req, res) => {
  try {
    const { fileBase64, generatedDocumentId } = req.body;

    if (!fileBase64 || !generatedDocumentId) {
      return res.status(400).json({ error: "fileBase64 and generatedDocumentId are required" });
    }

    const buffer = Buffer.from(fileBase64, "base64");

    // Read the document
    const readResult = await readGeneratedDocument(buffer);

    // Get the stored snapshot for comparison
    const genDoc = await prisma.generatedDocument.findUnique({
      where: { id: generatedDocumentId },
    });

    if (!genDoc) {
      return res.status(404).json({ error: "Generated document not found" });
    }

    res.json({
      changes: readResult.changes,
      currentValues: readResult.currentValues,
      metadata: readResult.metadata,
      integrity: {
        ok: readResult.integrityOk,
        sdtCount: readResult.sdtCount,
        expectedSdtCount: readResult.expectedSdtCount,
      },
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Generate a signed download URL for a generated document ──
engineRoutes.get("/download/:docId", async (req, res) => {
  try {
    const { orgId } = getScope(req);

    const genDoc = await prisma.generatedDocument.findUnique({
      where: { id: req.params.docId },
      include: {
        matter: { select: { orgId: true } },
        template: { select: { name: true, format: true } },
      },
    });

    if (!genDoc || genDoc.matter.orgId !== orgId) {
      return res.status(404).json({ error: "Document not found" });
    }

    if (!genDoc.filePath) {
      return res.status(404).json({ error: "No file generated yet" });
    }

    // Generate signed URL (5 minute expiry)
    const { data, error } = await supabase.storage
      .from("draft-documents")
      .createSignedUrl(genDoc.filePath, 300);

    if (error || !data) {
      return res.status(500).json({ error: "Failed to generate download URL" });
    }

    res.json({
      url: data.signedUrl,
      fileName: `${genDoc.template.name}.${genDoc.template.format}`,
      expiresIn: 300,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
