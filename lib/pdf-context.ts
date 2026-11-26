export type PdfReference = { name: string; pages: Array<{ page: number; text: string }> };
export const MAX_PDF_PAGES = 500;
export const MAX_PDF_TEXT = 2_000_000;

/** Deterministic local page search; original page text stays in saved chat data. */
export function selectPdfContext(documents: PdfReference[], question: string, budget: number): string {
  if (!documents.length) return "";
  if (budget < 2000) throw new Error("Leave at least 2,000 characters of room in your message for PDF references.");
  const words = [...new Set(question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])]
    .filter(word => !new Set(["the", "and", "what", "this", "that", "from", "with", "does", "please", "pdf", "page", "pages"]).has(word));
  const requested = new Set<number>();
  for (const match of question.matchAll(/\b(?:pages?|pp?\.)\s*(\d+)(?:\s*[-–]\s*(\d+))?/gi)) {
    const start = Number(match[1]), end = Math.min(Number(match[2] ?? match[1]), start + MAX_PDF_PAGES - 1);
    for (let i = start; i <= end; i++) requested.add(i);
  }
  const pages = documents.flatMap((doc, docIndex) => doc.pages.map(page => ({ ...page, name: doc.name, docIndex })));
  if (pages.reduce((sum, page) => sum + page.text.length, 0) > MAX_PDF_TEXT) throw new Error("This chat has too much PDF text. Start another chat for additional textbooks.");
  const scored = pages.map(page => {
    const lower = page.text.toLowerCase();
    const score = words.reduce((sum, word) => sum + (lower.includes(word) ? 1 : 0), 0);
    return { ...page, score: (requested.has(page.page) ? 10000 : 0) + score };
  });
  // Broad requests get representative pages, rather than pretending the first
  // few pages are a complete book summary. Targeted requests use keyword matches.
  const broad = !requested.size && (!words.length || /\b(summarize|summary|overview)\b/i.test(question));
  const ranked = broad
    ? [...scored].sort((a, b) => (a.page % Math.max(1, Math.floor(documents[a.docIndex].pages.length / 12))) - (b.page % Math.max(1, Math.floor(documents[b.docIndex].pages.length / 12))))
    : scored.sort((a, b) => b.score - a.score || a.docIndex - b.docIndex || a.page - b.page);
  let result = "\n\nPDF reference excerpts (selected pages only, NOT the full book). Cite filename and PDF page number. Do not claim to have reviewed unseen pages or visuals. For broad questions, describe these excerpts as a sample and ask for a chapter/page range when needed. PDF page numbers may differ from printed page numbers.\n";
  result += documents.map(doc => `${JSON.stringify(doc.name)}: ${doc.pages.length} pages indexed`).join("; ") + "\n";
  for (const page of ranked.slice(0, 16)) {
    const header = `\n[${JSON.stringify(page.name)}, PDF page ${page.page}]\n`;
    const available = Math.min(10000, budget - result.length - header.length - 40);
    if (available < 100) break;
    result += header + page.text.slice(0, available) + (page.text.length > available ? "\n[Page excerpt shortened]" : "") + "\n";
  }
  return result;
}
