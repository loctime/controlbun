import { chromium } from "playwright";

const CD_URL = "https://controldocumentario.com";
const BANDEJA_URL = `${CD_URL}/Bandeja.aspx?menu=1`;

let _browser = null;
async function getBrowser() {
  if (!_browser) _browser = await chromium.launch({ headless: true });
  return _browser;
}

// Crea un contexto de browser nuevo para un cliente (sesión aislada)
export async function cdCrearSesion() {
  const browser = await getBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  return { page, context };
}

export async function cdCerrarSesion(context) {
  try { await context.close(); } catch {}
}

// Login en controldocumentario.com
export async function cdLogin(page, user, pass) {
  await page.goto(`${CD_URL}/Login.aspx`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  console.log("[CD LOGIN] URL actual:", page.url());

  // Primer input de texto visible = usuario
  const inputUser = page.locator('input:not([type="password"]):not([type="hidden"]):visible').first();
  await inputUser.fill(user);
  console.log("[CD LOGIN] Usuario cargado");

  await page.locator('input[type="password"]:visible').first().fill(pass);
  console.log("[CD LOGIN] Contraseña cargada");

  // Botón INGRESAR (excluir Microsoft / Soy nuevo / etc.)
  const btn = page.locator('button, input[type="submit"], input[type="button"]').filter({
    hasText: /ingresar/i,
  }).first();
  const btnVisible = await btn.isVisible().catch(() => false);
  console.log("[CD LOGIN] Botón INGRESAR visible:", btnVisible);

  // Registrar el wait ANTES del click para evitar race condition
  const espera = page.waitForURL((url) => !url.href.toLowerCase().includes("login"), { timeout: 60000 });
  await btn.click();
  console.log("[CD LOGIN] Click enviado, esperando redirección...");

  try {
    await espera;
    console.log("[CD LOGIN] Login OK, URL:", page.url());
    return { ok: true };
  } catch {
    const urlActual = page.url();
    // Si la URL ya cambió aunque el wait haya fallado, el login fue exitoso
    if (!urlActual.toLowerCase().includes("login")) {
      console.log("[CD LOGIN] Login OK (detectado post-catch), URL:", urlActual);
      return { ok: true };
    }
    const texto = await page.locator("body").innerText().catch(() => "");
    console.log("[CD LOGIN] Fallo real. URL:", urlActual);
    console.log("[CD LOGIN] Texto body (primeros 300):", texto.slice(0, 300));
    const screenshot = await page.screenshot({ type: "jpeg", quality: 70 }).catch(() => null);
    if (/incorrect|inv[aá]lid|err[oó]r|usuario o contrase/i.test(texto)) {
      return { ok: false, motivo: "Usuario o contraseña incorrectos.", screenshot };
    }
    return { ok: false, motivo: "Timeout esperando respuesta del login.", screenshot };
  }
}

// Lee todos los requerimientos pendientes de la bandeja.
// Devuelve [{ nombre, entidad, href }]
export async function cdLeerRequerimientos(page) {
  await page.goto(BANDEJA_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  // Expandir tabla a todos los registros si hay un select de paginación
  await page.evaluate(() => {
    const sel = document.querySelector("select[name='tblRequerimientos_length']");
    if (sel && sel.value !== "-1") {
      sel.value = "-1";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });

  // Hacer click en Buscar si existe
  const btnBuscar = page.locator('button, input[type="button"]').filter({ hasText: /buscar/i }).first();
  if (await btnBuscar.isVisible().catch(() => false)) await btnBuscar.click();
  await page.waitForTimeout(2000);

  return await page.evaluate(() => {
    function textoPlano(s) {
      return (s || "").replace(/\s+/g, " ").trim();
    }

    function parsearEntidad(tr) {
      const celdas = Array.from(tr.querySelectorAll(":scope > td"));
      for (const td of celdas) {
        const txt = textoPlano(td.textContent);
        if (td.querySelector("a")) continue; // celda del link del requerimiento
        // Saltar nombres de empresa (contienen tipo societario)
        if (/unipersonal|s\.a\b|s\.r\.l|s\.a\.s|ltda|\bsrl\b|sociedad/i.test(txt)) continue;
        // Buscar patente primero (más específico): AB123 / ABC1234 / AB123C
        const patente = txt.match(/\b[A-Z]{2,3}\d{3,4}[A-Z]?\b/);
        if (patente) return patente[0];
        // Nombre de persona: 2-5 palabras, cada una empieza con mayúscula, sin números
        if (/^([A-ZÁÉÍÓÚÑ][a-zA-ZÁÉÍÓÚÑáéíóúñ]*\s+){1,4}[A-ZÁÉÍÓÚÑ][a-zA-ZÁÉÍÓÚÑáéíóúñ]*\s*$/.test(txt) && !/\d/.test(txt)) return txt;
      }
      return "";
    }

    // Leer sobres activos del widget (lista de nombres de requerimientos)
    function leerSobresActivos() {
      for (const sel of document.querySelectorAll("select")) {
        let parent = sel.parentElement;
        for (let i = 0; i < 4 && parent; i++, parent = parent.parentElement) {
          if (/sobres\s*activos/i.test(parent.textContent?.slice(0, 80) || "")) {
            return Array.from(sel.options).map((o) => textoPlano(o.textContent)).filter(Boolean);
          }
        }
      }
      // Fallback: lista de texto cercana a "Sobres activos"
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (!/sobres\s*activos/i.test(node.textContent)) continue;
        let container = node.parentElement;
        for (let i = 0; i < 6 && container; i++, container = container.parentElement) {
          const items = container.querySelectorAll("li, option");
          if (items.length >= 2) {
            return Array.from(items).map((el) => textoPlano(el.textContent)).filter(Boolean);
          }
        }
      }
      return [];
    }

    // Escanear filas de la tabla principal
    const filas = Array.from(document.querySelectorAll("tr")).filter((tr) => {
      const tds = tr.querySelectorAll(":scope > td");
      return tds.length >= 4 && !tr.querySelector("table");
    });

    const resultado = [];
    const vistos = new Set();

    const sobres = leerSobresActivos();
    const usarSobres = sobres.length > 0;

    for (const tr of filas) {
      const link = tr.querySelector("a");
      if (!link) continue;
      const nombre = textoPlano(link.textContent);
      if (!nombre) continue;

      // Si tenemos sobres activos, filtrar solo los que coinciden
      if (usarSobres) {
        const coincide = sobres.some(
          (s) => nombre === s || nombre.toLowerCase().startsWith(s.toLowerCase())
        );
        if (!coincide) continue;
      } else {
        // Fallback: solo pendientes de envío
        const txtFila = textoPlano(tr.textContent);
        if (!/pend envio|pend envío/i.test(txtFila)) continue;
      }

      const entidad = parsearEntidad(tr);
      const href = link.href || "";
      const clave = `${nombre}||${entidad}||${href}`;
      if (vistos.has(clave)) continue;
      vistos.add(clave);

      resultado.push({ nombre, entidad, href });
    }

    return resultado;
  });
}

// Sube un archivo PDF a un requerimiento específico (por href del link).
export async function cdSubirArchivo(page, href, bufferPdf, nombreArchivo) {
  // Navegar al requerimiento
  await page.goto(href, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);

  // Esperar y hacer click en "Adjuntar archivo"
  const btnAdjuntar = page.locator('a, button').filter({ hasText: /adjuntar/i }).first();
  await btnAdjuntar.waitFor({ timeout: 15000 });
  await btnAdjuntar.click();
  await page.waitForTimeout(1500);

  // El input de archivo puede estar en un iframe
  let fileInput = null;
  const frames = page.frames();
  for (const frame of frames) {
    fileInput = await frame.locator('input[type="file"]').first().elementHandle().catch(() => null);
    if (fileInput) break;
  }
  if (!fileInput) {
    fileInput = await page.locator('input[type="file"]').first().elementHandle();
  }

  // Subir el archivo desde buffer en memoria
  const { writeFile, unlink } = await import("fs/promises");
  const { join } = await import("path");
  const { tmpdir } = await import("os");
  const tmpPath = join(tmpdir(), nombreArchivo);
  await writeFile(tmpPath, bufferPdf);

  try {
    await fileInput.setInputFiles(tmpPath);
    await page.waitForTimeout(2000);

    // Confirmar/enviar — buscar botón de confirmar en todos los frames
    for (const frame of [page, ...page.frames()]) {
      const btnEnviar = frame.locator('button, input[type="submit"]').filter({
        hasText: /enviar|confirmar|aceptar|guardar/i,
      }).first();
      if (await btnEnviar.isVisible().catch(() => false)) {
        await btnEnviar.click();
        break;
      }
    }

    await page.waitForTimeout(3000);
    return { ok: true };
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}
