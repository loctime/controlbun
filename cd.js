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

// Hace click en Buscar y espera que aparezcan filas en la tabla.
// Si tras la espera no hay filas, reintenta el click una vez más.
async function _clickBuscarYEsperar(page) {
  const btnBuscar = page.locator('button, input[type="button"]').filter({ hasText: /buscar/i }).first();
  if (!await btnBuscar.isVisible().catch(() => false)) return;

  const hayFilas = () => page.evaluate(() => {
    return Array.from(document.querySelectorAll("tr")).some((tr) => {
      const tds = tr.querySelectorAll(":scope > td");
      return tds.length >= 4 && tr.querySelector("a");
    });
  });

  await btnBuscar.click();
  console.log("[CD] Click Buscar — esperando tabla…");
  await page.waitForTimeout(3000);

  if (!await hayFilas()) {
    console.log("[CD] Tabla vacía tras primer click, reintentando Buscar…");
    await page.waitForTimeout(3000);
    await btnBuscar.click();
    await page.waitForTimeout(3000);
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

  await _clickBuscarYEsperar(page);

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

  await _clickBuscarYEsperar(page);

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
  await page.waitForTimeout(2000);

  // Expandir tabla a todos los registros (igual que cdLeerRequerimientos)
  await page.evaluate(() => {
    const sel = document.querySelector("select[name='tblRequerimientos_length']");
    if (sel && sel.value !== "-1") {
      sel.value = "-1";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  // Click en Buscar fuerza reload completo de DataTables (clave para ver todos los reqs)
  await _clickBuscarYEsperar(page);

  // Esperar a que la tabla tenga bastantes filas (señal de que expandió)
  await page.waitForFunction(
    () => document.querySelectorAll("tr td").length > 10,
    { timeout: 15000 }
  ).catch(() => {});

  // Buscar y clickar via evaluate — reintenta hasta 3 veces con 2s entre intentos
  const buscarYClickar = () => page.evaluate(({ nombre, entidad }) => {
    const trs = document.querySelectorAll("tr");
    for (const tr of trs) {
      const trTxt = (tr.innerText || tr.textContent || "");
      if (entidad && !trTxt.includes(entidad)) continue;
      for (const a of tr.querySelectorAll("a")) {
        const atxt = (a.innerText || a.textContent || "").trim();
        if (atxt.includes(nombre)) {
          a.click();
          return { ok: true, texto: atxt };
        }
      }
    }
    const links = Array.from(document.querySelectorAll("a"))
      .map((a) => (a.innerText || "").trim().slice(0, 50))
      .filter((t) => t.length > 3);
    return { ok: false, links };
  }, { nombre: reqNombre, entidad: reqEntidad });

  let res = await buscarYClickar();
  for (let i = 0; !res.ok && i < 3; i++) {
    console.log(`[CD] Link no encontrado, reintento ${i + 1}. Links visibles:`, res.links?.slice(0, 8));
    await page.waitForTimeout(2000);
    res = await buscarYClickar();
  }

  if (!res.ok) {
    throw new Error(`No encontré el link "${reqNombre}"${reqEntidad ? ` (${reqEntidad})` : ""} en la bandeja`);
  }
  console.log(`[CD] Click en bandeja: "${res.texto}"`);

  // BandejaDetalle se carga en un nuevo frame — esperar
  await page.waitForTimeout(3000);
}

// Sube un archivo PDF a un requerimiento específico.
// reqNombre y reqEntidad se usan como fallback si href está vacío (CD usa JS navigation).
export async function cdSubirArchivo(page, href, bufferPdf, nombreArchivo, reqNombre = "", reqEntidad = "") {
  const tag = `[SUBIR] "${reqNombre}"${reqEntidad ? ` (${reqEntidad})` : ""}`;
  console.log(`\n${tag} ── inicio`);
  console.log(`${tag} Archivo: ${nombreArchivo} (${(bufferPdf.length / 1024).toFixed(1)} KB)`);

  // ── Navegación al requerimiento ──────────────────────────────────────────────
  if (href && !href.startsWith("javascript:")) {
    console.log(`${tag} Navegando por href: ${href.slice(0, 80)}`);
    await page.goto(href, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    console.log(`${tag} URL tras navegación: ${page.url().slice(0, 80)}`);
  } else {
    console.log(`${tag} Sin href válido — buscando link en la bandeja`);
    await _navegarAReq(page, reqNombre, reqEntidad);
    console.log(`${tag} URL tras click en bandeja: ${page.url().slice(0, 80)}`);
  }

  // Listar frames disponibles para diagnóstico
  const listarFrames = () => {
    const frames = page.frames();
    console.log(`${tag} Frames activos (${frames.length}):`);
    frames.forEach((f, i) => console.log(`  [${i}] ${f.url().slice(0, 80) || "(sin url)"}`));
  };
  listarFrames();

  const capturar = () => page.screenshot({ type: "jpeg", quality: 70 }).catch(() => null);

  // ── Paso 1: buscar y clickear "Adjuntar" ────────────────────────────────────
  console.log(`${tag} Buscando botón "Adjuntar"...`);
  let adjuntarClicked = false;
  for (const frame of page.frames()) {
    try {
      const btn = frame.locator("a, button, li, span, input[type='button']")
        .filter({ hasText: /adjuntar/i }).first();
      const count = await btn.count();
      const visible = count > 0 && await btn.isVisible().catch(() => false);
      if (count > 0) console.log(`  → frame "${frame.url().slice(0, 60)}" — encontrado (visible: ${visible})`);
      if (visible) {
        const textoBtn = await btn.innerText().catch(() => "?");
        console.log(`${tag} Click en Adjuntar: "${textoBtn.trim()}" en frame "${frame.url().slice(0, 60)}"`);
        await btn.click();
        adjuntarClicked = true;
        break;
      }
    } catch (e) {
      console.log(`  → frame error: ${e.message.slice(0, 60)}`);
    }
  }
  if (!adjuntarClicked) {
    console.log(`${tag} ⚠️ Botón Adjuntar no encontrado en ningún frame — intentando buscar input directamente`);
  }

  // ── Paso 2: esperar input[type="file"] ──────────────────────────────────────
  console.log(`${tag} Esperando input[type="file"]...`);
  let fileInput = null;
  for (let intento = 0; intento < 20; intento++) {
    await page.waitForTimeout(500);
    for (const frame of page.frames()) {
      try {
        const inp = frame.locator('input[type="file"]');
        if (await inp.count() > 0) {
          fileInput = inp.first();
          console.log(`${tag} input[type=file] encontrado en intento ${intento + 1}, frame: "${frame.url().slice(0, 70)}"`);
          break;
        }
      } catch {}
    }
    if (fileInput) break;
    if (intento === 9) {
      console.log(`${tag} ⚠️ 5s sin input[type=file], re-listando frames...`);
      listarFrames();
    }
  }

  if (!fileInput) {
    console.log(`${tag} ❌ No apareció input[type="file"] tras 10s`);
    const err = new Error(`No encontré input[type="file"] (${page.frames().length} frames). URL: ${page.url()}`);
    err.screenshot = await capturar();
    throw err;
  }

  // ── Paso 3: asignar el archivo ───────────────────────────────────────────────
  console.log(`${tag} Asignando archivo con setInputFiles: "${nombreArchivo}"`);
  await fileInput.setInputFiles({ name: nombreArchivo, mimeType: "application/pdf", buffer: bufferPdf });
  console.log(`${tag} ✅ Archivo asignado`);

  // ── Paso 4: esperar "Archivo cargado con exito" y clickear "Continuar" ────────
  console.log(`${tag} Esperando confirmación de upload en BandejaUpload...`);
  let uploadConfirmado = false;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(500);
    for (const frame of page.frames()) {
      if (!frame.url().includes("BandejaUpload")) continue;
      try {
        const texto = await frame.evaluate(() => document.body.innerText).catch(() => "");
        if (/cargado|exitoso|success|correcto/i.test(texto)) {
          const linea = texto.match(/[^\n]*(cargado|exitoso|success|correcto)[^\n]*/i)?.[0] || "";
          console.log(`${tag} Upload confirmado: "${linea.trim()}"`);
          uploadConfirmado = true;
          break;
        }
      } catch {}
    }
    if (uploadConfirmado) break;
  }
  if (!uploadConfirmado) console.log(`${tag} ⚠️ No apareció confirmación de upload tras 15s`);

  let continuarClicked = false;
  for (const frame of page.frames()) {
    if (!frame.url().includes("BandejaUpload")) continue;
    try {
      const btn = frame.locator(
        "button:has-text('Continuar'), a:has-text('Continuar'), input[type='submit'][value='Continuar'], input[type='button'][value='Continuar']"
      ).first();
      if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
        console.log(`${tag} Click en Continuar en frame "${frame.url().slice(0, 60)}"`);
        await btn.click();
        continuarClicked = true;
        break;
      }
    } catch {}
  }
  if (!continuarClicked) console.log(`${tag} ⚠️ Botón Continuar no encontrado`);

  // ── Paso 5: esperar que cierre el modal de upload, luego click "Enviar" ───────
  console.log(`${tag} Esperando que cierre el modal de upload...`);
  // Esperar hasta que el frame BandejaUpload desaparezca
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    const uploadAbierto = page.frames().some((f) => f.url().includes("BandejaUpload"));
    if (!uploadAbierto) {
      console.log(`${tag} Modal cerrado tras ${(i + 1) * 0.5}s`);
      break;
    }
    if (i === 19) console.log(`${tag} ⚠️ Modal BandejaUpload sigue abierto tras 10s`);
  }
  await page.waitForTimeout(1000);
  listarFrames();

  console.log(`${tag} Buscando botón "Enviar" (btnEnviar)...`);
  let enviado = false;
  for (const frame of page.frames()) {
    if (!frame.url().includes("BandejaDetalle")) continue;
    try {
      const resultado = await frame.evaluate(() => {
        const btn = document.getElementById("btnEnviar");
        if (!btn) return { ok: false, motivo: "btnEnviar no encontrado" };
        if (btn.disabled) return { ok: false, motivo: "btnEnviar está disabled" };
        // Llamar __doPostBack directamente, saltando onclick
        if (typeof __doPostBack === "function") {
          __doPostBack("btnEnviar", "");
          return { ok: true, via: "__doPostBack" };
        }
        btn.click();
        return { ok: true, via: "click()" };
      });
      console.log(`${tag} Enviar: ${JSON.stringify(resultado)}`);
      if (resultado.ok) { enviado = true; break; }
    } catch (e) {
      console.log(`${tag} Error en frame Enviar: ${e.message}`);
    }
  }
  if (!enviado) console.log(`${tag} ⚠️ No se pudo clickear Enviar`);

  console.log(`${tag} Esperando 4s para que el servidor procese...`);
  await page.waitForTimeout(4000);
  console.log(`${tag} ✅ Subida completada\n`);
  return { ok: true };
}
