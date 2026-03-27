const JSZip = require("jszip");
const fs = require("fs");

async function createTestDocx() {
  const zip = new JSZip();

  const contentTypes = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    "</Types>",
  ].join("");

  const rels = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
    "</Relationships>",
  ].join("");

  const wordRels = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    "</Relationships>",
  ].join("");

  const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
  const b = "<w:rPr><w:b/></w:rPr>";
  const bLg = "<w:rPr><w:b/><w:sz w:val=\"36\"/></w:rPr>";
  const bMd = "<w:rPr><w:b/><w:sz w:val=\"28\"/></w:rPr>";
  const ctr = '<w:pPr><w:jc w:val="center"/></w:pPr>';

  const p = (text, rpr, ppr) =>
    `<w:p>${ppr || ""}${rpr ? `<w:r>${rpr}<w:t xml:space="preserve">${text}</w:t></w:r>` : `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`}</w:p>`;

  const body = [
    // Title
    `<w:p>${ctr}<w:r>${bLg}<w:t>CERTIFICATE OF INCORPORATION</w:t></w:r></w:p>`,
    `<w:p>${ctr}<w:r><w:t>of</w:t></w:r></w:p>`,
    `<w:p>${ctr}<w:r>${bMd}<w:t>{{company_name}}</w:t></w:r></w:p>`,
    "<w:p/>",

    // Article I
    p("ARTICLE I - NAME", b),
    p('The name of the corporation is {{company_name}} (the "Corporation").'),
    "<w:p/>",

    // Article II
    p("ARTICLE II - REGISTERED AGENT", b),
    p("The address of the registered office of the Corporation in the State of {{state}} is {{registered_agent_address}}. The name of the registered agent at such address is {{registered_agent_name}}."),
    "<w:p/>",

    // Article III
    p("ARTICLE III - PURPOSE", b),
    p("The purpose of the Corporation is to engage in {{business_purpose}}."),
    "<w:p/>",

    // Article IV
    p("ARTICLE IV - AUTHORIZED STOCK", b),
    p("The total number of shares of stock which the Corporation shall have authority to issue is {{authorized_shares}} shares of Common Stock, each having a par value of ${{par_value}} per share."),
    "<w:p/>",

    // Article V
    p("ARTICLE V - INCORPORATOR", b),
    p("The name and mailing address of the incorporator is {{incorporator_name}}, {{incorporator_address}}."),
    "<w:p/>",

    // Conditional: Indemnification
    p("{{#if has_indemnification}}"),
    p("ARTICLE VI - INDEMNIFICATION", b),
    p("The Corporation shall indemnify any person who was or is a party to any proceeding by reason of the fact that such person is or was a director or officer of the Corporation, to the fullest extent permitted by applicable law."),
    p("{{/if}}"),
    "<w:p/>",

    // Repeating: Founders
    p("INITIAL STOCKHOLDERS", b),
    p("{{#each founders}}"),
    p("{{@index}}. {{this.name}} - {{this.shares}} shares ({{this.email}})"),
    p("{{/each}}"),
    "<w:p/>",

    // Signature
    p("IN WITNESS WHEREOF, the undersigned incorporator has executed this Certificate of Incorporation on {{formation_date}}."),
    "<w:p/>",
    "<w:p/>",
    p("_____________________________"),
    p("{{incorporator_name}}, Incorporator"),
  ].join("");

  const documentXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<w:document ${ns}>`,
    `<w:body>${body}</w:body>`,
    "</w:document>",
  ].join("");

  zip.file("[Content_Types].xml", contentTypes);
  zip.file("_rels/.rels", rels);
  zip.file("word/_rels/document.xml.rels", wordRels);
  zip.file("word/document.xml", documentXml);

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
  fs.writeFileSync("/mnt/user-data/outputs/test-template-cert-of-inc.docx", buffer);
  console.log("Created: " + buffer.length + " bytes");
  console.log("Variables: company_name, state, registered_agent_address, registered_agent_name, business_purpose, authorized_shares, par_value, incorporator_name, incorporator_address, has_indemnification, founders[].name, founders[].shares, founders[].email, formation_date");
}

createTestDocx().catch(console.error);
