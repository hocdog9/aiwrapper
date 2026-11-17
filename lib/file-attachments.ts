export const FILE_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif,.txt,.md,.csv,.json,.log,.xml,.yaml,.yml,.js,.ts,.py,.html,.css";
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_PROMPT_CHARACTERS = 4000;
export type AttachedDocument = { name: string; text: string };
export type AttachedImage = { dataUrl: string; mimeType: string; name?: string };
const imageTypes: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
};
const textExtensions = new Set(["txt", "md", "csv", "json", "log", "xml", "yaml", "yml", "js", "ts", "py", "html", "css"]);

export function classifyFile(file: { name: string; type: string; size: number }): { kind: "image" | "text"; mimeType: string } {
  if (!file.size) throw new Error(`${file.name} is empty.`);
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const mimeType = imageTypes[extension] ?? (Object.values(imageTypes).includes(file.type) ? file.type : undefined);
  if (mimeType) {
    if (file.size > MAX_IMAGE_BYTES) throw new Error("Images must total no more than 3 MB.");
    return { kind: "image", mimeType };
  }
  if (textExtensions.has(extension)) {
    if (file.size > 64 * 1024) throw new Error(`${file.name} is too large. Use a short text excerpt.`);
    return { kind: "text", mimeType: "text/plain" };
  }
  throw new Error(`${file.name} is not supported. Use an image or a text file (TXT, Markdown, CSV, JSON or source code). PDF and Word files are not supported yet.`);
}

export function attachmentPrompt(input: string, documents: AttachedDocument[]): string {
  return [input.trim(), ...documents.map(file => `Attached file: ${file.name}\n${file.text}`)].filter(Boolean).join("\n\n");
}

export function validateAttachments(input: string, images: AttachedImage[], documents: AttachedDocument[]) {
  if (images.length > 4) throw new Error("Attach no more than 4 images per message.");
  const bytes = images.reduce((sum, image) => {
    const data = image.dataUrl.split(",", 2)[1] ?? "";
    return sum + Math.floor(data.length * 3 / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  }, 0);
  if (bytes > MAX_IMAGE_BYTES) throw new Error("Images must total no more than 3 MB.");
  if (documents.length > 4) throw new Error("Attach no more than 4 text files per message.");
  if (documents.length && attachmentPrompt(input, documents).length > MAX_PROMPT_CHARACTERS) {
    throw new Error("The message and text files exceed 4,000 characters. Shorten the message or attach a smaller excerpt; files will not be truncated.");
  }
}
