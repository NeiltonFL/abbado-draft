import JSZip from "jszip";
import { readCustomXmlParts } from "./parser";

// ── Types ──

export interface VariableChange {
  name: string;
  from: any;
  to: any;
}

export interface DocumentReadResult {
  currentValues: Record<string, any>;
  changes: VariableChange[];
  metadata: any | null;
  sdtCount: number;
  expectedSdtCount: number;
  integrityOk: boolean;
}

// ── SDT Value Reading ──

/**
 * Read all SDT (Content Control) values from a generated .docx document.
 * Returns a map of { variableName: currentValue }.
 *
 * This is the core of the edit-from-document detection flow.
 * When a user edits an SDT value in Word and saves, this function
 * reads the new values and compares against the stored snapshot.
 */
export async function readSdtValues(docxBuffer: Buffer): Promise<Record<string, any>> {
  const zip = await JSZip.loadAsync(docxBuffer);

  const docXmlFile = zip.file("word/document.xml");
  if (!docXmlFile) {
    throw new Error("Invalid .docx: word/document.xml not found");
  }
  const documentXml = await docXmlFile.async("string");

  const values: Record<string, any> = {};
  const sdtPattern = /<w:sdt\b[^>]*>([\s\S]*?)<\/w:sdt>/g;
  let match;

  while ((match = sdtPattern.exec(documentXml)) !== null) {
    const sdtContent = match[1];

    // Extract tag (variable name)
    const tagMatch = sdtContent.match(/<w:tag\s+w:val="([^"]+)"/);
    if (!tagMatch) continue;
    const tag = tagMatch[1];

    // Skip structural tags (tpl_p_*, tpl_tbl_*) and conditional/repeating tags
    if (tag.startsWith("tpl_") || tag.startsWith("cond:") || tag.startsWith("repeat:")) continue;

    // Also skip variable wrapper tags (var_*)
    if (tag.startsWith("var_")) continue;

    // Extract current text value
    const contentMatch = sdtContent.match(/<w:sdtContent>([\s\S]*?)<\/w:sdtContent>/);
    if (!contentMatch) continue;

    const texts: string[] = [];
    const textPattern = /<w:t[^>]*>([^<]*)<\/w:t>/g;
    let textMatch;
    while ((textMatch = textPattern.exec(contentMatch[1])) !== null) {
      texts.push(textMatch[1]);
    }

    const currentValue = texts.join("");

    // Handle indexed variables (from repeating blocks): founders[0].name
    // If multiple SDTs have the same base name, collect them
    if (tag.includes("[") && tag.includes("].")) {
      // This is a repeating item field, e.g., founders[0].name
      const collMatch = tag.match(/^(\w+)\[(\d+)\]\.(\w+)$/);
      if (collMatch) {
        const [, collection, indexStr, field] = collMatch;
        const index = parseInt(indexStr);

        if (!values[collection]) values[collection] = [];
        while (values[collection].length <= index) {
          values[collection].push({});
        }
        values[collection][index][field] = currentValue;
        continue;
      }
    }

    values[tag] = currentValue;
  }

  return values;
}

// ── Change Detection ──

/**
 * Compare current SDT values against the stored variable snapshot.
 * Returns a list of changes (what changed, from what, to what).
 */
export function detectChanges(
  currentValues: Record<string, any>,
  snapshot: Record<string, any>
): VariableChange[] {
  const changes: VariableChange[] = [];

  for (const [key, currentVal] of Object.entries(currentValues)) {
    const snapshotVal = snapshot[key];

    if (Array.isArray(currentVal) && Array.isArray(snapshotVal)) {
      // Compare arrays (repeating sections) item by item
      const maxLen = Math.max(currentVal.length, snapshotVal.length);
      for (let i = 0; i < maxLen; i++) {
        const currentItem = currentVal[i] || {};
        const snapshotItem = snapshotVal[i] || {};

        for (const field of new Set([...Object.keys(currentItem), ...Object.keys(snapshotItem)])) {
          if (String(currentItem[field] || "") !== String(snapshotItem[field] || "")) {
            changes.push({
              name: `${key}[${i}].${field}`,
              from: snapshotItem[field],
              to: currentItem[field],
            });
          }
        }
      }

      // Detect added/removed items
      if (currentVal.length !== snapshotVal.length) {
        changes.push({
          name: `${key}.length`,
          from: snapshotVal.length,
          to: currentVal.length,
        });
      }
    } else {
      // Simple value comparison
      if (String(currentVal) !== String(snapshotVal ?? "")) {
        changes.push({
          name: key,
          from: snapshotVal,
          to: currentVal,
        });
      }
    }
  }

  // Check for variables in snapshot that aren't in current (deleted SDTs)
  for (const key of Object.keys(snapshot)) {
    if (!(key in currentValues) && !Array.isArray(snapshot[key])) {
      // Variable SDT was removed — flag it but don't treat as a change
      // (could be a structural edit that broke the SDT)
    }
  }

  return changes;
}

// ── Full Document Read ──

/**
 * Read a generated document, extract all current values, compare against
 * the stored snapshot, and return a complete read result.
 */
export async function readGeneratedDocument(docxBuffer: Buffer): Promise<DocumentReadResult> {
  // Read metadata from Custom XML Parts
  const metadata = await readCustomXmlParts(docxBuffer);

  // Read current SDT values
  const currentValues = await readSdtValues(docxBuffer);

  // Get snapshot from metadata (if available)
  const snapshot = metadata?.variableSnapshot || {};
  const expectedRegistry = metadata?.structuralTagRegistry || {};

  // Detect changes
  const changes = detectChanges(currentValues, snapshot);

  // Count SDTs for integrity check
  const sdtCount = Object.keys(currentValues).length;
  const expectedSdtCount = Object.keys(expectedRegistry).filter(
    (k) => !k.startsWith("tpl_") && !k.startsWith("var_")
  ).length;

  // Integrity check: are most SDTs still present?
  // If a significant number are missing, the document structure may be damaged
  const integrityOk = expectedSdtCount === 0 || sdtCount >= expectedSdtCount * 0.8;

  return {
    currentValues,
    changes,
    metadata,
    sdtCount,
    expectedSdtCount,
    integrityOk,
  };
}
