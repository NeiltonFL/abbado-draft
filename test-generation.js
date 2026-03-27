// Test the Word generation engine locally with sample data
const fs = require("fs");
const JSZip = require("jszip");

// Import the engine functions
async function test() {
  // Read the test template
  const templateBuffer = fs.readFileSync("/mnt/user-data/outputs/test-template-cert-of-inc.docx");
  const zip = await JSZip.loadAsync(templateBuffer);
  let docXml = await zip.file("word/document.xml").async("string");

  console.log("=== ORIGINAL TEMPLATE ===");
  console.log("Length:", docXml.length);
  console.log("Has {{company_name}}:", docXml.includes("{{company_name}}"));
  console.log("Has {{#if has_indemnification}}:", docXml.includes("{{#if has_indemnification}}"));
  console.log("Has {{#each founders}}:", docXml.includes("{{#each founders}}"));
  console.log();

  // Sample values (simulating what preprocessValues would produce)
  const values = {
    company_name: "CoFounderKit Inc.",
    state: "Delaware",
    registered_agent_address: "1209 Orange St, Wilmington, DE 19801",
    registered_agent_name: "National Registered Agents Inc.",
    business_purpose: "any lawful act or activity for which corporations may be organized under the General Corporation Law of Delaware",
    authorized_shares: "10000000",
    par_value: "0.0001",
    incorporator_name: "Matt McElwee",
    incorporator_address: "123 Main Street, City, ST 12345",
    has_indemnification: "false", // Test FALSE case
    formation_date: "March 27, 2026",
    founders: [
      { name: "John Smith", shares: "5000000", email: "john@cofunderkit.com", title: "CEO" },
      { name: "Jane Doe", shares: "3000000", email: "jane@cofunderkit.com", title: "CTO" },
    ],
  };

  // Step 1: Process conditionals
  function evaluateCondition(expression, vals) {
    const compMatch = expression.match(/^(\S+)\s*(==|!=|>=|<=|>|<)\s*["']?([^"']*)["']?$/);
    if (compMatch) {
      const [, varName, operator, compareValue] = compMatch;
      const actualValue = vals[varName];
      if (operator === "==") return String(actualValue) === compareValue;
      if (operator === "!=") return String(actualValue) !== compareValue;
      return false;
    }
    const val = vals[expression.trim()];
    return Boolean(val) && val !== "false" && val !== "0" && val !== "";
  }

  function processConditionals(xml, vals) {
    let result = xml;
    let changed = true;
    let iter = 0;
    while (changed && iter < 50) {
      changed = false; iter++;
      const ifElseP = /\{\{#if\s+(.+?)\}\}([\s\S]*?)\{\{else\}\}([\s\S]*?)\{\{\/if\}\}/;
      const ifOnlyP = /\{\{#if\s+(.+?)\}\}([\s\S]*?)\{\{\/if\}\}/;
      const em = result.match(ifElseP);
      if (em && !em[2].includes("{{#if")) {
        result = result.replace(em[0], evaluateCondition(em[1], vals) ? em[2] : em[3]);
        changed = true; continue;
      }
      const im = result.match(ifOnlyP);
      if (im && !im[2].includes("{{#if")) {
        result = result.replace(im[0], evaluateCondition(im[1], vals) ? im[2] : "");
        changed = true;
      }
    }
    return result;
  }

  docXml = processConditionals(docXml, values);
  console.log("=== AFTER CONDITIONALS (has_indemnification=false) ===");
  console.log("Contains INDEMNIFICATION:", docXml.includes("INDEMNIFICATION"));
  console.log("Expected: false");
  console.log();

  // Step 2: Process repeating blocks
  function processRepeating(xml, vals) {
    let result = xml;
    let changed = true;
    let iter = 0;
    while (changed && iter < 50) {
      changed = false; iter++;
      const eachP = /\{\{#each\s+(\S+)\}\}([\s\S]*?)\{\{\/each\}\}/;
      const match = result.match(eachP);
      if (match && !match[2].includes("{{#each")) {
        const items = vals[match[1]];
        if (Array.isArray(items) && items.length > 0) {
          const expanded = items.map((item, index) => {
            let content = match[2];
            content = content.replace(/\{\{this\.([a-zA-Z_]\w*)\}\}/g, (_, field) => {
              const val = item[field];
              return val !== undefined && val !== null ? String(val) : "";
            });
            content = content.replace(/\{\{@index\}\}/g, String(index + 1));
            return content;
          }).join("");
          result = result.replace(match[0], expanded);
        } else {
          result = result.replace(match[0], "");
        }
        changed = true;
      }
    }
    return result;
  }

  docXml = processRepeating(docXml, values);
  console.log("=== AFTER REPEATING ===");
  console.log("Contains 'John Smith':", docXml.includes("John Smith"));
  console.log("Contains 'Jane Doe':", docXml.includes("Jane Doe"));
  console.log("Contains '5000000':", docXml.includes("5000000"));
  console.log();

  // Step 3: Replace variables
  function escapeXml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  docXml = docXml.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_.$]*)\}\}/g, (_, varName) => {
    if (varName.startsWith("#") || varName.startsWith("/") || varName.startsWith("@")) return _;
    const parts = varName.split(".");
    let current = values;
    for (const part of parts) {
      if (current === undefined || current === null) return "";
      current = current[part];
    }
    return current !== undefined && current !== null ? escapeXml(String(current)) : "";
  });

  console.log("=== AFTER VARIABLE REPLACEMENT ===");
  console.log("Contains 'CoFounderKit Inc.':", docXml.includes("CoFounderKit Inc."));
  console.log("Contains '{{company_name}}':", docXml.includes("{{company_name}}"));
  console.log("Contains '[object Object]':", docXml.includes("[object Object]"));
  console.log("Contains '1209 Orange St':", docXml.includes("1209 Orange St"));
  console.log("Contains 'March 27, 2026':", docXml.includes("March 27, 2026"));
  console.log();

  // Write back and save
  zip.file("word/document.xml", docXml);
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  fs.writeFileSync("/mnt/user-data/outputs/test-generated-output.docx", buffer);
  console.log("=== OUTPUT SAVED ===");
  console.log("File size:", buffer.length, "bytes");
  console.log("Open test-generated-output.docx in Word to verify!");
}

test().catch(console.error);
