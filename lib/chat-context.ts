export const MAX_CONTEXT_MESSAGES = 12;
export const MAX_CONTEXT_CHARACTERS = 24_000;
export const MAX_MESSAGE_CHARACTERS = 4_000;

// Keep the newest contiguous history without changing the stored conversation.
export function recentChatContext<T extends { role: string; content: string }>(messages: T[]): T[] {
  const recent: T[] = [];
  let characters = 0;
  for (let index = messages.length - 1; index >= 0 && recent.length < MAX_CONTEXT_MESSAGES; index--) {
    const message = messages[index];
    const content = message.content.trim().slice(0, MAX_MESSAGE_CHARACTERS);
    if (characters + content.length > MAX_CONTEXT_CHARACTERS) break;
    recent.unshift({ ...message, content });
    characters += content.length;
  }
  // Do not begin with an orphaned assistant answer when its question was omitted.
  while (recent.length > 1 && recent[0].role === "assistant") recent.shift();
  return recent;
}
