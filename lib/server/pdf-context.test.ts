import test from "node:test";
import assert from "node:assert/strict";
import { selectPdfContext, type PdfReference } from "../pdf-context";
import { prepareChatMessages } from "../chat-attachments";

const book: PdfReference = { name: "Economics.pdf", pages: Array.from({ length: 500 }, (_, i) => ({
  page: i + 1, text: i === 499 ? "Distinctive explanation of oligopoly equilibrium." : `Background material for chapter ${i + 1}.`,
})) };
test("500-page books retrieve matching content and explicit page ranges", () => {
  assert.match(selectPdfContext([book], "Explain oligopoly equilibrium", 80000), /PDF page 500/);
  const explicit = selectPdfContext([book], "Explain pages 495–500", 80000);
  for (let page = 495; page <= 500; page++) assert.ok(explicit.includes(`PDF page ${page}`));
});
test("reference excerpts are bounded and clearly identified as partial", () => {
  const result = selectPdfContext([book], "Summarize this textbook", 2000);
  assert.ok(result.length <= 2000);
  assert.match(result, /NOT the full book/);
  assert.throws(() => selectPdfContext([book], "Question", 100), /room/);
});
test("saved textbook references survive the rolling text window without sending all pages", () => {
  const history = [{ role: "user", content: "Use this textbook", referenceDocuments: [book] },
    ...Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "user" : "assistant", content: `Turn ${i}` })),
    { role: "user", content: "Explain page 500" }];
  const snapshot = JSON.stringify(history);
  const result = prepareChatMessages(JSON.parse(snapshot));
  assert.ok(result.length <= 12);
  assert.match(result.at(-1)!.content, /Distinctive explanation/);
  assert.equal(JSON.stringify(history), snapshot);
  assert.equal(result.some(m => "referenceDocuments" in m), false);
  assert.equal(prepareChatMessages([{ role: "user", content: "Another chat" }])[0].content, "Another chat");
});
