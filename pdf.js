import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";

let _browser = null;
async function getBrowser() {
  if (!_browser) _browser = await chromium.launch();
  return _browser;
}

export async function pdfAImagenes(buffer, escala = 120) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    const b64pdf = buffer.toString("base64");
    const scale = escala / 72;

    await page.goto("about:blank");
    await page.addScriptTag({
      url: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
    });

    const imagenes = await page.evaluate(
      async ({ b64pdf, scale }) => {
        pdfjsLib.GlobalWorkerOptions.workerSrc =
          "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

        const bytes = Uint8Array.from(atob(b64pdf), (c) => c.charCodeAt(0));
        const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
        const result = [];

        for (let i = 1; i <= pdf.numPages; i++) {
          const pdfPage = await pdf.getPage(i);
          const viewport = pdfPage.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await pdfPage.render({ canvasContext: ctx, viewport }).promise;
          result.push({
            pagina: i,
            base64: canvas.toDataURL("image/jpeg", 0.75).split(",")[1],
          });
        }

        pdf.destroy();
        return result;
      },
      { b64pdf, scale }
    );

    console.log(`[PDF] ${imagenes.length} páginas renderizadas`);
    return imagenes;
  } finally {
    await page.close();
  }
}

export async function cortarPaginas(buffer, paginas) {
  const srcDoc = await PDFDocument.load(buffer);
  const nuevoDoc = await PDFDocument.create();
  const copiadas = await nuevoDoc.copyPages(srcDoc, paginas.map((p) => p - 1));
  copiadas.forEach((p) => nuevoDoc.addPage(p));
  return Buffer.from(await nuevoDoc.save());
}
