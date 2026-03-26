import JSZip from "jszip";
import { v4 as uuid } from "uuid";
import crypto from "crypto";

// ── Types ──

export interface GenerationOptions {
  matterId: string;
  workflowId: string;
  templateId: string;
  mode: "live" | "final";
}

export interface GenerationResult {
  buffer: Buffer;
  variableSnapshot: Record<string, any>;
  structuralTagRegistry: Record<string, string>;
  generationHash: string;
}

// ── Conditional Evaluator ──

/**
 * Evaluate a condition expression against variable values.
 * Supports: ==, !=, >, <, >=, <=, truthy checks
 */
function evaluateCondition(expression: string, values: Record<string, any>): boolean {
  const compMatch = expression.match(/^(\S+)\s*(==|!=|>=|<=|>|<)\s*["']?([^"']*)["']?$/);

  if (compMatch) {
    const [, varName, operator, compareValue] = compMatch;
    const actualValue = resolveValue(varName, values);

    switch (operator) {
      case "==": return String(actualValue) === compareValue;
      case "!=": return String(actualValue) !== compareValue;
      case ">": return Number(actualValue) > Number(compareValue);
      case "<": return Number(actualValue) < Number(compareValue);
      case ">=": return Number(actualValue) >= Number(compareValue);
      case "<=": return Number(actualValue) <= Number(compareValue);
      default: return false;
    }
  }

  // Truthy check
  const val = resolveValue(expression.trim(), values);
  return Boolean(val) && val !== "false" && val !== "0" && val !== "";
}

/**
 * Resolve a variable name to its value, supporting dot notation.
 * For repeating contexts, currentItem provides the current iteration's data.
 */
function resolveValue(name: string, values: Record<string, any>, currentItem?: any): any {
  // Handle "this.field" references inside repeating blocks
  if (name.startsWith("this.") && currentItem) {
    const field = name.slice(5);
    return currentItem[field];
  }

  // Handle dot notation for nested values
  const parts = name.split(".");
  let current: any = values;
  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }
  return current;
}

// ── Text Run Reassembly ──

/**
 * Word splits text across multiple <w:r> elements. This function finds
 * mustache patterns that span multiple runs and reassembles them into
 * single runs for reliable processing.
 *
 * Example: <w:r><w:t>{{</w:t></w:r><w:r><w:t>name</w:t></w:r><w:r><w:t>}}</w:t></w:r>
 * Becomes: <w:r><w:t>{{name}}</w:t></w:r>
 */
function reassembleSplitRuns(xml: string): string {
  // Strategy: find paragraphs that contain {{ or }} in their text content,
  // and if {{ and }} are in different runs, merge the text runs
  const paragraphPattern = /(<w:p\b[^>]*>)([\s\S]*?)(<\/w:p>)/g;

  return xml.replace(paragraphPattern, (fullMatch, pStart, pContent, pEnd) => {
    // Extract all text from this paragraph
    const runTexts: { full: string; text: string; index: number }[] = [];
    const runPattern = /(<w:r\b[^>]*>)([\s\S]*?)(<\/w:r>)/g;
    let rMatch;

    while ((rMatch = runPattern.exec(pContent)) !== null) {
      const runContent = rMatch[2];
      const textMatch = runContent.match(/<w:t[^>]*>([^<]*)<\/w:t>/);
      if (textMatch) {
        runTexts.push({
          full: rMatch[0],
          text: textMatch[1],
          index: rMatch.index,
        });
      }
    }

    // Check if combined text has mustache patterns
    const combined = runTexts.map((r) => r.text).join("");
    if (!combined.includes("{{") || !combined.includes("}}")) {
      return fullMatch; // No mustache patterns, return unchanged
    }

    // Check if any single run already contains a complete pattern
    const singleRunComplete = runTexts.some((r) => /\{\{[^}]+\}\}/.test(r.text));
    if (singleRunComplete && !runTexts.some((r) => r.text.includes("{{") && !r.text.includes("}}"))) {
      return fullMatch; // Already properly contained
    }

    // Need to merge: replace split runs with a single run containing the combined text
    // Preserve the formatting (rPr) from the first run
    if (runTexts.length === 0) return fullMatch;

    const firstRunMatch = pContent.match(/<w:r\b[^>]*>([\s\S]*?)<w:t/);
    const rPr = firstRunMatch ? firstRunMatch[1] : "";

    // Build a single merged run
    const mergedRun = `<w:r>${rPr}<w:t xml:space="preserve">${combined}</w:t></w:r>`;

    // Replace all the original runs with the merged one
    let newContent = pContent;
    // Remove all runs that had text
    for (let i = runTexts.length - 1; i >= 0; i--) {
      newContent = newContent.replace(runTexts[i].full, i === 0 ? mergedRun : "");
    }

    return `${pStart}${newContent}${pEnd}`;
  });
}

// ── Conditional Processing ──

/**
 * Process {{#if condition}}...{{/if}} and {{#if}}...{{else}}...{{/if}} blocks.
 * Removes false blocks entirely from the XML.
 */
function processConditionals(xml: string, values: Record<string, any>, currentItem?: any): string {
  // Process from innermost to outermost to handle nesting
  let result = xml;
  let changed = true;
  let iterations = 0;
  const maxIterations = 50; // Safety limit

  while (changed && iterations < maxIterations) {
    changed = false;
    iterations++;

    // Match innermost {{#if}}...{{/if}} (no nested #if inside)
    const ifElsePattern = /\{\{#if\s+(.+?)\}\}([\s\S]*?)\{\{else\}\}([\s\S]*?)\{\{\/if\}\}/;
    const ifOnlyPattern = /\{\{#if\s+(.+?)\}\}([\s\S]*?)\{\{\/if\}\}/;

    // Try if/else first
    const elseMatch = result.match(ifElsePattern);
    if (elseMatch && !elseMatch[2].includes("{{#if")) {
      const condition = elseMatch[1];
      const trueContent = elseMatch[2];
      const falseContent = elseMatch[3];

      const isTrue = evaluateCondition(condition, values);
      result = result.replace(elseMatch[0], isTrue ? trueContent : falseContent);
      changed = true;
      continue;
    }

    // Try if-only
    const ifMatch = result.match(ifOnlyPattern);
    if (ifMatch && !ifMatch[2].includes("{{#if")) {
      const condition = ifMatch[1];
      const content = ifMatch[2];

      const isTrue = evaluateCondition(condition, values);
      result = result.replace(ifMatch[0], isTrue ? content : "");
      changed = true;
    }
  }

  return result;
}

// ── Repeating Section Processing ──

/**
 * Process {{#each collection}}...{{/each}} blocks.
 * Duplicates content for each item in the collection array.
 */
function processRepeatingBlocks(xml: string, values: Record<string, any>): string {
  let result = xml;
  let changed = true;
  let iterations = 0;

  while (changed && iterations < 50) {
    changed = false;
    iterations++;

    // Match innermost {{#each}}...{{/each}}
    const eachPattern = /\{\{#each\s+(\S+)\}\}([\s\S]*?)\{\{\/each\}\}/;
    const match = result.match(eachPattern);

    if (match && !match[2].includes("{{#each")) {
      const collection = match[1];
      const template = match[2];
      const items = values[collection];

      if (Array.isArray(items) && items.length > 0) {
        const expanded = items
          .map((item, index) => {
            let itemContent = template;

            // Replace {{this.field}} with actual values
            itemContent = itemContent.replace(
              /\{\{this\.([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g,
              (_, field) => {
                const val = item[field];
                return val !== undefined && val !== null ? String(val) : "";
              }
            );

            // Replace {{@index}} with the current index
            itemContent = itemContent.replace(/\{\{@index\}\}/g, String(index));

            // Process conditionals within the repeating block using item context
            itemContent = processConditionals(itemContent, values, item);

            return itemContent;
          })
          .join("");

        result = result.replace(match[0], expanded);
        changed = true;
      } else {
        // Empty collection: remove the block entirely
        result = result.replace(match[0], "");
        changed = true;
      }
    }
  }

  return result;
}

// ── Variable Replacement ──

/**
 * Replace {{variable_name}} with actual values.
 * In "live" mode, wraps each replacement in an SDT for the add-in.
 * In "final" mode, inserts plain text.
 */
function replaceVariables(
  xml: string,
  values: Record<string, any>,
  mode: "live" | "final",
  tagRegistry: Record<string, string>
): string {
  return xml.replace(
    /\{\{([a-zA-Z_][a-zA-Z0-9_.$]*)\}\}/g,
    (fullMatch, varName) => {
      // Skip any remaining control flow markers
      if (varName.startsWith("#") || varName.startsWith("/")) return fullMatch;

      const value = resolveValue(varName, values);
      const displayValue = value !== undefined && value !== null ? String(value) : "";

      if (mode === "final") {
        // Plain text replacement
        return escapeXml(displayValue);
      }

      // Live mode: wrap in SDT with variable tag
      const sdtId = generateSdtId();
      tagRegistry[`var_${varName}_${sdtId}`] = varName;

      return buildSdtXml(varName, varName, displayValue, sdtId);
    }
  );
}

/**
 * Update existing SDT content with new variable values.
 */
function updateExistingSdts(xml: string, values: Record<string, any>): string {
  return xml.replace(
    /(<w:sdt\b[^>]*>)([\s\S]*?)(<\/w:sdt>)/g,
    (fullMatch, sdtStart, sdtInner, sdtEnd) => {
      // Extract tag
      const tagMatch = sdtInner.match(/<w:tag\s+w:val="([^"]+)"/);
      if (!tagMatch) return fullMatch;
      const tag = tagMatch[1];

      // Skip structural/conditional/repeating tags
      if (tag.startsWith("tpl_") || tag.startsWith("cond:") || tag.startsWith("repeat:")) {
        return fullMatch;
      }

      // Get the variable value
      const value = resolveValue(tag, values);
      if (value === undefined) return fullMatch;

      const displayValue = String(value);

      // Replace the content inside <w:sdtContent>
      const newInner = sdtInner.replace(
        /(<w:sdtContent>)([\s\S]*?)(<\/w:sdtContent>)/,
        `$1<w:r><w:t xml:space="preserve">${escapeXml(displayValue)}</w:t></w:r>$3`
      );

      return `${sdtStart}${newInner}${sdtEnd}`;
    }
  );
}

// ── Structural Tagging ──

/**
 * Wrap every paragraph and table in the document with a Rich Text Content Control
 * bearing a unique structural tag. This creates the map that the edit journal
 * anchors to for deterministic regeneration.
 *
 * Only applied in "live" mode.
 */
function applyStructuralTags(
  xml: string,
  tagRegistry: Record<string, string>
): string {
  let counter = 0;

  // Tag each paragraph
  xml = xml.replace(
    /(<w:p\b)([^>]*>)([\s\S]*?)(<\/w:p>)/g,
    (fullMatch, pStart, pAttrs, pContent, pEnd) => {
      counter++;
      const tagId = `tpl_p_${String(counter).padStart(4, "0")}`;
      const sdtId = generateSdtId();
      tagRegistry[tagId] = `paragraph_${counter}`;

      // Wrap the paragraph in a group SDT
      return `<w:sdt><w:sdtPr><w:id w:val="${sdtId}"/><w:tag w:val="${tagId}"/><w:lock w:val="sdtLocked"/></w:sdtPr><w:sdtContent>${pStart}${pAttrs}${pContent}${pEnd}</w:sdtContent></w:sdt>`;
    }
  );

  // Tag each table
  xml = xml.replace(
    /(<w:tbl\b)([^>]*>)([\s\S]*?)(<\/w:tbl>)/g,
    (fullMatch, tblStart, tblAttrs, tblContent, tblEnd) => {
      counter++;
      const tagId = `tpl_tbl_${String(counter).padStart(4, "0")}`;
      const sdtId = generateSdtId();
      tagRegistry[tagId] = `table_${counter}`;

      return `<w:sdt><w:sdtPr><w:id w:val="${sdtId}"/><w:tag w:val="${tagId}"/><w:lock w:val="sdtLocked"/></w:sdtPr><w:sdtContent>${tblStart}${tblAttrs}${tblContent}${tblEnd}</w:sdtContent></w:sdt>`;
    }
  );

  return xml;
}

// ── Custom XML Parts ──

/**
 * Build the Custom XML Part containing Abbado Draft metadata.
 * This is embedded in the .docx and read by the Word add-in.
 */
function buildMetadataXml(options: GenerationOptions, snapshot: Record<string, any>, tagRegistry: Record<string, string>): string {
  const metadata = {
    product: "abbado-draft",
    version: "1.0.0",
    matterId: options.matterId,
    workflowId: options.workflowId,
    templateId: options.templateId,
    mode: options.mode,
    generatedAt: new Date().toISOString(),
    variableSnapshot: snapshot,
    structuralTagRegistry: tagRegistry,
  };

  return `<?xml version="1.0" encoding="UTF-8"?>
<abbado-draft>${JSON.stringify(metadata)}</abbado-draft>`;
}

/**
 * Build the AutoOpen XML property that makes the add-in auto-open.
 */
function buildAutoOpenXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<WebExtensionTaskpanes xmlns="http://schemas.microsoft.com/office/webextensions/taskpanes/2010/11">
  <Taskpane DockState="right" Visibility="true" Width="350" Row="0">
    <WebExtensionPartRef xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/>
  </Taskpane>
</WebExtensionTaskpanes>`;
}

// ── XML Helpers ──

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function generateSdtId(): string {
  return String(Math.floor(Math.random() * 2000000000));
}

function buildSdtXml(tag: string, alias: string, value: string, sdtId: string): string {
  return `</w:t></w:r></w:p><w:sdt><w:sdtPr><w:id w:val="${sdtId}"/><w:tag w:val="${escapeXml(tag)}"/><w:alias w:val="${escapeXml(alias)}"/><w:showingPlcHdr w:val="0"/></w:sdtPr><w:sdtContent><w:p><w:r><w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r></w:sdtContent></w:sdt><w:p><w:r><w:t xml:space="preserve">`;
}

// ── Main Generator ──

/**
 * Generate a document from a template and variable values.
 *
 * Pipeline:
 * 1. Unzip template .docx
 * 2. Reassemble split text runs
 * 3. Process conditionals (evaluate and remove false branches)
 * 4. Process repeating sections (expand for each collection item)
 * 5. Replace {{variables}} with values (wrap in SDTs for live mode)
 * 6. Update existing SDT values
 * 7. Apply structural tagging (live mode only)
 * 8. Embed metadata in Custom XML Parts (live mode only)
 * 9. Re-zip into valid .docx
 */
export async function generateDocument(
  templateBuffer: Buffer,
  values: Record<string, any>,
  options: GenerationOptions
): Promise<GenerationResult> {
  const zip = await JSZip.loadAsync(templateBuffer);

  // Read document.xml
  const docXmlFile = zip.file("word/document.xml");
  if (!docXmlFile) {
    throw new Error("Invalid template: word/document.xml not found");
  }
  let documentXml = await docXmlFile.async("string");

  // Create a snapshot of the values used for generation
  const variableSnapshot = JSON.parse(JSON.stringify(values));

  // Track structural tags for the registry
  const structuralTagRegistry: Record<string, string> = {};

  // ── Pipeline ──

  // 1. Reassemble split text runs
  documentXml = reassembleSplitRuns(documentXml);

  // 2. Process conditionals
  documentXml = processConditionals(documentXml, values);

  // 3. Process repeating sections
  documentXml = processRepeatingBlocks(documentXml, values);

  // 4. Replace mustache variables
  documentXml = replaceVariables(documentXml, values, options.mode, structuralTagRegistry);

  // 5. Update existing SDT values
  documentXml = updateExistingSdts(documentXml, values);

  // 6. Structural tagging (live mode only)
  if (options.mode === "live") {
    documentXml = applyStructuralTags(documentXml, structuralTagRegistry);
  }

  // Write back document.xml
  zip.file("word/document.xml", documentXml);

  // 7. Embed metadata (live mode only)
  if (options.mode === "live") {
    // Add Custom XML Part with Abbado Draft metadata
    const metadataXml = buildMetadataXml(options, variableSnapshot, structuralTagRegistry);
    zip.file("customXml/item_abbado_draft.xml", metadataXml);

    // Add the Content Types entry for our custom XML
    const contentTypesFile = zip.file("[Content_Types].xml");
    if (contentTypesFile) {
      let contentTypes = await contentTypesFile.async("string");
      if (!contentTypes.includes("item_abbado_draft.xml")) {
        contentTypes = contentTypes.replace(
          "</Types>",
          `<Override PartName="/customXml/item_abbado_draft.xml" ContentType="application/xml"/></Types>`
        );
        zip.file("[Content_Types].xml", contentTypes);
      }
    }
  }

  // 8. Generate the output buffer
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  // Compute generation hash
  const generationHash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ templateId: options.templateId, values: variableSnapshot }))
    .digest("hex");

  return {
    buffer,
    variableSnapshot,
    structuralTagRegistry,
    generationHash,
  };
}
