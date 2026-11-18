import test from "node:test";
import assert from "node:assert/strict";
import { attachmentPrompt, classifyFile, validateAttachments } from "../file-attachments";

test("supported images and text files are classified even without browser MIME types", () => {
  assert.equal(classifyFile({ name: "photo.JPG", type: "", size: 100 }).mimeType, "image/jpeg");
  assert.equal(classifyFile({ name: "questions.csv", type: "", size: 100 }).kind, "text");
  assert.equal(classifyFile({ name: "paper.pdf", type: "application/pdf", size: 100 }).kind, "pdf");
  assert.equal(classifyFile({ name: "SCAN.PDF", type: "", size: 100 }).kind, "pdf");
  assert.throws(() => classifyFile({ name: "large.pdf", type: "application/pdf", size: 11 * 1024 * 1024 }), /10 MB/);
  assert.equal(classifyFile({ name: "paper.docx", type: "", size: 100 }).kind, "office");
  assert.throws(() => classifyFile({ name: "empty.txt", type: "text/plain", size: 0 }), /empty/);
});
test("text attachment contents become part of the model prompt", () => {
  assert.equal(attachmentPrompt("Summarize", [{ name: "notes.txt", text: "Supply rises." }]),
    "Summarize\n\nAttached file: notes.txt\nSupply rises.");
});
test("limits reject oversized combined input instead of silently truncating files", () => {
  assert.throws(() => validateAttachments("x".repeat(3990), [], [{ name: "a.txt", text: "Some data" }]), /4,000/);
  assert.throws(() => validateAttachments("", [], Array(5).fill({ name: "a.txt", text: "x" })), /4 documents/);
  const image = { dataUrl: "data:image/png;base64,YQ==", mimeType: "image/png" };
  assert.throws(() => validateAttachments("", Array(5).fill(image), []), /4 images/);
  assert.doesNotThrow(() => validateAttachments("", [image], []));
  assert.throws(() => classifyFile({ name: "large.png", type: "image/png", size: 4 * 1024 * 1024 }), /3 MB/);
});
