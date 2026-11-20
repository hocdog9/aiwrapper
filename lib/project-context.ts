import { prepareChatMessages } from "./chat-attachments";
import { attachmentPrompt, validateAttachments, type AttachedDocument, type AttachedImage } from "./file-attachments";
import type { PdfReference } from "./pdf-context";

export type ProjectFile = { id: string; name: string; images: AttachedImage[]; documents: AttachedDocument[] };
export type Project = { id: string; name: string; files: ProjectFile[] };
type Turn = { role: string; content: string; images?: AttachedImage[]; image?: AttachedImage; referenceDocuments?: PdfReference[] };

export function prepareProjectMessages(messages: Turn[], files: ProjectFile[] = []) {
  if (!files.length) return prepareChatMessages(messages);
  const latest = messages.at(-1);
  if (!latest || latest.role !== "user") throw new Error("Add a question before using project files.");
  const documents = files.flatMap(file => file.documents);
  const images = files.flatMap(file => file.images);
  validateAttachments(latest.content, images, documents);
  const content = attachmentPrompt(latest.content, documents);
  return prepareChatMessages([...messages.slice(0, -1), {
    ...latest, content,
    images: [...(latest.images ?? (latest.image ? [latest.image] : [])), ...images],
    referenceDocuments: [...(latest.referenceDocuments ?? []), ...documents.filter(d => d.pages).map(d => ({ name: d.name, pages: d.pages! }))],
  }]);
}
