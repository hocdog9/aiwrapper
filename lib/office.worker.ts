import { extractOfficeText } from "./office-text";
self.onmessage = async (event: MessageEvent<{ data: Uint8Array; name: string }>) => {
  try {
    self.postMessage({ text: await extractOfficeText(event.data.data, event.data.name) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "Unable to read this Office file. Try an unlocked, newly saved copy." });
  }
};
