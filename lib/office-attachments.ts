export async function readOfficeFile(file: File): Promise<string> {
  const data = await file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./office.worker.ts", import.meta.url), { type: "module" });
    const finish = () => { clearTimeout(timer); worker.terminate(); };
    const timer = setTimeout(() => { finish(); reject(new Error("This Office file took too long to read. Try a smaller file.")); }, 20000);
    worker.onmessage = (event: MessageEvent<{ text?: string; error?: string }>) => {
      finish();
      if (event.data.error || !event.data.text) reject(new Error(event.data.error || "No readable content found."));
      else resolve(event.data.text);
    };
    worker.onerror = () => { finish(); reject(new Error("Could not read this Office file. Try an unlocked, newly saved copy.")); };
    worker.postMessage({ data: new Uint8Array(data), name: file.name }, [data]);
  });
}
