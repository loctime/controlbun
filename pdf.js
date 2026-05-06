import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";

const PDFJS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";

let _browser = null;
async function getBrowser() {
  if (!_browser) _browser = await chromium.launch();
  return _browser;
}

// Página persistente con pdfjs ya cargado — se inicializa una vez al arrancar
let _renderPage = null;
let _renderBusy = false;
const _renderQueue = [];

async function getRenderPage() {
  const browser = await getBrowser();
  if (!_renderPage || _renderPage.isClosed()) {
    _renderPage = await browser.newPage();
    await _renderPage.goto("about:blank");
    await _renderPage.addScriptTag({ url: PDFJS_CDN });
    await _renderPage.waitForFunction(() => typeof pdfjsLib !== "undefined", { timeout: 30000 });
    console.log("[PDF] página de renderizado lista");
  }
  return _renderPage;
}

function withRenderPage(fn) {
  return new Promise((resolve, reject) => {
    const task = async () => {
      try {
        const page = await getRenderPage();
        resolve(await fn(page));
      } catch (e) {
        // Si la página crasheó, la descartamos para que se recree en el próximo intento
        _renderPage = null;
        reject(e);
      } finally {
        const next = _renderQueue.shift();
        if (next) next();
        else _renderBusy = false;
      }
    };
    if (_renderBusy) {
      _renderQueue.push(task);
    } else {
      _renderBusy = true;
      task();
    }
  });
}

// Pre-carga la página de renderizado al arrancar el servidor
export async function inicializarPdf() {
  try {
    await getRenderPage();
  } catch (e) {
    console.warn("[PDF] No se pudo pre-cargar la página de renderizado:", e.message);
  }
}

export async function pdfAImagenes(buffer, escala = 90) {
  return withRenderPage(async (page) => {
    const b64pdf = buffer.toString("base64");
    const scale = escala / 72;

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
            base64: canvas.toDataURL("image/jpeg", 0.78).split(",")[1],
          });
        }

        pdf.destroy();
        return result;
      },
      { b64pdf, scale }
    );

    console.log(`[PDF] pdfAImagenes: ${imagenes.length} páginas renderizadas`);
    return imagenes;
  });
}

export async function cortarPaginas(buffer, paginas) {
  const srcDoc = await PDFDocument.load(buffer);
  const totalPags = srcDoc.getPageCount();
  const indices = paginas.map((p) => p - 1);
  console.log(`[PDF] cortarPaginas: total=${totalPags}, pedidas=${paginas.join(",")}, índices=${indices.join(",")}`);
  const invalidos = indices.filter((i) => i < 0 || i >= totalPags);
  if (invalidos.length) console.warn(`[PDF] ⚠️ Índices fuera de rango: ${invalidos.join(",")} (total páginas: ${totalPags})`);
  const nuevoDoc = await PDFDocument.create();
  const copiadas = await nuevoDoc.copyPages(srcDoc, indices);
  copiadas.forEach((p) => nuevoDoc.addPage(p));
  return Buffer.from(await nuevoDoc.save());
}
