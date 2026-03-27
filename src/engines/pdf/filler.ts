import { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup } from "pdf-lib";

// ── Types ──

export interface PdfFieldMapping {
  /** PDF form field name (exact match) */
  pdfField: string;
  /** Workflow variable name or literal value */
  value: string;
  /** How to interpret the value */
  type?: "variable" | "literal" | "checkbox" | "date";
  /** For checkboxes: the variable value that means "checked" (default: "true") */
  checkedWhen?: string;
  /** Date format for date fields */
  dateFormat?: "long" | "short" | "iso" | "month-year" | "year";
}

export interface PdfFillOptions {
  /** Map of workflow variable names → values */
  values: Record<string, any>;
  /** Field mappings: how to connect PDF fields to workflow variables */
  fieldMappings: PdfFieldMapping[];
  /** Whether to flatten the form (make fields non-editable) */
  flatten?: boolean;
}

export interface PdfFillResult {
  buffer: Buffer;
  filledFields: string[];
  skippedFields: string[];
}

// ── Format Helpers ──

function formatDate(value: any, format?: string): string {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);

  switch (format) {
    case "long":
      return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    case "short":
      return d.toLocaleDateString("en-US", { year: "numeric", month: "2-digit", day: "2-digit" });
    case "month-year":
      return d.toLocaleDateString("en-US", { year: "numeric", month: "long" });
    case "year":
      return String(d.getFullYear());
    case "iso":
      return d.toISOString().slice(0, 10);
    default:
      return d.toLocaleDateString("en-US", { year: "numeric", month: "2-digit", day: "2-digit" });
  }
}

function resolveValue(mapping: PdfFieldMapping, values: Record<string, any>): string {
  if (mapping.type === "literal") {
    return mapping.value;
  }

  // Resolve variable name from the values dict
  let val = values[mapping.value];

  // Support dot notation: "company_address.city"
  if (val === undefined && mapping.value.includes(".")) {
    const parts = mapping.value.split(".");
    let current: any = values;
    for (const part of parts) {
      if (current === undefined || current === null) break;
      current = current[part];
    }
    val = current;
  }

  if (val === undefined || val === null) return "";

  // Format dates
  if (mapping.type === "date") {
    return formatDate(val, mapping.dateFormat);
  }

  return String(val);
}

// ── Main Filler ──

/**
 * Fill a PDF form template with variable values.
 *
 * Supports:
 * - Text fields (PDFTextField)
 * - Checkboxes (PDFCheckBox)
 * - Dropdowns (PDFDropdown)
 * - Radio groups (PDFRadioGroup)
 *
 * Field mappings connect PDF field names to workflow variables.
 * The mapping can specify literal values, variable lookups, checkbox logic, and date formatting.
 */
export async function fillPdfForm(
  templateBuffer: Buffer,
  options: PdfFillOptions
): Promise<PdfFillResult> {
  const pdfDoc = await PDFDocument.load(templateBuffer);
  const form = pdfDoc.getForm();

  const filledFields: string[] = [];
  const skippedFields: string[] = [];

  for (const mapping of options.fieldMappings) {
    try {
      const resolvedValue = resolveValue(mapping, options.values);

      // Try to find the field
      let field;
      try {
        field = form.getField(mapping.pdfField);
      } catch {
        skippedFields.push(mapping.pdfField);
        continue;
      }

      if (field instanceof PDFTextField) {
        field.setText(resolvedValue || "");
        filledFields.push(mapping.pdfField);
      } else if (field instanceof PDFCheckBox) {
        const shouldCheck = mapping.type === "checkbox"
          ? resolvedValue === (mapping.checkedWhen || "true")
          : Boolean(resolvedValue) && resolvedValue !== "false" && resolvedValue !== "0";

        if (shouldCheck) {
          field.check();
        } else {
          field.uncheck();
        }
        filledFields.push(mapping.pdfField);
      } else if (field instanceof PDFDropdown) {
        if (resolvedValue) {
          try {
            field.select(resolvedValue);
          } catch {
            // Value not in dropdown options — skip
            skippedFields.push(mapping.pdfField);
            continue;
          }
        }
        filledFields.push(mapping.pdfField);
      } else if (field instanceof PDFRadioGroup) {
        if (resolvedValue) {
          try {
            field.select(resolvedValue);
          } catch {
            skippedFields.push(mapping.pdfField);
            continue;
          }
        }
        filledFields.push(mapping.pdfField);
      } else {
        skippedFields.push(mapping.pdfField);
      }
    } catch (err) {
      skippedFields.push(mapping.pdfField);
    }
  }

  // Optionally flatten the form (make fields non-editable)
  if (options.flatten) {
    form.flatten();
  }

  const pdfBytes = await pdfDoc.save();
  const buffer = Buffer.from(pdfBytes);

  return { buffer, filledFields, skippedFields };
}

// ── Parse PDF Fields ──

/**
 * Extract all form field names and types from a PDF.
 * Used by the template parser to show available fields in the UI.
 */
export async function parsePdfFields(
  buffer: Buffer
): Promise<{ name: string; type: string; options?: string[] }[]> {
  const pdfDoc = await PDFDocument.load(buffer);
  const form = pdfDoc.getForm();
  const fields = form.getFields();

  return fields.map((field) => {
    const name = field.getName();
    let type = "unknown";
    let options: string[] | undefined;

    if (field instanceof PDFTextField) {
      type = "text";
    } else if (field instanceof PDFCheckBox) {
      type = "checkbox";
    } else if (field instanceof PDFDropdown) {
      type = "dropdown";
      options = field.getOptions();
    } else if (field instanceof PDFRadioGroup) {
      type = "radio";
      options = field.getOptions();
    }

    return { name, type, ...(options ? { options } : {}) };
  });
}
