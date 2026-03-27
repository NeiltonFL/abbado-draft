import JSZip from "jszip";

// ── Types ──

export interface ParsedVariable {
  name: string;
  type: string; // text, date, number, dropdown, boolean, richText
  label?: string;
  defaultValue?: string;
  source: "sdt" | "mustache" | "conditional" | "repeating";
  locations: VariableLocation[];
}

export interface VariableLocation {
  type: "sdt" | "mustache" | "conditional_block" | "repeating_block";
  xmlPath?: string; // approximate location in document.xml
}

export interface ConditionalBlock {
  condition: string; // e.g., "entity_type == 'Corporation'"
  variable: string; // the variable being tested
  operator: string; // eq, neq, gt, lt, contains, empty, notEmpty
  value: string;
}

export interface RepeatingBlock {
  collection: string; // e.g., "founders"
  itemVariables: string[]; // e.g., ["founders.$.name", "founders.$.shares"]
}

export interface ParsedSchema {
  variables: ParsedVariable[];
  conditionals: ConditionalBlock[];
  repeatingBlocks: RepeatingBlock[];
  rawSdtCount: number;
  rawMustacheCount: number;
}

// ── SDT Parsing ──

/**
 * Extract Content Controls (SDTs) from document XML.
 * Each SDT has a tag (variable name) and optional alias (display label).
 */
export function extractSdts(documentXml: string): ParsedVariable[] {
  const variables: ParsedVariable[] = [];
  const sdtPattern = /<w:sdt\b[^>]*>([\s\S]*?)<\/w:sdt>/g;
  let match;

  while ((match = sdtPattern.exec(documentXml)) !== null) {
    const sdtContent = match[1];

    // Extract tag value (variable name)
    const tagMatch = sdtContent.match(/<w:tag\s+w:val="([^"]+)"/);
    if (!tagMatch) continue;
    const tag = tagMatch[1];

    // Skip system/built-in SDTs
    if (tag.startsWith("tpl_") || tag.startsWith("cond:") || tag.startsWith("repeat:")) continue;

    // Extract alias (display label)
    const aliasMatch = sdtContent.match(/<w:alias\s+w:val="([^"]+)"/);
    const label = aliasMatch ? aliasMatch[1] : undefined;

    // Determine type from SDT properties
    let type = "text";
    if (sdtContent.includes("<w:date")) type = "date";
    if (sdtContent.includes("<w:dropDownList") || sdtContent.includes("<w:comboBox")) type = "dropdown";
    if (sdtContent.includes("<w14:checkbox") || sdtContent.includes("<w:checkbox")) type = "boolean";

    // Extract current/placeholder value
    const valueMatch = sdtContent.match(/<w:sdtContent>([\s\S]*?)<\/w:sdtContent>/);
    let defaultValue: string | undefined;
    if (valueMatch) {
      // Extract text from all <w:t> elements inside the content
      const texts: string[] = [];
      const textPattern = /<w:t[^>]*>([^<]*)<\/w:t>/g;
      let textMatch;
      while ((textMatch = textPattern.exec(valueMatch[1])) !== null) {
        texts.push(textMatch[1]);
      }
      defaultValue = texts.join("") || undefined;
    }

    // Check if this variable already exists (may appear multiple times)
    const existing = variables.find((v) => v.name === tag);
    if (existing) {
      existing.locations.push({ type: "sdt" });
    } else {
      variables.push({
        name: tag,
        type,
        label,
        defaultValue,
        source: "sdt",
        locations: [{ type: "sdt" }],
      });
    }
  }

  return variables;
}

// ── Mustache Variable Parsing ──

/**
 * Extract {{variable_name}} patterns from document XML text content.
 * Handles Word's tendency to split text across multiple <w:r> elements.
 */
export function extractMustacheVariables(documentXml: string): ParsedVariable[] {
  const variables: ParsedVariable[] = [];

  // First, reassemble text that Word may have split across runs
  // We look for {{ and }} patterns in the full text content
  const allText = extractAllText(documentXml);

  // Simple variable: {{variable_name}} or {{variable_name|format}} or {{variable_name|format:arg}}
  const simplePattern = /\{\{([a-zA-Z_][a-zA-Z0-9_.$]*)(?:\|[^}]*)?\}\}/g;
  let match;

  while ((match = simplePattern.exec(allText)) !== null) {
    const name = match[1]; // Strip format modifier — just the variable name

    // Skip control flow markers
    if (name.startsWith("#") || name.startsWith("/") || name === "this") continue;

    const existing = variables.find((v) => v.name === name);
    if (existing) {
      existing.locations.push({ type: "mustache" });
    } else {
      variables.push({
        name,
        type: name.includes("date") ? "date" : name.includes("email") ? "text" : "text",
        source: "mustache",
        locations: [{ type: "mustache" }],
      });
    }
  }

  return variables;
}

// ── Conditional Block Parsing ──

/**
 * Extract {{#if condition}}...{{/if}} blocks.
 */
export function extractConditionals(documentXml: string): ConditionalBlock[] {
  const conditionals: ConditionalBlock[] = [];
  const allText = extractAllText(documentXml);

  // Match {{#if variable == "value"}} or {{#if variable}} patterns
  const ifPattern = /\{\{#if\s+(.+?)\}\}/g;
  let match;

  while ((match = ifPattern.exec(allText)) !== null) {
    const expression = match[1].trim();
    const parsed = parseCondition(expression);
    conditionals.push(parsed);
  }

  return conditionals;
}

/**
 * Parse a condition expression into structured form.
 * Supports: variable == "value", variable != "value", variable (truthy check)
 */
function parseCondition(expression: string): ConditionalBlock {
  // Check for comparison operators
  const compMatch = expression.match(/^(\S+)\s*(==|!=|>=|<=|>|<)\s*["']?([^"']*)["']?$/);
  if (compMatch) {
    return {
      condition: expression,
      variable: compMatch[1],
      operator: compMatch[2] === "==" ? "eq" : compMatch[2] === "!=" ? "neq" : compMatch[2],
      value: compMatch[3],
    };
  }

  // Simple truthy check: {{#if has_vesting}}
  return {
    condition: expression,
    variable: expression,
    operator: "truthy",
    value: "",
  };
}

// ── Repeating Block Parsing ──

/**
 * Extract {{#each collection}}...{{/each}} blocks.
 */
export function extractRepeatingBlocks(documentXml: string): RepeatingBlock[] {
  const blocks: RepeatingBlock[] = [];
  const allText = extractAllText(documentXml);

  const eachPattern = /\{\{#each\s+(\S+)\}\}([\s\S]*?)\{\{\/each\}\}/g;
  let match;

  while ((match = eachPattern.exec(allText)) !== null) {
    const collection = match[1];
    const blockContent = match[2];

    // Extract {{this.field}} references inside the block
    const itemVars: string[] = [];
    const thisPattern = /\{\{this\.([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;
    let varMatch;

    while ((varMatch = thisPattern.exec(blockContent)) !== null) {
      const fullName = `${collection}.$.${varMatch[1]}`;
      if (!itemVars.includes(fullName)) {
        itemVars.push(fullName);
      }
    }

    blocks.push({
      collection,
      itemVariables: itemVars,
    });
  }

  return blocks;
}

// ── Helper: Extract all text content from XML ──

function extractAllText(xml: string): string {
  const texts: string[] = [];
  const textPattern = /<w:t[^>]*>([^<]*)<\/w:t>/g;
  let match;
  while ((match = textPattern.exec(xml)) !== null) {
    texts.push(match[1]);
  }
  return texts.join("");
}

// ── Main Parser ──

/**
 * Parse a .docx file buffer and extract the complete variable schema.
 * This handles both SDT-based templates (from the add-in) and
 * mustache-syntax templates (manual authoring).
 */
export async function parseTemplate(docxBuffer: Buffer): Promise<ParsedSchema> {
  const zip = await JSZip.loadAsync(docxBuffer);

  // Read document.xml
  const docXmlFile = zip.file("word/document.xml");
  if (!docXmlFile) {
    throw new Error("Invalid .docx file: word/document.xml not found");
  }
  const documentXml = await docXmlFile.async("string");

  // Extract variables from both sources
  const sdtVars = extractSdts(documentXml);
  const mustacheVars = extractMustacheVariables(documentXml);
  const conditionals = extractConditionals(documentXml);
  const repeatingBlocks = extractRepeatingBlocks(documentXml);

  // Merge SDT and mustache variables (SDT takes precedence for type info)
  const merged = new Map<string, ParsedVariable>();

  for (const v of sdtVars) {
    merged.set(v.name, v);
  }

  for (const v of mustacheVars) {
    if (merged.has(v.name)) {
      // Add mustache locations to existing SDT variable
      const existing = merged.get(v.name)!;
      existing.locations.push(...v.locations);
    } else {
      merged.set(v.name, v);
    }
  }

  // Add variables discovered from repeating blocks
  for (const block of repeatingBlocks) {
    // The collection itself
    if (!merged.has(block.collection)) {
      merged.set(block.collection, {
        name: block.collection,
        type: "text",
        source: "repeating",
        locations: [{ type: "repeating_block" }],
      });
    }
    // Per-item variables
    for (const itemVar of block.itemVariables) {
      if (!merged.has(itemVar)) {
        merged.set(itemVar, {
          name: itemVar,
          type: "text",
          source: "repeating",
          locations: [{ type: "repeating_block" }],
        });
      }
    }
  }

  // Add variables discovered from conditionals
  for (const cond of conditionals) {
    if (!merged.has(cond.variable)) {
      merged.set(cond.variable, {
        name: cond.variable,
        type: cond.operator === "truthy" ? "boolean" : "text",
        source: "conditional",
        locations: [{ type: "conditional_block" }],
      });
    }
  }

  return {
    variables: Array.from(merged.values()),
    conditionals,
    repeatingBlocks,
    rawSdtCount: sdtVars.length,
    rawMustacheCount: mustacheVars.length,
  };
}

// ── Read Custom XML Parts ──

/**
 * Read Abbado Draft metadata from the .docx Custom XML Parts.
 * Returns null if no Draft metadata is present.
 */
export async function readCustomXmlParts(docxBuffer: Buffer): Promise<any | null> {
  const zip = await JSZip.loadAsync(docxBuffer);

  // Look for our custom XML part
  const customXmlFolder = zip.folder("customXml");
  if (!customXmlFolder) return null;

  const files = Object.keys(zip.files).filter(
    (f) => f.startsWith("customXml/item") && f.endsWith(".xml")
  );

  for (const file of files) {
    const content = await zip.file(file)?.async("string");
    if (content && content.includes("abbado-draft")) {
      try {
        // Our custom XML contains JSON wrapped in an XML element
        const jsonMatch = content.match(/<abbado-draft>([\s\S]*?)<\/abbado-draft>/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[1]);
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}
