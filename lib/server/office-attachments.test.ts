import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { extractOfficeText } from "../office-text";

async function archive(files: Record<string, string>) {
  const zip = new JSZip();
  for (const [name, text] of Object.entries(files)) zip.file(name, text);
  return zip.generateAsync({ type: "uint8array" });
}
test("DOCX preserves paragraph order, split runs and table cell text", async () => {
  const data = await archive({ "word/document.xml": '<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>world</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Revenue</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>100</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>' });
  const text = await extractOfficeText(data, "test.docx");
  assert.ok(text.startsWith("Hello world\n"));
  assert.match(text, /Revenue[\s]+100/);
});
test("PPTX follows presentation order rather than filenames", async () => {
  const data = await archive({
    "ppt/presentation.xml": '<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldIdLst><p:sldId id="256" r:id="r2"/><p:sldId id="257" r:id="r1"/></p:sldIdLst></p:presentation>',
    "ppt/_rels/presentation.xml.rels": '<Relationships><Relationship Id="r1" Target="slides/slide1.xml"/><Relationship Id="r2" Target="slides/slide2.xml"/></Relationships>',
    "ppt/slides/slide1.xml": '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>',
    "ppt/slides/slide2.xml": '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>First</a:t></a:r></a:p></p:sld>',
  });
  assert.equal(await extractOfficeText(data, "test.pptx"), "Slide 1\nFirst\n\nSlide 2\nSecond");
});
for (const bookType of ["xlsx", "xls"] as const) test(`${bookType} retains multiple sheets and their values`, async () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Name", "Value"], ["Coffee", 42]]), "Sales");
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Costs", 12]]), "Costs");
  const text = await extractOfficeText(new Uint8Array(XLSX.write(book, { bookType, type: "array" })), `test.${bookType}`);
  assert.match(text, /Worksheet: Sales\nName,Value\nCoffee,42/);
  assert.match(text, /Worksheet: Costs\nCosts,12/);
});
test("oversized extracted documents and broken Office files are rejected", async () => {
  const data = await archive({ "word/document.xml": `<document><p><t>${"x".repeat(4001)}</t></p></document>` });
  await assert.rejects(extractOfficeText(data, "large.docx"), /4,000/);
  await assert.rejects(extractOfficeText(new Uint8Array([1, 2, 3]), "broken.docx"));
});
