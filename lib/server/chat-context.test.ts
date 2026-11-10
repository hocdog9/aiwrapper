import test from "node:test";
import assert from "node:assert/strict";
import { recentChatContext } from "../chat-context";
import { cleanMessages } from "./consensus-request";

test("long conversations retain the latest question without altering history", () => {
  const history = Array.from({ length: 31 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `Message ${i}` }));
  const before = JSON.stringify(history);
  const context = recentChatContext(history);
  assert.ok(context.length <= 12);
  assert.equal(context[0].role, "user");
  assert.equal(context.at(-1)?.content, "Message 30");
  assert.equal(JSON.stringify(history), before);
  const cleaned = cleanMessages(history);
  assert.equal(cleaned.error, undefined);
  assert.equal(cleaned.messages.at(-1)?.content, "Message 30");
});

test("context respects character limits and preserves the newest messages", () => {
  const history = Array.from({ length: 13 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: String(i).padEnd(4000, "x") }));
  const result = cleanMessages(history);
  assert.equal(result.error, undefined);
  assert.ok(result.messages.reduce((sum, m) => sum + m.content.length, 0) <= 24000);
  assert.equal(result.messages.at(-1)?.content, history.at(-1)?.content);
});
