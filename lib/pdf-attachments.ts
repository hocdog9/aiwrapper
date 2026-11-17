import { type AttachedImage } from "./file-attachments";

/** Render locally so text, scans and diagrams use the same provider image path. */
export async function renderPdf(file: File, availablePages: number, isCancelled: () => boolean): Promise<AttachedImage[]> {
  if (availablePages < 1) throw new Error("Remove an image before adding a PDF. Up to 4 PDF pages/images can be sent together.");
  const pdfjs = await import("pdfjs-dist");
  const assetRoot = `/pdfjs/${pdfjs.version}/`;
  pdfjs.GlobalWorkerOptions.workerSrc = `${assetRoot}pdf.worker.min.mjs`;
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: `${assetRoot}cmaps/`, cMapPacked: true,
    standardFontDataUrl: `${assetRoot}standard_fonts/`,
    wasmUrl: `${assetRoot}wasm/`,
    isEvalSupported: false,
  });
  let timedOut = false;
  const timeout = window.setTimeout(() => { timedOut = true; void task.destroy(); }, 45000);
  try {
    const pdf = await task.promise;
    if (pdf.numPages > availablePages) {
      throw new Error(`${file.name} has ${pdf.numPages} pages. You can attach ${availablePages} more PDF pages/images. Split the PDF into a smaller document; no pages were attached.`);
    }
    const images: AttachedImage[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      if (isCancelled()) throw new Error("PDF attachment cancelled.");
      const page = await pdf.getPage(number);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2, 1600 / Math.max(base.width, base.height)) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      try {
        await page.render({ canvas, viewport, background: "white" }).promise;
        images.push({ dataUrl: canvas.toDataURL("image/jpeg", 0.85), mimeType: "image/jpeg", name: `${file.name} — page ${number}` });
      } finally {
        canvas.width = canvas.height = 0;
        page.cleanup();
      }
    }
    return images;
  } catch (error) {
    if (timedOut) throw new Error("This PDF took too long to read. Try a smaller PDF.");
    if (error instanceof Error && error.name === "PasswordException") throw new Error("This PDF is password-protected. Upload an unlocked copy.");
    if (error instanceof Error && error.name === "InvalidPDFException") throw new Error("This PDF could not be read. It may be damaged; try exporting it again.");
    throw error;
  } finally {
    window.clearTimeout(timeout);
    await task.destroy();
  }
}
