import test from "node:test";
import assert from "node:assert/strict";
import { prepareChatMessages } from "../chat-attachments";
import { cleanMessages } from "./consensus-request";
import { requestFingerprint } from "./request-fingerprint";
const page = { dataUrl: "data:image/jpeg;base64,YQ==", mimeType: "image/jpeg", name: "report.pdf — page 1" };

test("PDF pages survive follow-ups, saved-chat reload and the text history window", () => {
  const history = [{ role: "user", content: "Read this PDF", images: [page] },
    ...Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "user" : "assistant", content: `Turn ${i}` })),
    { role: "user", content: "What does page 1 say?" }];
  const saved = JSON.stringify(history);
  const prepared = prepareChatMessages(JSON.parse(saved));
  assert.ok(prepared.length <= 12);
  assert.equal(prepared.some(m => m.content === "Read this PDF"), false);
  assert.deepEqual(prepared.at(-1)?.images, [page]);
  assert.deepEqual(cleanMessages(prepared).messages.at(-1)?.images, [page]);
  assert.equal(JSON.stringify(history), saved);
});
test("deduplicates repeated images and supports older singular image attachments", () => {
  const prepared = prepareChatMessages([
    { role: "user", content: "", image: page },
    { role: "user", content: "Explain", images: [page] },
  ]);
  assert.deepEqual(prepared.at(-1)?.images, [page]);
  assert.equal(prepared[0].images, undefined);
});
test("attachments do not cross chat boundaries and over-limit chats fail explicitly", () => {
  assert.deepEqual(prepareChatMessages([{ role: "user", content: "New chat" }])[0].images, []);
  assert.throws(() => prepareChatMessages(Array.from({ length: 5 }, (_, i) => ({
    role: "user", content: "Page", images: [{ ...page, dataUrl: `data:image/jpeg;base64,Y${i}==` }],
  }))), /Start a new chat/);
});
test("retry identity includes persistent page content", () => {
  const history = [{ role: "user", content: "Read", images: [page] }, { role: "user", content: "Follow up" }];
  const original = requestFingerprint("chat", cleanMessages(prepareChatMessages(history)).messages);
  const reloaded = requestFingerprint("chat", cleanMessages(prepareChatMessages(JSON.parse(JSON.stringify(history)))).messages);
  assert.equal(original, reloaded);
  history[0].images![0] = { ...page, dataUrl: "data:image/jpeg;base64,Yg==" };
  assert.notEqual(original, requestFingerprint("chat", cleanMessages(prepareChatMessages(history)).messages));
});
