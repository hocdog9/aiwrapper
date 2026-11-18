import test from "node:test";
import assert from "node:assert/strict";
import { messageDisplay } from "../message-display";

test("uploaded content remains in model context while display shows filename and user text", () => {
  const message = { role: "user", content: "Analyze\n\nAttached file: sheet.xlsx\nprivate rows", displayContent: "Analyze", attachedFileNames: ["sheet.xlsx"] };
  assert.deepEqual(messageDisplay(message), { text: "Analyze", files: ["sheet.xlsx"] });
  assert.ok(message.content.includes("private rows"));
});
test("file-only sends and legacy saved uploads are compact", () => {
  assert.deepEqual(messageDisplay({ role: "user", content: "Attached file: a.xlsx\nrows\n\nAttached file: b.docx\ntext" }), { text: "", files: ["a.xlsx", "b.docx"] });
  assert.deepEqual(messageDisplay({ role: "user", content: "Summary please\n\nAttached file: a.txt\ntext" }), { text: "Summary please", files: ["a.txt"] });
});
test("ordinary messages and assistant responses stay intact", () => {
  assert.deepEqual(messageDisplay({ role: "user", content: "Hello" }), { text: "Hello", files: [] });
  const content = "Attached file: example.txt\nThis is an example";
  assert.equal(messageDisplay({ role: "assistant", content }).text, content);
});
