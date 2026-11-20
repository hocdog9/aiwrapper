import test from "node:test";
import assert from "node:assert/strict";
import { prepareProjectMessages, type ProjectFile } from "../project-context";

const files: ProjectFile[] = [{ id: "file1", name: "notes.txt", images: [], documents: [{ name: "notes.txt", text: "Project-specific reference" }] }];
test("separate chats can use the same project file without sharing messages", () => {
  const a = prepareProjectMessages([{ role: "user", content: "Private question A" }], files);
  const b = prepareProjectMessages([{ role: "user", content: "Different question B" }], JSON.parse(JSON.stringify(files)));
  assert.match(a[0].content, /Project-specific reference/);
  assert.match(b[0].content, /Project-specific reference/);
  assert.ok(!b[0].content.includes("Private question A"));
});
test("personal chats and other projects cannot inherit project files", () => {
  const input = [{ role: "user", content: "Question" }];
  assert.equal(prepareProjectMessages(input)[0].content, "Question");
  prepareProjectMessages(input, files);
  assert.equal(input[0].content, "Question");
  assert.equal(prepareProjectMessages(input, [])[0].content, "Question");
});
test("shared PDF references and images reach new project chats", () => {
  const image = { dataUrl: "data:image/png;base64,YQ==", mimeType: "image/png" };
  const shared: ProjectFile[] = [{ id: "pdf", name: "book.pdf", images: [image], documents: [{ name: "book.pdf", text: "", pages: [{ page: 1, text: "Shared textbook content" }] }] }];
  const result = prepareProjectMessages([{ role: "user", content: "Explain page 1" }], shared);
  assert.match(result[0].content, /Shared textbook content/);
  assert.deepEqual(result[0].images, [image]);
});
test("shared and private file context cannot silently exceed message limits", () => {
  assert.throws(() => prepareProjectMessages([{ role: "user", content: "x".repeat(100000) }], files), /100,000/);
});
