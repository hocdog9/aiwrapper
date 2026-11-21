/** Protect price notation before the math plugin sees it. Leave code and equations intact. */
export function normalizeMarkdown(text: string): string {
  // Do not rewrite literal code (including examples of dollar/math syntax).
  return text.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`+[^`\n]*`+)/g).map((part, index) => {
    if (index % 2) return part;
    return part
      // Restaurant price tiers: ($), ($$), etc. are labels, not math delimiters.
      .replace(/\(\s*(\${1,4})\s*\)/g, (_match, dollars: string) => `(${dollars.replace(/\$/g, "\\$")})`)
      // Currency amounts, but preserve deliberately delimited math such as $5$ or $2x$.
      .replace(/(?<![\\$])\$(\d[\d,]*(?:\.\d+)?)(?=$|[\s,;:!?)]|\.(?:\s|$))/g, "\\$$$1")
      .replace(/\\\[([\s\S]*?)\\\]/g, (_match, math: string) => `$$${math}$$`)
      .replace(/\\\(([\s\S]*?)\\\)/g, (_match, math: string) => `$${math}$`);
  }).join("");
}
