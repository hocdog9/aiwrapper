import { MAX_MESSAGE_CHARACTERS } from "./chat-context";
import JSZip from "jszip";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import * as XLSX from "xlsx";

const MAX_EXTRACTED = MAX_MESSAGE_CHARACTERS;
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, trimValues: false, parseTagValue: false });
type XmlNode = { [key: string]: XmlNode[] | string | Record<string, string> };
const localName = (name: string) => name.split(":").pop();
function parse(xml: string): XmlNode[] {
  if (xml.length > 2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error("This document contains unsupported or damaged XML.");
  return parser.parse(xml) as XmlNode[];
}
function find(nodes: XmlNode[], name: string): XmlNode[] {
  return nodes.flatMap(node => Object.entries(node).flatMap(([key, children]) =>
    Array.isArray(children) ? [...(localName(key) === name ? [node] : []), ...find(children, name)] : []));
}
function text(nodes: XmlNode[]): string {
  return nodes.map(node => Object.entries(node).map(([key, value]) => {
    const tag = localName(key);
    if (tag === "t" && Array.isArray(value)) return value.map(v => v["#text"] ?? "").join("");
    if (tag === "tab") return "\t";
    if (tag === "br") return "\n";
    if (!Array.isArray(value) || tag === "del") return "";
    return text(value) + (tag === "p" || tag === "tr" ? "\n" : tag === "tc" ? "\t" : "");
  }).join("")).join("");
}
function bounded(value: string): string {
  if (value.length > MAX_EXTRACTED) throw new Error("This document contains more than 100,000 characters. Upload a smaller selection of pages, slides or cells; nothing was truncated.");
  return value;
}
async function readXml(zip: JSZip, path: string) {
  const entry = zip.file(path);
  if (!entry) throw new Error("This document is missing required content. Try saving a new copy.");
  // Stream with a size limit instead of materializing an unbounded ZIP entry.
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    type Stream = {
      on(event: "data", callback: (chunk: Uint8Array) => void): Stream;
      on(event: "error", callback: (error: Error) => void): Stream;
      on(event: "end", callback: () => void): Stream;
      pause(): void;
      resume(): void;
    };
    const stream = (entry as unknown as { internalStream(type: string): Stream }).internalStream("uint8array");
    stream.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 2_000_000) { stream.pause(); reject(new Error("This document section is too large. Upload a smaller selection.")); }
      else chunks.push(chunk);
    }).on("error", reject).on("end", resolve).resume();
  });
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return parse(new TextDecoder().decode(data));
}

export async function extractOfficeText(data: Uint8Array, filename: string): Promise<string> {
  if (!data.length || data.length > 10 * 1024 * 1024) throw new Error("Office files must be nonempty and no larger than 10 MB.");
  const ext = filename.split(".").pop()?.toLowerCase();
  let output = "";
  if (ext === "xlsx" || ext === "xls") {
    const book = XLSX.read(data, { type: "array", cellDates: true });
    if (!book.SheetNames.length || book.SheetNames.length > 100) throw new Error("This workbook has no readable sheets or too many sheets.");
    for (const name of book.SheetNames) {
      const sheet = book.Sheets[name];
      if (!sheet["!ref"]) continue;
      const range = XLSX.utils.decode_range(sheet["!ref"]);
      if ((range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1) > 20000) throw new Error("This worksheet is too large. Upload a smaller cell range.");
      // Never calculate or execute formulas. Preserve formulas lacking cached values explicitly.
      for (const [address, cell] of Object.entries(sheet)) {
        if (!address.startsWith("!") && cell.f && cell.v == null) sheet[address] = { t: "s", v: `Formula (no saved value): =${cell.f}` };
      }
      output = bounded(output + `Worksheet: ${name}\n${XLSX.utils.sheet_to_csv(sheet, { blankrows: false })}\n\n`);
    }
  } else if (ext === "docx" || ext === "pptx") {
    const zip = await JSZip.loadAsync(data);
    if (Object.keys(zip.files).length > 2000) throw new Error("This document is too complex. Upload a smaller copy.");
    if (ext === "docx") {
      output = bounded(text(await readXml(zip, "word/document.xml")));
    } else {
      const presentation = await readXml(zip, "ppt/presentation.xml");
      const relationships = find(await readXml(zip, "ppt/_rels/presentation.xml.rels"), "Relationship");
      const ids = find(presentation, "sldId");
      if (!ids.length || ids.length > 100) throw new Error("This presentation has no slides or too many slides.");
      for (const [index, slide] of ids.entries()) {
        const attrs = slide[":@"] as Record<string, string>;
        const id = Object.entries(attrs ?? {}).find(([key]) => key.endsWith(":id"))?.[1];
        const rel = relationships.find(r => (r[":@"] as Record<string, string>)?.["@_Id"] === id)?.[":@"] as Record<string, string> | undefined;
        if (!rel || rel["@_TargetMode"] === "External") throw new Error("This presentation has an unreadable slide reference.");
        const target = rel["@_Target"];
        const path = target.startsWith("/") ? target.slice(1) : `ppt/${target}`;
        if (!/^ppt\/slides\/[^/]+\.xml$/.test(path)) throw new Error("This presentation has an unsupported slide path.");
        const content = text(await readXml(zip, path)).trim();
        output = bounded(output + `Slide ${index + 1}\n${content || "[No text on this slide; export to PDF to include visuals.]"}\n\n`);
      }
    }
  } else throw new Error("Use XLSX, XLS, DOCX or PPTX files. Save older Word/PowerPoint files in a modern format first.");
  if (!output.trim()) throw new Error("No readable text or cells were found. Export to PDF to include images and diagrams.");
  return output.trim();
}
