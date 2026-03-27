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
function evaluateCondition(expression: string, values: Record<string, any>, currentItem?: any): boolean {
  // Unescape XML entities — conditions come from raw XML where quotes are &quot;
  let expr = expression
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'");

  // Match: varName operator "value" or varName operator value
  const compMatch = expr.match(/^(\S+)\s*(==|!=|>=|<=|>|<)\s*["']?([^"']*)["']?\s*$/);

  if (compMatch) {
    const [, varName, operator, compareValue] = compMatch;
    const actualValue = resolveValue(varName, values, currentItem);

    switch (operator) {
      case "==": return String(actualValue ?? "") === compareValue;
      case "!=": return String(actualValue ?? "") !== compareValue;
      case ">": return Number(actualValue) > Number(compareValue);
      case "<": return Number(actualValue) < Number(compareValue);
      case ">=": return Number(actualValue) >= Number(compareValue);
      case "<=": return Number(actualValue) <= Number(compareValue);
      default: return false;
    }
  }

  // Truthy check
  const val = resolveValue(expr.trim(), values, currentItem);
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

      const isTrue = evaluateCondition(condition, values, currentItem);
      result = result.replace(elseMatch[0], isTrue ? trueContent : falseContent);
      changed = true;
      continue;
    }

    // Try if-only
    const ifMatch = result.match(ifOnlyPattern);
    if (ifMatch && !ifMatch[2].includes("{{#if")) {
      const condition = ifMatch[1];
      const content = ifMatch[2];

      const isTrue = evaluateCondition(condition, values, currentItem);
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
          .map((item, index) => expandItemReferences(template, item, index, values))
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

// ── Item Reference Expansion Helper ──

/**
 * Replace {{this.field}}, {{this.field|format}}, and {{@index}} within
 * a content string, using the given item and index. Also processes
 * conditionals that reference this.field.
 */
function expandItemReferences(
  content: string,
  item: any,
  index: number,
  values: Record<string, any>
): string {
  let result = content;

  // Replace {{this.field}} or {{this.field|format}} or {{this.field|fmt:arg}}
  // Also support chained: {{this.field|fmt1|fmt2}}
  result = result.replace(
    /\{\{this\.([a-zA-Z_][a-zA-Z0-9_]*)(\|[^}]+)?\}\}/g,
    (_, field, modifiers) => {
      let val = item[field];
      if (modifiers) {
        // Parse chained modifiers: |fmt1|fmt2:arg|fmt3
        const mods = modifiers.slice(1).split("|");
        for (const mod of mods) {
          const [fmt, fmtArg] = mod.split(":");
          val = applyFormat(val, fmt, fmtArg);
        }
        return escapeXml(String(val ?? ""));
      }
      return escapeXml(String(val ?? ""));
    }
  );

  // Replace {{@index}} with 1-based index
  result = result.replace(/\{\{@index\}\}/g, String(index + 1));

  // Process conditionals within the block using item context
  result = processConditionals(result, values, item);

  return result;
}

// ── Table Row Repeating ──

/**
 * Process {{#each-row collection}}...{{/each-row}} blocks within tables.
 * These markers indicate that entire TABLE ROWS (<w:tr>) should be duplicated
 * for each item in the collection.
 *
 * Pattern in the .docx XML:
 *   <w:tr>...<w:t>{{#each-row founders}}</w:t>...</w:tr>   ← marker row (removed)
 *   <w:tr>...<w:t>{{this.name}}</w:t>...</w:tr>             ← data row(s) (duplicated)
 *   <w:tr>...<w:t>{{/each-row}}</w:t>...</w:tr>             ← end marker row (removed)
 *
 * Supports conditional rows within the block:
 *   {{#each-row founders if this.board_yn == true}} — filters items
 */
function processTableRowRepeating(xml: string, values: Record<string, any>): string {
  let result = xml;
  let changed = true;
  let iterations = 0;

  while (changed && iterations < 50) {
    changed = false;
    iterations++;

    // Find a {{#each-row COLLECTION}} marker
    const markerMatch = result.match(/\{\{#each-row\s+(\S+?)(?:\s+if\s+(.+?))?\}\}/);
    if (!markerMatch) break;

    const collection = markerMatch[1];
    const filterExpr = markerMatch[2]; // Optional: "this.board_yn == true"
    const markerText = markerMatch[0];
    const markerPos = result.indexOf(markerText);

    // Find the <w:tr> that contains this marker
    const startRowStart = result.lastIndexOf("<w:tr", markerPos);
    const startRowEnd = result.indexOf("</w:tr>", markerPos) + "</w:tr>".length;
    if (startRowStart === -1 || startRowEnd === -1) break;

    // Find the matching {{/each-row}} and its containing <w:tr>
    const endMarkerPos = result.indexOf("{{/each-row}}", startRowEnd);
    if (endMarkerPos === -1) break;

    const endRowStart = result.lastIndexOf("<w:tr", endMarkerPos);
    const endRowEnd = result.indexOf("</w:tr>", endMarkerPos) + "</w:tr>".length;
    if (endRowStart === -1 || endRowEnd === -1) break;

    // Extract the data rows between start marker row and end marker row
    const dataRows = result.slice(startRowEnd, endRowStart);

    // Get the collection items
    let items = values[collection];
    if (!Array.isArray(items)) items = [];

    // Apply filter if specified
    if (filterExpr && items.length > 0) {
      items = items.filter((item: any) => {
        // Create a temporary values context with this.* mapped
        const tempValues: Record<string, any> = { ...values };
        for (const [k, v] of Object.entries(item)) {
          tempValues[`this.${k}`] = v;
        }
        return evaluateCondition(filterExpr, tempValues, item);
      });
    }

    // Expand data rows for each item
    let expanded = "";
    if (items.length > 0) {
      for (let i = 0; i < items.length; i++) {
        expanded += expandItemReferences(dataRows, items[i], i, values);
      }
    }
    // If no items, expanded is empty — rows are simply removed

    // Replace the entire block (start marker row + data rows + end marker row)
    const fullBlock = result.slice(startRowStart, endRowEnd);
    result = result.replace(fullBlock, expanded);
    changed = true;
  }

  return result;
}

/**
 * Replace {{variable_name}} or {{variable_name|format}} or {{variable_name|format:arg}}.
 * 
 * Supported format modifiers (pipe syntax in templates):
 *   TEXT:   upper, lower, title, capitalize, initials
 *   NUMBER: currency, number, number:2, ordinal, percent, percent:0, words
 *   DATE:   long, short, iso, year, month, day
 *   LIST:   join, join:and, count
 *   BOOL:   yesno, truefalse
 */
function replaceVariables(
  xml: string,
  values: Record<string, any>,
  mode: "live" | "final",
  tagRegistry: Record<string, string>
): string {
  // Match {{varName}}, {{varName|fmt}}, {{varName|fmt:arg}}, {{varName|fmt1|fmt2:arg}}
  return xml.replace(
    /\{\{([a-zA-Z_][a-zA-Z0-9_.$]*)(\|[^}]+)?\}\}/g,
    (fullMatch, varName, modifiers) => {
      if (varName.startsWith("#") || varName.startsWith("/") || varName.startsWith("@")) return fullMatch;
      let value: any = resolveValue(varName, values);
      if (modifiers) {
        // Parse chained modifiers: |fmt1|fmt2:arg|fmt3
        const mods = modifiers.slice(1).split("|");
        for (const mod of mods) {
          const colonIdx = mod.indexOf(":");
          const fmt = colonIdx >= 0 ? mod.slice(0, colonIdx) : mod;
          const fmtArg = colonIdx >= 0 ? mod.slice(colonIdx + 1) : undefined;
          value = applyFormat(value, fmt, fmtArg);
        }
        return escapeXml(String(value ?? ""));
      }
      return escapeXml(applyFormat(value, undefined, undefined));
    }
  );
}

function applyFormat(value: any, format: string | undefined, arg: string | undefined): string {
  if (value === undefined || value === null) return "";
  const str = String(value);
  if (!format) return str;

  switch (format.toLowerCase()) {
    // Text
    case "upper": case "uppercase": return str.toUpperCase();
    case "lower": case "lowercase": return str.toLowerCase();
    case "title": case "titlecase": return str.replace(/\b\w/g, c => c.toUpperCase());
    case "capitalize": case "cap": return str.charAt(0).toUpperCase() + str.slice(1);
    case "initials": return str.split(/\s+/).map(w => w.charAt(0).toUpperCase() + ".").join("");

    // Numbers
    case "currency": case "usd": {
      const num = Number(value); if (isNaN(num)) return str;
      const dec = arg !== undefined ? Number(arg) : 2;
      return "$" + num.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
    }
    case "number": case "num": case "comma": case "formatted": {
      const num = Number(value); if (isNaN(num)) return str;
      const dec = arg !== undefined ? Number(arg) : 0;
      return num.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
    }
    case "ordinal": case "ord": {
      const n = Number(value); if (isNaN(n)) return str;
      const s = ["th","st","nd","rd"]; const v = Math.abs(n) % 100;
      return n + (s[(v-20)%10] || s[v] || s[0]);
    }
    case "percent": case "pct": {
      const num = Number(value); if (isNaN(num)) return str;
      const dec = arg !== undefined ? Number(arg) : 1;
      return num.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec }) + "%";
    }
    case "words": case "spelled": {
      const num = Number(value); if (isNaN(num)) return str;
      return numberToWords(num);
    }

    // Dates
    case "long": case "datelong": { const d = parseDate(value); return d ? d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : str; }
    case "short": case "dateshort": { const d = parseDate(value); return d ? d.toLocaleDateString("en-US", { year: "numeric", month: "2-digit", day: "2-digit" }) : str; }
    case "iso": { const d = parseDate(value); return d ? d.toISOString().slice(0,10) : str; }
    case "year": { const d = parseDate(value); return d ? String(d.getFullYear()) : str; }
    case "month": { const d = parseDate(value); return d ? d.toLocaleDateString("en-US", { month: "long" }) : str; }
    case "day": { const d = parseDate(value); return d ? String(d.getDate()) : str; }

    // Lists
    case "join": {
      if (!Array.isArray(value)) return str;
      if (arg && arg.trim()) {
        const sep = arg.trim();
        if (value.length <= 1) return value.join("");
        if (value.length === 2) return value.join(` ${sep} `);
        return value.slice(0,-1).join(", ") + `, ${sep} ` + value[value.length-1];
      }
      return value.join(", ");
    }
    case "count": return Array.isArray(value) ? String(value.length) : str;

    // Booleans
    case "yesno": return value === true || value === "true" || value === "Yes" ? "Yes" : "No";
    case "truefalse": return value === true || value === "true" || value === "Yes" ? "True" : "False";

    default: return str;
  }
}

function parseDate(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function numberToWords(n: number): string {
  if (n === 0) return "zero";
  const ones = ["","one","two","three","four","five","six","seven","eight","nine","ten",
    "eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen"];
  const tens = ["","","twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety"];
  const scales = ["","thousand","million","billion","trillion"];
  if (n < 0) return "negative " + numberToWords(-n);
  if (n < 20) return ones[n];
  if (n < 100) return tens[Math.floor(n/10)] + (n%10 ? "-" + ones[n%10] : "");
  if (n < 1000) return ones[Math.floor(n/100)] + " hundred" + (n%100 ? " " + numberToWords(n%100) : "");
  let result = ""; let si = 0; let rem = Math.floor(n);
  while (rem > 0) {
    const chunk = rem % 1000;
    if (chunk > 0) { const cw = numberToWords(chunk); result = cw + (scales[si] ? " " + scales[si] : "") + (result ? " " + result : ""); }
    rem = Math.floor(rem / 1000); si++;
  }
  return result.trim();
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

// ── Cleanup ──

/**
 * Remove empty runs (<w:r><w:t/></w:r>) and empty paragraphs (<w:p/> or <w:p></w:p>)
 * left behind after conditional/repeating marker processing.
 */
function cleanupEmptyElements(xml: string): string {
  // Remove runs with empty text
  xml = xml.replace(/<w:r><w:t[^>]*\/><\/w:r>/g, "");
  xml = xml.replace(/<w:r><w:t[^>]*><\/w:t><\/w:r>/g, "");
  // Remove runs with only whitespace text (but keep <w:p/> for intentional blank lines)
  xml = xml.replace(/<w:r><w:rPr\/><w:t[^>]*><\/w:t><\/w:r>/g, "");
  // Remove empty paragraphs (but NOT self-closing <w:p/> which are intentional blank lines)
  xml = xml.replace(/<w:p><\/w:p>/g, "<w:p/>");
  // Remove paragraphs that have only empty runs
  xml = xml.replace(/<w:p>(\s*)<\/w:p>/g, "<w:p/>");
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
  // Inline SDT — replaces just the run, not the paragraph
  return `</w:t></w:r><w:sdt><w:sdtPr><w:id w:val="${sdtId}"/><w:tag w:val="${escapeXml(tag)}"/><w:alias w:val="${escapeXml(alias)}"/><w:showingPlcHdr w:val="0"/></w:sdtPr><w:sdtContent><w:r><w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r></w:sdtContent></w:sdt><w:r><w:t xml:space="preserve">`;
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

  // 2. Process table-row repeating ({{#each-row}}...{{/each-row}}) — must run before
  //    paragraph-level repeating so that table rows are expanded first
  documentXml = processTableRowRepeating(documentXml, values);

  // 3. Process conditionals
  documentXml = processConditionals(documentXml, values);

  // 4. Process paragraph-level repeating sections
  documentXml = processRepeatingBlocks(documentXml, values);

  // 4. Replace mustache variables
  documentXml = replaceVariables(documentXml, values, options.mode, structuralTagRegistry);

  // 5. Update existing SDT values
  documentXml = updateExistingSdts(documentXml, values);

  // 6. Cleanup: remove empty runs and paragraphs left by marker processing
  documentXml = cleanupEmptyElements(documentXml);

  // 7. Structural tagging (disabled until Word Add-In is built)
  // if (options.mode === "live") {
  //   documentXml = applyStructuralTags(documentXml, structuralTagRegistry);
  // }

  // Write back document.xml
  zip.file("word/document.xml", documentXml);

  // Metadata embedding disabled until Word Add-In is built
  // Custom XML parts require proper OPC relationships to avoid corrupting the .docx

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
