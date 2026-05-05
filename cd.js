import { chromium } from "playwright";

const CD_URL = "https://controldocumentario.com";
const BANDEJA_URL = `${CD_URL}/Bandeja.aspx?menu=1`;

let _browser = null;
async function getBrowser() {
  if (!_browser) _browser = await chromium.launch({ headless: false, slowMo: 400 });
  return _browser;
}

export async function cdCrearSesion() {
  const browser = await getBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  return { page, context };
}

export async function cdCerrarSesion(context) {
  try { await context.close(); } catch {}
}

// ── Caché de sesiones activas por usuario ────────────────────────────────────
const _sesionesActivas = new Map(); // chatId → { context, page, ts }
const SESION_TTL = 25 * 60 * 1000; // 25 minutos

async function _sesionEsValida(sesion) {
  if (Date.now() - sesion.ts > SESION_TTL) return false;
  try {
    await sesion.page.evaluate(() => true);
    return !sesion.page.url().toLowerCase().includes("login");
  } catch {
    return false;
  }
}

// Devuelve { ok: true, page, context } si hay sesión activa o puede loguear.
// Devuelve { ok: false, motivo, screenshot? } si el login falla.
export async function cdObtenerSesionActiva(chatId, cdUser, cdPass) {
  const cached = _sesionesActivas.get(chatId);
  if (cached && await _sesionEsValida(cached)) {
    cached.ts = Date.now();
    console.log("[CD] Sesión reutilizada para", chatId);
    return { ok: true, page: cached.page, context: cached.context };
  }
  if (cached) {
    await cdCerrarSesion(cached.context).catch(() => {});
    _sesionesActivas.delete(chatId);
  }
  const sesion = await cdCrearSesion();
  const login = await cdLogin(sesion.page, cdUser, cdPass);
  if (!login.ok) {
    await cdCerrarSesion(sesion.context).catch(() => {});
    return { ok: false, motivo: login.motivo, screenshot: login.screenshot };
  }
  _sesionesActivas.set(chatId, { context: sesion.context, page: sesion.page, ts: Date.now() });
  return { ok: true, page: sesion.page, context: sesion.context };
}

// Invalida la sesión cacheada (usar al cambiar credenciales o en errores graves)
export function cdInvalidarSesion(chatId) {
  const cached = _sesionesActivas.get(chatId);
  if (cached) {
    cdCerrarSesion(cached.context).catch(() => {});
    _sesionesActivas.delete(chatId);
  }
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

    // Detecta el índice de la columna "Recurso" en la tabla (portado de panel.js)
    function detectarIndiceColumnaRecurso() {
      const ths = Array.from(document.querySelectorAll("th"));
      for (let i = 0; i < ths.length; i++) {
        if (/recurso/i.test(textoPlano(ths[i].textContent))) return i;
      }
      for (const tr of document.querySelectorAll("tr")) {
        const celdas = tr.querySelectorAll("td, th");
        const textoFila = textoPlano(tr.textContent);
        if (/recurso/i.test(textoFila) && /requerimiento/i.test(textoFila)) {
          for (let i = 0; i < celdas.length; i++) {
            if (/recurso/i.test(textoPlano(celdas[i].textContent))) return i;
          }
        }
      }
      return -1;
    }

    // Extrae nombre de empleado o patente de la celda Recurso (portado de panel.js)
    function parsearRecurso(td) {
      if (!td) return "";
      // Patente de vehículo
      const txt = textoPlano(td.textContent);
      const patente = txt.match(/\b[A-Z]{2,3}\d{3,4}[A-Z]?\b/);
      if (patente) return patente[0];
      // Nombre de empleado: primero buscar en el <a> del recurso
      const linkRecurso = td.querySelector("a");
      if (linkRecurso) return textoPlano(linkRecurso.textContent);
      // Fallback: primera línea de innerText (antes de "Argentina", "Empleador", etc.)
      const lineas = (td.innerText || "").split(/\n/).map((l) => l.trim()).filter(Boolean);
      if (lineas.length > 0) {
        const primeraLinea = lineas[0];
        if (
          /^([A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}\s+){1,}[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}$/.test(primeraLinea) &&
          !/argentina|empleador|contrato|seguridad|higiene/i.test(primeraLinea)
        ) return primeraLinea;
      }
      return "";
    }

    const idxRecurso = detectarIndiceColumnaRecurso();

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

      const celdas = Array.from(tr.querySelectorAll(":scope > td"));
      const tdRecurso = idxRecurso >= 0 ? celdas[idxRecurso] : null;
      const entidad = parsearRecurso(tdRecurso || celdas.find((td) => !td.contains(link)));

      // Intentar obtener la URL por múltiples vías (CD usa JS en vez de href estándar)
      let href = "";
      const esUrlValida = (u) => u && !u.startsWith("javascript:") && u !== window.location.href && !u.endsWith("#");
      if (esUrlValida(link.href)) href = link.href;
      if (!href) {
        for (const el of [link, tr]) {
          const oc = el.getAttribute("onclick") || "";
          const m = oc.match(/location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i) ||
                    oc.match(/['"](\/?[A-Za-z][^\s'"]*\.aspx[^'"]*)['"]/i);
          if (m) { try { href = new URL(m[1], window.location.href).href; } catch {} }
          if (href) break;
        }
      }

      const clave = `${nombre}||${entidad}||${href}`;
      if (vistos.has(clave)) continue;
      vistos.add(clave);

      resultado.push({ nombre, entidad, href });
    }

    return resultado;
  });
}

// Lee todos los TIPOS únicos de requerimientos de la cuenta (para /aprender).
// Sin filtro de estado: escanea todas las filas visibles + widget Sobres activos.
export async function cdLeerTiposRequerimientos(page) {
  await page.goto(BANDEJA_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  // Expandir tabla a todos los registros
  await page.evaluate(() => {
    const sel = document.querySelector("select[name='tblRequerimientos_length']");
    if (sel && sel.value !== "-1") {
      sel.value = "-1";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });

  // Hacer click en Buscar si existe (igual que cdLeerRequerimientos)
  const btnBuscar = page.locator('button, input[type="button"]').filter({ hasText: /buscar/i }).first();
  if (await btnBuscar.isVisible().catch(() => false)) await btnBuscar.click();
  await page.waitForTimeout(2000);

  const leerDropdown = () => page.evaluate(() => {
    function textoPlano(s) {
      return (s || "").replace(/\s+/g, " ").trim();
    }
    // El dropdown de filtro de la bandeja tiene "Sobres activos" como primera opción,
    // seguido de todos los tipos de requerimientos de la cuenta.
    for (const sel of document.querySelectorAll("select")) {
      const opciones = Array.from(sel.options).map((o) => textoPlano(o.textContent)).filter(Boolean);
      if (opciones.some((t) => /sobres\s*activos/i.test(t))) {
        return opciones.filter((t) => t && !/sobres\s*activos/i.test(t)).sort();
      }
    }
    return [];
  });

  let tipos = await leerDropdown();
  // Si la página todavía no terminó de cargar el dropdown, esperar y reintentar
  if (!tipos.length) {
    await page.waitForTimeout(3000);
    tipos = await leerDropdown();
  }
  return tipos;
}

// Navega al requerimiento haciendo click en la fila de la bandeja (fallback cuando no hay href).
async function _navegarAReq(page, reqNombre, reqEntidad) {
  await page.goto(BANDEJA_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const sel = document.querySelector("select[name='tblRequerimientos_length']");
    if (sel && sel.value !== "-1") {
      sel.value = "-1";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  const btnBuscar = page.locator('button, input[type="button"]').filter({ hasText: /buscar/i }).first();
  if (await btnBuscar.isVisible().catch(() => false)) await btnBuscar.click();
  await page.waitForTimeout(2000);

  const link = reqEntidad
    ? page.locator("tr").filter({ hasText: reqEntidad }).locator("a").filter({ hasText: reqNombre }).first()
    : page.locator("a").filter({ hasText: reqNombre }).first();
  await link.click();
  // Modal AJAX sobre la bandeja — esperar que cargue (puede estar en un iframe interno).
  await page.waitForTimeout(3000);
}

// Sube un archivo PDF a un requerimiento específico.
// reqNombre y reqEntidad se usan como fallback si href está vacío (CD usa JS navigation).
export async function cdSubirArchivo(page, href, bufferPdf, nombreArchivo, reqNombre = "", reqEntidad = "") {
  // Navegar al requerimiento
  if (href && !href.startsWith("javascript:")) {
    await page.goto(href, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);
  } else {
    console.log(`[CD] href vacío para "${reqNombre}" — navegando por click`);
    await _navegarAReq(page, reqNombre, reqEntidad);
  }

  // Captura de diagnóstico — se adjunta al error si algo falla
  const capturar = () => page.screenshot({ type: "jpeg", quality: 70 }).catch(() => null);

  // Busca un locator en todos los frames (incluyendo iframes anidados).
  // Usa count() para chequeo inmediato sin bloquear 30s como elementHandle().
  const enFrames = async (fn) => {
    for (const frame of page.frames()) {
      try {
        const r = await fn(frame);
        if (r) return r;
      } catch {}
    }
    return null;
  };

  // Sondea cada 500ms hasta encontrar algo o agotar los intentos.
  const poll = async (fn, intentos = 20) => {
    for (let i = 0; i < intentos; i++) {
      await page.waitForTimeout(500);
      const r = await fn();
      if (r) return r;
    }
    return null;
  };

  // 1. Buscar y clickar tab "Adjuntar archivo" (está dentro del fancybox-iframe de CD)
  const btnAdjuntar = await poll(() =>
    enFrames(async (frame) => {
      const el = frame.locator("a, button, li, span, td").filter({ hasText: /adjuntar\s+archivo/i }).first();
      return (await el.count()) > 0 ? el : null;
    })
  );

  if (!btnAdjuntar) {
    const err = new Error(`No encontré "Adjuntar archivo" (${page.frames().length} frames). URL: ${page.url()}`);
    err.screenshot = await capturar();
    throw err;
  }
  await btnAdjuntar.click();

  // 2. Tras el click aparece una segunda iframe anidada con el form de subida.
  //    Sondear hasta encontrar el input[type="file"] en cualquier frame.
  const fileLocator = await poll(() =>
    enFrames(async (frame) => {
      const loc = frame.locator('input[type="file"]').first();
      return (await loc.count()) > 0 ? loc : null;
    })
  );

  if (!fileLocator) {
    const err = new Error(`No encontré input[type="file"] (${page.frames().length} frames). URL: ${page.url()}`);
    err.screenshot = await capturar();
    throw err;
  }

  // 3. Subir el archivo
  const { writeFile, unlink } = await import("fs/promises");
  const { join } = await import("path");
  const { tmpdir } = await import("os");
  const tmpPath = join(tmpdir(), nombreArchivo);
  await writeFile(tmpPath, bufferPdf);

  try {
    await fileLocator.setInputFiles(tmpPath);
    await page.waitForTimeout(2000);

    // 4. Confirmar/enviar en cualquier frame
    const btnEnviar = await enFrames(async (frame) => {
      const btn = frame.locator('button, input[type="submit"]').filter({
        hasText: /enviar|confirmar|aceptar|guardar/i,
      }).first();
      return (await btn.isVisible().catch(() => false)) ? btn : null;
    });
    if (btnEnviar) await btnEnviar.click();

    await page.waitForTimeout(3000);
    return { ok: true };
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}
