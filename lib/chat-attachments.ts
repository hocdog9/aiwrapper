import { selectPdfContext, type PdfReference } from "./pdf-context";
import { recentChatContext } from "./chat-context";
import { validateAttachments, type AttachedImage } from "./file-attachments";

type AttachmentTurn = { role: string; content: string; images?: AttachedImage[]; image?: AttachedImage; referenceDocuments?: PdfReference[] };

/** Carry saved attachments forward independently of the rolling text window. */
export function prepareChatMessages(messages: AttachmentTurn[]) {
  const images: AttachedImage[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const image of message.images ?? (message.image ? [message.image] : [])) {
      const identity = `${image.mimeType}:${image.dataUrl}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      images.push(image);
    }
  }
  try { validateAttachments("", images, []); }
  catch {
    throw new Error("This chat exceeds the limit of 4 PDF pages/images or 3 MB of image content. Start a new chat for additional files. Existing attachments were not dropped.");
  }
  const recent = recentChatContext(messages);
  const documents = messages.filter(m => m.role === "user").flatMap(m => m.referenceDocuments ?? []);
  const latest = recent.at(-1);
  if (latest && documents.length) {
    const query = recent.filter(m => m.role === "user").slice(-2).map(m => m.content).join("\n");
    const excerpts = selectPdfContext(documents, query, Math.min(80000, 100000 - latest.content.length));
    latest.content += excerpts;
  }
  const prepared = recentChatContext(recent);
  return prepared.map((message, index) => ({
    role: message.role,
    content: message.content,
    // Providers receive the saved pages alongside the current question, even
    // when the original upload turn has fallen outside recent text context.
    ...(index === prepared.length - 1 ? { images } : {}),
  }));
}
