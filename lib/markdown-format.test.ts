import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { normalizeMarkdown } from "./markdown-format";

// Render with the same plugins as the message UI, rather than only checking the regex.
function render(text: string) {
  return renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: [remarkMath], rehypePlugins: [rehypeKatex], children: normalizeMarkdown(text) }));
}
test("restaurant price tiers preserve separate list entries and bold names", () => {
  const html = render("1. **Pizzeria Libretto** ($$) – Pizza.\n2. **San Remo Bakery** ($) – Pastries.\n3. **Aloette Go** ($$) – Burgers.");
  assert.equal((html.match(/<li>/g) ?? []).length, 3);
  assert.match(html, /<strong>San Remo Bakery<\/strong> \(\$\)/);
  assert.doesNotMatch(html, /katex|math-error/);
});
test("currency amounts remain literal", () => {
  const html = render("Meals cost $15 to $25. Top-ups are CA$4.20.");
  assert.match(html, /\$15 to \$25/);
  assert.doesNotMatch(html, /katex/);
});
test("equations and code retain their existing meaning", () => {
  assert.match(render("$MR = AR = P$"), /katex/);
  assert.match(render("\\(x^2\\)"), /katex/);
  assert.match(render("$$\\frac{1}{2}$$"), /katex/);
  assert.equal(normalizeMarkdown("`($$)`\n```text\n$12\n```"), "`($$)`\n```text\n$12\n```");
});
