import test from "node:test";
import assert from "node:assert/strict";
import { requestFingerprint } from "./request-fingerprint";

test("retry identity binds the conversation, prompt, history, and images", () => {
  const messages = [{ role: "user", content: "Which answer is correct?" }];
  const fingerprint = requestFingerprint("conversation-a", messages);
  assert.equal(fingerprint, requestFingerprint("conversation-a", [{ ...messages[0], images: [] }]));
  assert.notEqual(fingerprint, requestFingerprint("conversation-b", messages));
  assert.notEqual(fingerprint, requestFingerprint("conversation-a", [{ role: "user", content: "A different question" }]));
  assert.notEqual(fingerprint, requestFingerprint("conversation-a", [{ role: "assistant", content: "Earlier context" }, ...messages]));
  assert.notEqual(fingerprint, requestFingerprint("conversation-a", [{ ...messages[0], images: [{ dataUrl: "data:image/png;base64,AAAA", mimeType: "image/png" }] }]));
});
