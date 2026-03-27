/**
 * Logic Evaluation Service
 *
 * Evaluates computed/hidden variables from the Logic tab:
 * - Conditional Rules: IF/ELSE IF/ELSE chains
 * - Formulas: expression evaluation
 * - Lookup Tables: key→value mapping
 *
 * Also evaluates document output conditions to determine
 * which documents should be generated.
 */

// ── Types ──

interface ConditionRule {
  variable: string;
  operator: string;
  value: string;
  negate: boolean;
}

interface ConditionGroup {
  logic: "all" | "any";
  negate: boolean;
  rules: ConditionRule[];
}

interface ConditionData {
  groupLogic: "all" | "any";
  groups: ConditionGroup[];
}

interface LogicConfig {
  logicType: "conditional" | "formula" | "lookup";
  rules?: { condition: string; value: string }[];
  defaultValue?: string;
  formula?: string;
  lookupVariable?: string;
  lookupTable?: Record<string, string>;
  outputType?: string;
}

interface WorkflowVariable {
  name: string;
  type: string;
  isComputed: boolean;
  validation: any;
  expression: string | null;
}

// ── Main: Evaluate all logic variables ──

export function evaluateLogicVariables(
  variables: WorkflowVariable[],
  interviewValues: Record<string, any>
): Record<string, any> {
  const computed: Record<string, any> = {};
  const logicVars = variables.filter((v) => v.isComputed || v.type === "computed");

  for (const v of logicVars) {
    const cfg = (v.validation || {}) as LogicConfig;

    try {
      // Merge interview values with already-computed values so later logic vars can reference earlier ones
      const allValues = { ...interviewValues, ...computed };

      switch (cfg.logicType) {
        case "conditional":
          computed[v.name] = evaluateConditionalRules(cfg, allValues);
          break;
        case "formula":
          computed[v.name] = evaluateFormula(v.expression || cfg.formula || "", allValues);
          break;
        case "lookup":
          computed[v.name] = evaluateLookup(cfg, allValues);
          break;
        default:
          // Fallback: try expression if set
          if (v.expression) {
            computed[v.name] = evaluateFormula(v.expression, allValues);
          }
          break;
      }
    } catch (err) {
      // Don't fail generation because of a logic error — use empty string
      computed[v.name] = "";
      console.error(`Logic evaluation error for ${v.name}:`, err);
    }
  }

  return computed;
}

// ── Evaluate document output condition ──

export function shouldGenerateDocument(
  conditionJson: string | undefined | null,
  values: Record<string, any>
): boolean {
  if (!conditionJson) return true; // No condition = always generate
  return evaluateConditionData(conditionJson, values);
}

// ── Conditional Rules ──

function evaluateConditionalRules(cfg: LogicConfig, values: Record<string, any>): string {
  const rules = cfg.rules || [];

  for (const rule of rules) {
    if (!rule.condition) continue;
    if (evaluateConditionData(rule.condition, values)) {
      return interpolateVariables(rule.value, values);
    }
  }

  // No rule matched — return default
  return interpolateVariables(cfg.defaultValue || "", values);
}

// ── Formula Evaluation ──

function evaluateFormula(expression: string, values: Record<string, any>): any {
  if (!expression) return "";

  // First, interpolate {{variables}} in the expression
  let result = interpolateVariables(expression, values);

  // Try to evaluate simple math if the result looks numeric
  try {
    // Handle common functions
    result = evaluateFunctions(result, values);
  } catch {
    // Return as-is if function evaluation fails
  }

  return result;
}

function evaluateFunctions(expr: string, values: Record<string, any>): string {
  let result = expr;

  // upper(x)
  result = result.replace(/upper\(([^)]+)\)/g, (_, arg) => String(arg).toUpperCase());
  // lower(x)
  result = result.replace(/lower\(([^)]+)\)/g, (_, arg) => String(arg).toLowerCase());
  // capitalize(x)
  result = result.replace(/capitalize\(([^)]+)\)/g, (_, arg) => {
    const s = String(arg);
    return s.charAt(0).toUpperCase() + s.slice(1);
  });
  // trim(x)
  result = result.replace(/trim\(([^)]+)\)/g, (_, arg) => String(arg).trim());

  // count(repeating)
  result = result.replace(/count\((\w+)\)/g, (_, name) => {
    const val = values[name];
    return String(Array.isArray(val) ? val.length : 0);
  });

  // sum(repeating.$.field)
  result = result.replace(/sum\((\w+)\.\$\.(\w+)\)/g, (_, name, field) => {
    const arr = values[name];
    if (!Array.isArray(arr)) return "0";
    return String(arr.reduce((sum: number, item: any) => sum + (Number(item[field]) || 0), 0));
  });

  // join(repeating.$.field, separator)
  result = result.replace(/join\((\w+)\.\$\.(\w+),\s*"([^"]*)"\)/g, (_, name, field, sep) => {
    const arr = values[name];
    if (!Array.isArray(arr)) return "";
    return arr.map((item: any) => String(item[field] || "")).join(sep);
  });

  // if(condition, then, else) — simple string equality
  result = result.replace(
    /if\((\w+)\s*==\s*"([^"]*)",\s*"([^"]*)",\s*"([^"]*)"\)/g,
    (_, varName, compareVal, thenVal, elseVal) => {
      const actual = String(values[varName] || "");
      return actual === compareVal ? thenVal : elseVal;
    }
  );

  // if(variable, then, else) — truthy check
  result = result.replace(
    /if\((\w+),\s*"([^"]*)",\s*"([^"]*)"\)/g,
    (_, varName, thenVal, elseVal) => {
      const val = values[varName];
      return val && val !== "false" && val !== "0" && val !== "" ? thenVal : elseVal;
    }
  );

  // if(variable, then + variable + then, else) — with concatenation in then/else
  result = result.replace(
    /if\((\w+),\s*(\w+)\s*\+\s*"([^"]*)",\s*"([^"]*)"\)/g,
    (_, condVar, thenVar, thenSuffix, elseVal) => {
      const val = values[condVar];
      return val && val !== "false" && val !== "0" && val !== ""
        ? String(values[thenVar] || "") + thenSuffix
        : elseVal;
    }
  );

  // format_currency(x)
  result = result.replace(/format_currency\(([^)]+)\)/g, (_, arg) => {
    const num = Number(arg);
    return isNaN(num) ? arg : `$${num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  });

  // format_number(x, decimals)
  result = result.replace(/format_number\(([^,]+),\s*(\d+)\)/g, (_, numStr, dec) => {
    const num = Number(numStr);
    return isNaN(num) ? numStr : num.toLocaleString("en-US", { minimumFractionDigits: Number(dec), maximumFractionDigits: Number(dec) });
  });

  // round(x, decimals?)
  result = result.replace(/round\(([^,)]+)(?:,\s*(\d+))?\)/g, (_, numStr, dec) => {
    const num = Number(numStr);
    if (isNaN(num)) return numStr;
    const d = dec ? Number(dec) : 0;
    return String(Math.round(num * Math.pow(10, d)) / Math.pow(10, d));
  });

  // pluralize(n, singular, plural)
  result = result.replace(/pluralize\(([^,]+),\s*"([^"]*)",\s*"([^"]*)"\)/g, (_, numStr, singular, plural) => {
    return Number(numStr) === 1 ? singular : plural;
  });

  // ordinal(n)
  result = result.replace(/ordinal\(([^)]+)\)/g, (_, numStr) => {
    const n = Number(numStr);
    if (isNaN(n)) return numStr;
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  });

  // Simple math: try to evaluate if the result is a pure math expression
  if (/^[\d\s+\-*/().%]+$/.test(result)) {
    try {
      // Safe math evaluation (no eval — use Function constructor with restricted scope)
      const mathResult = new Function(`return (${result})`)();
      if (typeof mathResult === "number" && isFinite(mathResult)) {
        return String(mathResult);
      }
    } catch {}
  }

  return result;
}

// ── Lookup Table ──

function evaluateLookup(cfg: LogicConfig, values: Record<string, any>): string {
  const table = cfg.lookupTable || {};
  const sourceValue = String(values[cfg.lookupVariable || ""] || "");

  if (table[sourceValue] !== undefined) {
    return interpolateVariables(table[sourceValue], values);
  }

  return interpolateVariables(cfg.defaultValue || "", values);
}

// ── Condition Evaluation ──

function evaluateConditionData(conditionJson: string, values: Record<string, any>): boolean {
  if (!conditionJson) return true;

  try {
    const parsed = JSON.parse(conditionJson);

    // Multi-group format
    if (parsed.groups && Array.isArray(parsed.groups)) {
      const groupResults = parsed.groups.map((group: ConditionGroup) => {
        const ruleResults = group.rules.map((rule: ConditionRule) => evaluateRule(rule, values));
        const groupResult = group.logic === "any" ? ruleResults.some(Boolean) : ruleResults.every(Boolean);
        return group.negate ? !groupResult : groupResult;
      });
      return parsed.groupLogic === "any" ? groupResults.some(Boolean) : groupResults.every(Boolean);
    }

    // Old flat format
    if (parsed.conditions && Array.isArray(parsed.conditions)) {
      const results = parsed.conditions.map((rule: any) => evaluateRule({ ...rule, negate: false }, values));
      return parsed.logic === "any" ? results.some(Boolean) : results.every(Boolean);
    }
  } catch {}

  // Legacy string format
  return evaluateLegacyCondition(conditionJson, values);
}

function evaluateRule(rule: ConditionRule, values: Record<string, any>): boolean {
  const actual = values[rule.variable];
  const actualStr = String(actual ?? "");

  let result: boolean;
  switch (rule.operator) {
    case "eq": result = actualStr === rule.value; break;
    case "neq": result = actualStr !== rule.value; break;
    case "gt": result = Number(actual) > Number(rule.value); break;
    case "lt": result = Number(actual) < Number(rule.value); break;
    case "gte": result = Number(actual) >= Number(rule.value); break;
    case "lte": result = Number(actual) <= Number(rule.value); break;
    case "contains": result = actualStr.toLowerCase().includes(rule.value.toLowerCase()); break;
    case "truthy": result = Boolean(actual) && actual !== "false" && actual !== "0" && actualStr !== ""; break;
    case "falsy": result = !actual || actual === "false" || actual === "0" || actualStr === ""; break;
    default: result = true;
  }
  return rule.negate ? !result : result;
}

function evaluateLegacyCondition(condition: string, values: Record<string, any>): boolean {
  const match = condition.match(/^(\S+)\s*(==|!=|>|<)\s*["']?([^"']*)["']?$/);
  if (match) {
    const [, varName, op, compareVal] = match;
    const actual = String(values[varName] || "");
    if (op === "==") return actual === compareVal;
    if (op === "!=") return actual !== compareVal;
    if (op === ">") return Number(values[varName]) > Number(compareVal);
    if (op === "<") return Number(values[varName]) < Number(compareVal);
  }
  if (condition.startsWith("!")) {
    const v = values[condition.slice(1)];
    return !v || v === "false" || v === "0" || String(v) === "";
  }
  const v = values[condition.trim()];
  return Boolean(v) && v !== "false" && v !== "0" && String(v) !== "";
}

// ── Variable Interpolation ──

function interpolateVariables(template: string, values: Record<string, any>): string {
  if (!template) return "";

  return template.replace(/\{\{([^}]+)\}\}/g, (_, varName) => {
    const trimmed = varName.trim();
    // Support dot notation: address.street, founders.0.name
    const parts = trimmed.split(".");
    let current: any = values;
    for (const part of parts) {
      if (current === undefined || current === null) return "";
      current = current[part];
    }
    return current !== undefined && current !== null ? String(current) : "";
  });
}
