import { Router } from "express";
import { supabase } from "../lib/supabase";
import prisma from "../lib/prisma";
import { requireRole, getScope, auditLog } from "../middleware/auth";
import { parseTemplate } from "../engines/word";
import { readGeneratedDocument } from "../engines/word";
import { parsePdfFields } from "../engines/pdf";

export const engineRoutes = Router();

// ── Parse a template file (upload .docx or .pdf and extract variable/field schema) ──
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

    if (ext === "pdf") {
      // Parse PDF form fields
      const fields = await parsePdfFields(buffer);
      const schema = {
        format: "pdf",
        fields,
        variableNames: fields.map(f => f.name),
      };

      // If a templateId was provided, update the template's parsed schema
      if (templateId) {
        await prisma.template.update({ where: { id: templateId }, data: { parsedSchema: schema as any } });
      }

      return res.json(schema);
    }

    if (ext !== "docx") {
      return res.status(400).json({ error: "Only .docx and .pdf files are supported for parsing" });
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

    const displayName = (genDoc.variableSnapshot as any)?._displayName || genDoc.template.name;

    res.json({
      url: data.signedUrl,
      fileName: `${displayName}.${genDoc.template.format}`,
      expiresIn: 300,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Generate a sample .docx template from workflow variables ──
engineRoutes.post("/sample-template/:workflowId", async (req, res) => {
  try {
    const { orgId } = getScope(req);

    const workflow = await prisma.workflow.findFirst({
      where: { id: req.params.workflowId, orgId },
      include: {
        variables: { orderBy: [{ groupName: "asc" }, { displayOrder: "asc" }] },
      },
    });

    if (!workflow) return res.status(404).json({ error: "Workflow not found" });

    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();

    const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const b = "<w:rPr><w:b/></w:rPr>";
    const bLg = '<w:rPr><w:b/><w:sz w:val="36"/></w:rPr>';

    const p = (text: string, bold?: boolean) =>
      `<w:p><w:r>${bold ? b : ""}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

    // Group variables
    const pages: Record<string, typeof workflow.variables> = {};
    const subQuestions: Record<string, typeof workflow.variables> = {};

    for (const v of workflow.variables) {
      if (v.isComputed || v.type === "computed") continue;
      const dotMatch = v.name.match(/^(.+)\.\$\.(.+)$/);
      if (dotMatch) {
        if (!subQuestions[dotMatch[1]]) subQuestions[dotMatch[1]] = [];
        subQuestions[dotMatch[1]].push(v);
        continue;
      }
      const page = v.groupName || "General";
      if (!pages[page]) pages[page] = [];
      pages[page].push(v);
    }

    const bodyParts: string[] = [];

    bodyParts.push(`<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r>${bLg}<w:t>${workflow.name}</w:t></w:r></w:p>`);
    bodyParts.push("<w:p/>");

    for (const [pageName, vars] of Object.entries(pages)) {
      bodyParts.push(p(pageName.toUpperCase(), true));
      bodyParts.push("<w:p/>");

      for (const v of vars) {
        if (v.type === "repeating") {
          const subs = subQuestions[v.name] || [];
          if (subs.length > 0) {
            bodyParts.push(p(`${v.displayLabel}:`, true));
            bodyParts.push(p(`{{#each ${v.name}}}`));
            const fields = subs.map((s: any) => {
              const field = s.name.split(".$.")[1];
              return `${s.displayLabel}: {{this.${field}}}`;
            }).join(" | ");
            bodyParts.push(p(`  {{@index}}. ${fields}`));
            bodyParts.push(p(`{{/each}}`));
          }
        } else if (v.type === "info") {
          // Skip info blocks in the template
        } else {
          bodyParts.push(p(`${v.displayLabel}: {{${v.name}}}`));
        }
      }
      bodyParts.push("<w:p/>");
    }

    bodyParts.push("<w:p/>");
    bodyParts.push(p("_____________________________"));
    bodyParts.push(p("Signature"));

    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${ns}><w:body>${bodyParts.join("")}</w:body></w:document>`;
    const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
    const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
    const wordRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';

    zip.file("[Content_Types].xml", contentTypes);
    zip.file("_rels/.rels", rels);
    zip.file("word/_rels/document.xml.rels", wordRels);
    zip.file("word/document.xml", documentXml);

    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${workflow.name.replace(/[^a-zA-Z0-9]/g, "_")}_template.docx"`);
    res.send(buffer);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
