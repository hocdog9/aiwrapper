type MessageDisplayInput = {
  role: string;
  content: string;
  displayContent?: string;
  attachedFileNames?: string[];
};

export function messageDisplay(message: MessageDisplayInput): { text: string; files: string[] } {
  if (message.role !== "user") return { text: message.content, files: [] };
  if (message.displayContent !== undefined) {
    return { text: message.displayContent, files: message.attachedFileNames ?? [] };
  }
  // Earlier chats embedded file text directly in content. Keep that content for
  // model context and retries, but collapse its display just like new uploads.
  const pattern = /(?:^|\n\n)Attached file: ([^\n]+)\n/g;
  const matches = [...message.content.matchAll(pattern)];
  if (!matches.length) return { text: message.content, files: [] };
  return { text: message.content.slice(0, matches[0].index).trim(), files: matches.map(match => match[1]) };
}
