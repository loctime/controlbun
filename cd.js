import { chromium } from "playwright";

const CD_URL = "https://controldocumentario.com";
const BANDEJA_URL = `${CD_URL}/Bandeja.aspx?menu=1`;

let _browser = null;
async function getBrowser() {
  const headless = process.env.BROWSER_HEADLESS !== 'false';
  if (!_browser) _browser = await chromium.launch(headless ? {} : { headless: false, slowMo: 400 });
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

// Detecta el nombre del proveedor/empresa desde la bandeja de CD.
// El nombre aparece en la primera columna del área de trabajo.
// Devuelve string o null si no pudo detectar.
export async function cdDetectarNombreEmpresa(page) {
  try {
    await page.goto(BANDEJA_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    await _clickBuscarYEsperar(page);

    const resultado = await page.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

      // Buscar en la primera columna de cada fila de tabla en el área de trabajo.
      // El nombre del proveedor suele estar en la primera celda de una fila de encabezado/datos.
      const filas = Array.from(document.querySelectorAll("tr"));
      const candidatos = [];
      for (const tr of filas) {
        const celdas = tr.querySelectorAll("td, th");
        if (!celdas.length) continue;
        const primeraCelda = norm(celdas[0].textContent);
        // Descartar celdas vacías, muy largas, o que son claramente headers genéricos
        if (!primeraCelda || primeraCelda.length < 3 || primeraCelda.length > 80) continue;
        if (/^\d+$/.test(primeraCelda)) continue; // solo números
        if (/requerimiento|recurso|estado|fecha|acciones|buscar|filtro|n[uú]mero/i.test(primeraCelda)) continue;
        candidatos.push(primeraCelda);
      }
      // Devolver todos los candidatos para que el llamador pueda elegir o loguear
      return candidatos;
    });

    console.log(`[CD] Candidatos nombre empresa (primera columna): ${JSON.stringify(resultado.slice(0, 8))}`);

    // Tomar el primer candidato que tenga pinta de nombre (letras y espacios, no solo tecnicismos)
    const nombre = resultado.find(c =>
      /[A-Za-záéíóúÁÉÍÓÚñÑ]{3,}/.test(c) &&
      !/^\d{4}-\d+$/.test(c) // no es un período
    );

    if (nombre) console.log(`[CD] Nombre empresa detectado: "${nombre}"`);
    return nombre || null;
  } catch (e) {
    console.log(`[CD] No pudo detectar nombre empresa: ${e.message}`);
    return null;
  }
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

// Verifica si un req quedó en Borrador tras la subida.
// Asume que page ya está en Bandeja.aspx. Refresca con Buscar.
// Devuelve true si fue enviado (no Borrador), false si sigue en borrador.
async function _verificarNoBorrador(page, reqNombre, reqEntidad) {
  await _clickBuscarYEsperar(page);
  return page.evaluate(([nombre, entidad]) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
    const nNom = norm(nombre);
    const nEnt = entidad ? norm(entidad) : null;
    for (const tr of document.querySelectorAll("tr")) {
      const link = tr.querySelector("a");
      if (!link) continue;
      const linkText = norm(link.textContent);
      if (!linkText.includes(nNom)) continue;
      if (nEnt) {
        const rowText = norm(tr.textContent);
        if (!rowText.includes(nEnt)) continue;
      }
      return !linkText.includes("borrador");
    }
    return true; // fila no encontrada → req enviado y quitado de pendientes
  }, [reqNombre, reqEntidad]);
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

  const reqs = await page.evaluate(() => {
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
          // fnDetalle(ID) — patrón principal de CD para navegación de reqs
          const fnMatch = oc.match(/fnDetalle\((\d+)\)/);
          if (fnMatch) {
            try { href = new URL(`BandejaDetalle.aspx?origen=${fnMatch[1]}`, window.location.href).href; } catch {}
          }
          if (!href) {
            const m = oc.match(/location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i) ||
                      oc.match(/['"](\/?[A-Za-z][^\s'"]*\.aspx[^'"]*)['"]/i);
            if (m) { try { href = new URL(m[1], window.location.href).href; } catch {} }
          }
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

  return reqs;
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

// Navega al requerimiento cuando no hay href guardado.
// Re-lee la bandeja en el momento de la subida para obtener un href fresco —
// igual que /unico que siempre funciona porque lee y navega en el mismo momento.
async function _navegarAReq(page, reqNombre, reqEntidad) {
  console.log(`[CD] _navegarAReq: re-leyendo bandeja para obtener href fresco`);
  const reqsFrescos = await cdLeerRequerimientos(page);

  const reqFresco = reqsFrescos.find(
    (r) => r.nombre === reqNombre && (!reqEntidad || r.entidad === reqEntidad)
  );

  if (reqFresco?.href) {
    console.log(`[CD] _navegarAReq: href fresco → ${reqFresco.href.slice(0, 80)}`);
    const origenMatch = reqFresco.href.match(/origen=(\d+)/);
    if (origenMatch && !reqFresco.href.includes("noCache=")) {
      // URL de fnDetalle: ya estamos en Bandeja tras cdLeerRequerimientos, ejecutar fnDetalle
      console.log(`[CD] _navegarAReq: ejecutando fnDetalle(${origenMatch[1]})`);
      await page.evaluate((id) => { fnDetalle(id); }, parseInt(origenMatch[1]));
      await page.waitForTimeout(3000);
    } else {
      await page.goto(reqFresco.href, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
    }
    return;
  }

  // Si cdLeerRequerimientos no encontró href, los logs de debug habrán mostrado
  // el href-attr y onclick del link — usar esa info para el siguiente ciclo de mejoras.
  throw new Error(`No se encontró href para "${reqNombre}"${reqEntidad ? ` (${reqEntidad})` : ""} en la bandeja. Ver logs [CD] Sin href para diagnóstico.`);
}

// Sube un archivo PDF a un requerimiento específico.
// reqNombre y reqEntidad se usan como fallback si href está vacío (CD usa JS navigation).
export async function cdSubirArchivo(page, href, bufferPdf, nombreArchivo, reqNombre = "", reqEntidad = "", _reintento = 0) {
  const tag = `[SUBIR] "${reqNombre}"${reqEntidad ? ` (${reqEntidad})` : ""}${_reintento > 0 ? ` [reintento ${_reintento}]` : ""}`;
  console.log(`\n${tag} ── inicio`);
  console.log(`${tag} Archivo: ${nombreArchivo} (${(bufferPdf.length / 1024).toFixed(1)} KB)`);

  // ── Navegación al requerimiento ──────────────────────────────────────────────
  if (href && !href.startsWith("javascript:")) {
    if (href.includes("noCache=")) {
      // URL directa (link.href de CD): navegar como página principal
      console.log(`${tag} Navegando por href directo: ${href.slice(0, 80)}`);
      await page.goto(href, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
    } else {
      // URL derivada de fnDetalle(ID): BandejaDetalle solo funciona como iframe
      const origenMatch = href.match(/origen=(\d+)/);
      if (origenMatch) {
        console.log(`${tag} Navegando via fnDetalle(${origenMatch[1]}) desde bandeja`);
        await page.goto(BANDEJA_URL, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(1500);
        await page.evaluate((id) => { fnDetalle(id); }, parseInt(origenMatch[1]));
        await page.waitForTimeout(3000);
      } else {
        await page.goto(href, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(1500);
      }
    }
    console.log(`${tag} URL tras navegación: ${page.url().slice(0, 80)}`);
  } else {
    console.log(`${tag} Sin href válido — buscando link en la bandeja`);
    await _navegarAReq(page, reqNombre, reqEntidad);
    console.log(`${tag} URL tras navegación: ${page.url().slice(0, 80)}`);
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

  // Si no hubo confirmación de upload, verificar que el req no quedó en Borrador
  if (!uploadConfirmado && reqNombre) {
    console.log(`${tag} Upload sin confirmar — verificando Borrador en bandeja...`);
    await page.goto(BANDEJA_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const fueEnviado = await _verificarNoBorrador(page, reqNombre, reqEntidad);
    if (!fueEnviado) {
      if (_reintento < 1) {
        console.log(`${tag} ⚠️ Req en Borrador — reintentando (intento 2/2)...`);
        return cdSubirArchivo(page, "", bufferPdf, nombreArchivo, reqNombre, reqEntidad, _reintento + 1);
      }
      const err = new Error(`Quedó en Borrador tras 2 intentos.`);
      err.borrador = true;
      err.screenshot = await capturar();
      throw err;
    }
    console.log(`${tag} ✅ Verificado: fue enviado correctamente (no Borrador)`);
  }

  console.log(`${tag} ✅ Subida completada\n`);
  return { ok: true };
}

// Graba el parte mensual en ParteMensual.aspx para Personal y Maquinas.
// Solo tilda la columna del mes actual (evita tocar meses futuros).
// Devuelve { personal: { actualizados, total }, maquinas: { actualizados, total } }
export async function cdGrabarParteMensual(page) {
  const PARTE_URL = `${CD_URL}/ParteMensual.aspx?menu=8`;

  await page.goto(PARTE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  const seleccionarTipo = (texto) => page.evaluate((t) => {
    function norm(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim(); }
    const buscado = norm(t);
    for (const sel of document.querySelectorAll("select")) {
      const opts = Array.from(sel.options || []);
      if (!opts.some(o => norm(o.text) === "personal")) continue;
      const opt = opts.find(o => norm(o.text) === buscado);
      if (!opt) continue;
      if (sel.value === opt.value) return { ok: true, yaEstaba: true };
      sel.value = opt.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, yaEstaba: false };
    }
    return { ok: false };
  }, texto);

  // Activa "Sólo sin confirmar" si no está marcado y hace Buscar
  const clickBuscar = async () => {
    await page.evaluate(() => {
      for (const cb of document.querySelectorAll("input[type='checkbox']")) {
        const label = (cb.labels?.[0]?.textContent || cb.title || cb.id || "").toLowerCase();
        if (label.includes("sin confirmar") || label.includes("sinconfirmar")) {
          if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true })); }
          break;
        }
      }
    });
    const btn = page.locator('input[type="submit"], input[type="button"], button').filter({ hasText: /buscar/i }).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      await page.waitForTimeout(3000);
    }
  };

  const estadoCheckboxes = () => page.evaluate(() => {
    const cbs = Array.from(document.querySelectorAll("td input[type='checkbox']"));
    return {
      total: cbs.length,
      habilitados: cbs.filter(c => !c.disabled).length,
      sinMarcar: cbs.filter(c => !c.disabled && !c.checked).length,
      deshabilitados: cbs.filter(c => c.disabled).length,
    };
  });

  // Buscar → tildar → Grabar. Repite hasta que no queden checkboxes sin marcar tras el Buscar.
  const tildarMesActualYGrabar = async (tipo) => {
    let totalActualizados = 0;

    for (let intento = 1; intento <= 5; intento++) {
      // Siempre buscar al inicio de cada intento (la primera vez y tras cada postback)
      await clickBuscar();

      const estado = await estadoCheckboxes();
      console.log(`[PARTE] ${tipo} intento ${intento}: total=${estado.total} habilitados=${estado.habilitados} sinMarcar=${estado.sinMarcar} deshabilitados=${estado.deshabilitados}`);

      if (estado.sinMarcar === 0) {
        console.log(`[PARTE] ${tipo}: sin pendientes → OK`);
        break;
      }

      const actualizados = await page.evaluate(() => {
        let n = 0;
        for (const cb of document.querySelectorAll("td input[type='checkbox']")) {
          if (!cb.disabled && !cb.checked) { cb.checked = true; n++; }
        }
        return n;
      });
      totalActualizados += actualizados;
      console.log(`[PARTE] ${tipo}: tildados ${actualizados}`);

      const btnGrabar = page.locator("#ctl00_ContentPlaceHolderMain_btGrabar");
      const btnVisible = await btnGrabar.isVisible().catch(() => false);
      console.log(`[PARTE] ${tipo}: botón Grabar visible=${btnVisible}`);
      if (!btnVisible) { console.log(`[PARTE] ${tipo}: botón no encontrado, abortando`); break; }

      await page.evaluate(() => {
        window.confirmaParte = function() { __doPostBack("ctl00$ContentPlaceHolderMain$btGrabar", ""); };
      });
      console.log(`[PARTE] ${tipo}: click Grabar…`);
      await Promise.all([
        page.waitForLoadState("domcontentloaded").catch(() => {}),
        btnGrabar.click(),
      ]);
      await page.waitForTimeout(3000);
      console.log(`[PARTE] ${tipo}: post-grabar url=${page.url()}`);
    }

    return { actualizados: totalActualizados, total: 0 };
  };

  // Personal (defecto al cargar la página)
  const selPers = await seleccionarTipo("personal");
  if (!selPers.yaEstaba) await page.waitForTimeout(3000);
  const personal = await tildarMesActualYGrabar("personal");

  // Maquinas — mismo patrón que cdLeerVencimientos: mismo page, solo cambiar dropdown
  const selMaq = await seleccionarTipo("maquinas");
  if (!selMaq.ok) {
    console.log("[PARTE] Dropdown maquinas no encontrado");
    return { personal, maquinas: { actualizados: 0, total: 0 } };
  }
  if (!selMaq.yaEstaba) await page.waitForTimeout(5000);
  const maquinas = await tildarMesActualYGrabar("maquinas");

  return { personal, maquinas };
}

// Finds the frame that contains the Generar modal (#cmbTipoRecurso).
// Polls up to ~10s after clicking Generar.
async function _esperarFrameModal(page) {
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    for (const frame of page.frames()) {
      try {
        const found = await frame.evaluate(() => !!document.getElementById("cmbTipoRecurso"));
        if (found) return frame;
      } catch {}
    }
  }
  return null;
}

const _cerrarModalGenerar = async (frame) => {
  try {
    await frame.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("a, button, input[type='button']"))
        .find(el => /volver/i.test((el.textContent || el.value || "").trim()));
      if (btn) btn.click();
    });
  } catch {}
};

// Scrapes the Generar modal (inside its iframe) to find which category
// (empresa/personal/maquinas) a requirement belongs to.
// Returns { tipo, nombreEnModal } or null if not found.
export async function cdScrapearTipoRequerimiento(page, nombreRequerido) {
  const tag = `[SCRAPE-TIPO] "${nombreRequerido}"`;
  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/-\d{4}-\d+$/i, "").trim();
  const buscado = norm(nombreRequerido);

  await page.goto(BANDEJA_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  const btnGenerar = page.locator('input[type="button"], button').filter({ hasText: /^generar$/i }).last();
  if (!await btnGenerar.isVisible().catch(() => false)) {
    console.log(`${tag} Botón Generar no encontrado`);
    return null;
  }
  await btnGenerar.click();

  // The modal opens inside an iframe — poll all frames until #cmbTipoRecurso appears
  const mf = await _esperarFrameModal(page);
  if (!mf) {
    console.log(`${tag} Frame del modal no encontrado`);
    return null;
  }
  console.log(`${tag} Modal frame: ${mf.url().slice(0, 80)}`);

  // Read available tipo options (skip default "*")
  const tipoOpts = await mf.evaluate(() => {
    const sel = document.getElementById("cmbTipoRecurso");
    if (!sel) return [];
    return Array.from(sel.options)
      .filter(o => o.value !== "*" && o.value !== "")
      .map(o => ({ value: o.value, text: (o.text || "").trim() }));
  });

  if (!tipoOpts.length) {
    console.log(`${tag} #cmbTipoRecurso sin opciones`);
    await _cerrarModalGenerar(mf);
    return null;
  }

  for (const tipoOpt of tipoOpts) {
    const tipoNorm = norm(tipoOpt.text);

    // Select tipo and trigger setTipoRecurso() to load cmbSobre via AJAX
    await mf.evaluate((v) => {
      const sel = document.getElementById("cmbTipoRecurso");
      if (!sel) return;
      sel.value = v;
      if (typeof setTipoRecurso === "function") setTipoRecurso(sel);
      else sel.dispatchEvent(new Event("change", { bubbles: true }));
    }, tipoOpt.value);

    // Wait for cmbSobre to load real options
    try {
      await mf.waitForFunction(() => {
        const sel = document.getElementById("cmbSobre");
        return sel && sel.options.length > 1;
      }, { timeout: 8000 });
    } catch {
      console.log(`${tag} tipo="${tipoNorm}": cmbSobre no cargó`);
      continue;
    }

    const opciones = await mf.evaluate(() => {
      const sel = document.getElementById("cmbSobre");
      if (!sel) return [];
      return Array.from(sel.options).map(o => ({ value: o.value, text: (o.text || "").trim() }));
    });

    console.log(`${tag} tipo="${tipoNorm}" → ${opciones.length} opciones: ${opciones.slice(0, 4).map(o => o.text).join(", ")}`);

    const match = opciones.find(o => norm(o.text) === buscado);

    if (match) {
      console.log(`${tag} ✅ tipo=${tipoNorm}, nombreEnModal="${match.text}"`);
      await _cerrarModalGenerar(mf);
      await page.waitForTimeout(1000);
      return { tipo: tipoNorm, nombreEnModal: match.text };
    }

    // Reset before next tipo
    await mf.evaluate(() => {
      const sel = document.getElementById("cmbTipoRecurso");
      if (sel) { sel.value = "*"; sel.dispatchEvent(new Event("change", { bubbles: true })); }
    });
    await page.waitForTimeout(500);
  }

  await _cerrarModalGenerar(mf);
  await page.waitForTimeout(1000);
  console.log(`${tag} No encontrado en ningún tipo`);
  return null;
}

// Automates the Generar modal (inside its iframe) to create a new requirement.
// tipo: normalized name ("empresa" | "personal" | "maquinas")
export async function cdGenerarRequerimiento(page, tipo, nombreRequerido, sector = null) {
  const tag = `[GENERAR] "${nombreRequerido}" (${tipo})`;
  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/-\d{4}-\d+$/i, "").trim();
  const buscado = norm(nombreRequerido);

  await page.goto(BANDEJA_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  const capturar = () => page.screenshot({ type: "jpeg", quality: 70 }).catch(() => null);

  const btnGenerar = page.locator('input[type="button"], button').filter({ hasText: /^generar$/i }).last();
  if (!await btnGenerar.isVisible().catch(() => false)) {
    const err = new Error("Botón Generar no encontrado en el área de trabajo");
    err.screenshot = await capturar();
    throw err;
  }
  await btnGenerar.click();

  // Find the modal iframe
  const mf = await _esperarFrameModal(page);
  if (!mf) {
    const err = new Error("Frame del modal Generar no apareció");
    err.screenshot = await capturar();
    throw err;
  }
  console.log(`${tag} Modal abierto en frame: ${mf.url().slice(0, 80)}`);

  // Find tipo option value
  const tipoValue = await mf.evaluate((t) => {
    const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
    const sel = document.getElementById("cmbTipoRecurso");
    if (!sel) return null;
    const opt = Array.from(sel.options).find(o => norm(o.text) === t);
    return opt ? opt.value : null;
  }, tipo);

  if (!tipoValue) {
    const err = new Error(`Tipo "${tipo}" no encontrado en #cmbTipoRecurso`);
    err.screenshot = await capturar();
    throw err;
  }

  // Select tipo → trigger setTipoRecurso → AJAX loads cmbSobre options
  await mf.evaluate((v) => {
    const sel = document.getElementById("cmbTipoRecurso");
    sel.value = v;
    if (typeof setTipoRecurso === "function") setTipoRecurso(sel);
    else sel.dispatchEvent(new Event("change", { bubbles: true }));
  }, tipoValue);

  await mf.waitForFunction(() => {
    const sel = document.getElementById("cmbSobre");
    return sel && sel.options.length > 1;
  }, { timeout: 10000 });
  console.log(`${tag} Tipo seleccionado, cmbSobre cargado`);

  // Find the matching option value in cmbSobre
  const sobreOpt = await mf.evaluate((b) => {
    const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/-\d{4}-\d+$/i, "").trim();
    const sel = document.getElementById("cmbSobre");
    if (!sel) return null;
    const exact = Array.from(sel.options).find(o => norm(o.text) === b);
    return exact ? { value: exact.value, text: exact.text } : null;
  }, buscado);

  if (!sobreOpt) {
    const err = new Error(`Requerido "${nombreRequerido}" no encontrado en #cmbSobre (tipo: ${tipo})`);
    err.screenshot = await capturar();
    throw err;
  }

  // selectOption fires the DOM change event → setSobre sets hfSobre and loads entity list.
  // No __doPostBack — the UpdatePanel refresh overwrites hfCodigoEstado0 with empty,
  // which breaks the SOAP call on the server side.
  await mf.locator('#cmbSobre').selectOption({ value: sobreOpt.value });
  console.log(`${tag} Sobre seleccionado: "${sobreOpt.text}"`);

  // Wait for setSobre AJAX to settle (entity list or hidden fields)
  await page.waitForTimeout(3000);

  // Handle optional "Sectores" dropdown (appears for some empresa-type sobres)
  const sectoresInfo = await mf.evaluate(() => {
    let sel = document.getElementById("cmbSectores") || document.getElementById("cmbSector");
    if (!sel) {
      sel = Array.from(document.querySelectorAll("select")).find(s =>
        s.options[0] && /sector/i.test(s.options[0].text) && s.offsetParent !== null
      );
    }
    if (!sel || !sel.offsetParent) return null;
    const opts = Array.from(sel.options).filter(o => o.value && o.value.trim() !== "");
    return opts.length > 0 ? { id: sel.id, opts: opts.map(o => ({ value: o.value, text: o.text.trim() })) } : null;
  });

  const _seleccionarSector = async (id, v) => {
    await mf.evaluate(({ id, v }) => {
      const sel = document.getElementById(id);
      sel.value = v;
      // Try named handler (CD pattern: setSectores / setSector), then onchange, then event
      const fnName = `set${id.replace(/^cmb/i, "")}`;
      if (typeof window[fnName] === "function") window[fnName](sel);
      else if (typeof sel.onchange === "function") sel.onchange.call(sel);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }, { id, v });
    await page.waitForTimeout(1500);
  };

  if (sectoresInfo) {
    if (sectoresInfo.opts.length === 1) {
      await _seleccionarSector(sectoresInfo.id, sectoresInfo.opts[0].value);
      console.log(`${tag} Sector auto-seleccionado: "${sectoresInfo.opts[0].text}"`);
    } else if (sector) {
      const opt = sectoresInfo.opts.find(o =>
        o.text.toLowerCase().includes(sector.toLowerCase()) || String(o.value) === String(sector)
      );
      if (!opt) {
        const err = new Error(`Sector "${sector}" no encontrado. Opciones: ${sectoresInfo.opts.map(o => o.text).join(", ")}`);
        err.screenshot = await capturar();
        throw err;
      }
      await _seleccionarSector(sectoresInfo.id, opt.value);
      console.log(`${tag} Sector seleccionado: "${opt.text}"`);
    } else {
      const err = new Error(`Debe informar sector`);
      err.screenshot = await capturar();
      err.sectores = sectoresInfo.opts;
      throw err;
    }
  }

  // Click "Todos" if the link exists (selects all entity checkboxes)
  try {
    await mf.locator('a').filter({ hasText: /^todos?$/i }).first().click({ timeout: 2000 });
    console.log(`${tag} "Todos" clickeado`);
    await page.waitForTimeout(800);
  } catch {
    // No "Todos" link — empresa type with no entity list, proceed directly
  }

  // Verificar checkboxes seleccionados antes de grabar
  const checkInfo = await mf.evaluate(() => {
    const checks = Array.from(document.querySelectorAll("input[type=checkbox]:checked"));
    const btGrabar = document.getElementById("btGrabar");
    return {
      checksSeleccionados: checks.length,
      btGrabarExiste: !!btGrabar,
      btGrabarVisible: btGrabar ? btGrabar.offsetParent !== null : false,
      btGrabarDisabled: btGrabar ? btGrabar.disabled : null,
    };
  });
  console.log(`${tag} Antes de grabar: checks=${checkInfo.checksSeleccionados} btGrabar=${checkInfo.btGrabarExiste} visible=${checkInfo.btGrabarVisible} disabled=${checkInfo.btGrabarDisabled}`);

  if (!checkInfo.btGrabarExiste) {
    const err = new Error("btGrabar no encontrado antes de grabar");
    err.screenshot = await capturar();
    throw err;
  }

  // Override alert/confirm so they don't block, then call GrabarRequerimientos normally
  const grabarResult = await mf.evaluate(() => {
    window.__cdAlert = null;
    window.alert = (msg) => { window.__cdAlert = msg; };
    window.confirm = () => true; // auto-confirm "hay pendientes"

    const btn = document.getElementById("btGrabar");
    if (!btn) return { error: "btGrabar no encontrado" };

    console.log("[CD-EVAL] llamando GrabarRequerimientos, btn.id=" + btn.id + " btn.value=" + btn.value);
    const result = typeof GrabarRequerimientos === "function"
      ? GrabarRequerimientos(btn)
      : null;
    console.log("[CD-EVAL] GrabarRequerimientos retornó:", result, "alerta:", window.__cdAlert);

    const hfSector = document.getElementById("hfSector") || document.getElementById("hfSectores");
    return {
      result,
      hfTipo: document.getElementById("hfTipoRecurso")?.value,
      hfSector: hfSector?.value,
      alerta: window.__cdAlert,
    };
  }).catch(e => ({ error: e.message }));

  const alerta = grabarResult.alerta || null;
  const exito = grabarResult.result === true;
  console.log(`${tag} hfTipo=${grabarResult.hfTipo} hfSector=${grabarResult.hfSector}`);
  console.log(`${tag} grabarResult completo: ${JSON.stringify(grabarResult)}`);
  console.log(`${tag} ${exito ? "✅" : "❌"} ${alerta || JSON.stringify(grabarResult)}`);

  if (!exito) {
    const err = new Error(alerta || "GrabarRequerimientos retornó false");
    err.screenshot = await capturar();
    throw err;
  }

  // Esperar a que el postback/AJAX de generación complete (la página principal recarga)
  console.log(`${tag} esperando recarga post-generación...`);
  try {
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 });
    console.log(`${tag} página recargó: ${page.url().slice(0, 80)}`);
  } catch {
    console.log(`${tag} sin navegación detectada, esperando 3s extra`);
    await page.waitForTimeout(3000);
  }
  console.log(`${tag} URL final: ${page.url().slice(0, 80)}`);
  return { ok: true, mensaje: alerta };
}

// Lee vencimientos próximos de Vencimientos.aspx (Empresa + Personal + Máquinas + proveedor).
// diasPersonal, diasVehiculos y diasEmpresa controlan el umbral por tipo.
// Devuelve [{ tipo: "empresa"|"personal"|"vehiculo"|"general", nombre, columna, fecha, diasFaltantes }]
export async function cdLeerVencimientos(page, diasPersonal = 10, diasVehiculos = 10, diasEmpresa = 10) {
  await page.goto(`${CD_URL}/Vencimientos.aspx?menu=11`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  const seleccionarTipo = (texto) => page.evaluate((t) => {
    function norm(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim(); }
    const buscado = norm(t);
    const conocidos = ["personal", "maquinas", "empresa"];
    for (const sel of document.querySelectorAll("select")) {
      const opts = Array.from(sel.options || []);
      if (!opts.some(o => conocidos.includes(norm(o.text)))) continue;
      const obj = opts.find(o => norm(o.text) === buscado);
      if (!obj) continue;
      if (sel.value === obj.value) return { ok: true, yaEstaba: true };
      sel.value = obj.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      try { if (typeof sel.onchange === "function") sel.onchange(); } catch {}
      return { ok: true, yaEstaba: false };
    }
    return { ok: false };
  }, texto);

  const clickBuscar = async () => {
    const btn = page.locator('input[type="submit"], input[type="button"], button').filter({ hasText: /buscar|consultar/i }).first();
    if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) await btn.click();
    await page.waitForTimeout(5000);
  };

  const leerTabla = (tipoParam, umbralParam) => page.evaluate(([tipo, umbral]) => {
    function parseFecha(t) {
      const m = String(t || "").trim().match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
      if (!m) return null;
      let y = parseInt(m[3]); if (y < 100) y += 2000;
      const f = new Date(y, parseInt(m[2]) - 1, parseInt(m[1]));
      return isNaN(f.getTime()) ? null : f;
    }
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    let mejor = null;
    for (const t of document.querySelectorAll("table")) {
      if (t.querySelector("table")) continue;
      const ths = Array.from(t.querySelectorAll("th")).map(th => (th.textContent || "").trim().toLowerCase());
      if (!ths.some(h => /^(nombre|descripci[oó]n)$/.test(h))) continue;
      mejor = t; break;
    }
    if (!mejor) return { items: [], totalConFecha: 0 };
    const headers = Array.from(mejor.querySelectorAll("th")).map(th => (th.textContent || "").trim());
    const idxEstado = headers.findIndex(h => /^estado/i.test(h));
    const idxNombre = headers.findIndex(h => /^(nombre|descripci[oó]n)/i.test(h));
    const idxPatente = tipo === "vehiculo" ? headers.findIndex(h => /^(patente|dominio|placa|matr[ií]cula)/i.test(h)) : -1;
    let totalConFecha = 0; const items = [];
    for (const tr of mejor.querySelectorAll("tr")) {
      const tds = Array.from(tr.querySelectorAll("td")); if (!tds.length) continue;
      if (idxEstado >= 0 && tds[idxEstado] && /inhabilit/i.test(tds[idxEstado].textContent)) continue;
      let nombre = idxNombre >= 0 && tds[idxNombre] ? (tds[idxNombre].textContent || "").trim() : "";
      if (!nombre) continue;
      if (idxPatente >= 0 && tds[idxPatente]) { const p = (tds[idxPatente].textContent || "").trim(); if (p) nombre = `${p} — ${nombre}`; }
      for (let i = 0; i < tds.length; i++) {
        const f = parseFecha(tds[i].textContent); if (!f) continue;
        totalConFecha++;
        const col = (headers[i] || "").trim(); if (/^estado/i.test(col)) continue;
        const dias = Math.round((f - hoy) / 864e5); if (dias > umbral) continue;
        items.push({ tipo, nombre, columna: col, fecha: (tds[i].textContent || "").trim(), diasFaltantes: dias });
      }
    }
    return { items, totalConFecha };
  }, [tipoParam, umbralParam]);

  const leerGeneral = (umbral) => page.evaluate((u) => {
    function parseFecha(t) {
      const m = String(t || "").trim().match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
      if (!m) return null;
      let y = parseInt(m[3]); if (y < 100) y += 2000;
      const f = new Date(y, parseInt(m[2]) - 1, parseInt(m[1]));
      return isNaN(f.getTime()) ? null : f;
    }
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    let mejor = null, maxF = 0;
    for (const t of document.querySelectorAll("table")) {
      if (t.querySelector("table")) continue;
      const ths = Array.from(t.querySelectorAll("th")); if (!ths.length) continue;
      const headerTxts = ths.map(th => (th.textContent || "").trim().toLowerCase());
      if (headerTxts.some(h => /^(nombre|descripci[oó]n)$/.test(h))) continue;
      let n = 0; for (const td of t.querySelectorAll("td")) if (parseFecha(td.textContent)) n++;
      if (n > maxF) { maxF = n; mejor = t; }
    }
    if (!mejor) return { items: [], totalConFecha: 0 };
    const headers = Array.from(mejor.querySelectorAll("th")).map(th => (th.textContent || "").trim());
    const items = []; let totalConFecha = 0;
    for (const tr of mejor.querySelectorAll("tr")) {
      const tds = Array.from(tr.querySelectorAll("td")); if (!tds.length) continue;
      for (let i = 0; i < tds.length; i++) {
        const f = parseFecha(tds[i].textContent); if (!f) continue;
        totalConFecha++;
        const col = (headers[i] || "").trim();
        const dias = Math.round((f - hoy) / 864e5); if (dias > u) continue;
        items.push({ tipo: "general", nombre: "Proveedor", columna: col, fecha: (tds[i].textContent || "").trim(), diasFaltantes: dias });
      }
    }
    return { items, totalConFecha };
  }, umbral);

  const umbralMax = Math.max(diasPersonal, diasVehiculos);
  const todosItems = [];
  const screenshots = [];

  const capturar = () => page.screenshot({ type: "jpeg", quality: 80, fullPage: true }).catch(() => null);

  // Personal
  const selPers = await seleccionarTipo("personal");
  if (selPers.ok && !selPers.yaEstaba) await page.waitForTimeout(5000);
  await clickBuscar();
  const { items: itemsPers } = await leerTabla("personal", diasPersonal);
  todosItems.push(...itemsPers);
  console.log(`[VENC] Personal: ${itemsPers.length} items`);

  // General/proveedor
  const { items: itemsGen } = await leerGeneral(umbralMax);
  todosItems.push(...itemsGen);
  console.log(`[VENC] General: ${itemsGen.length} items`);

  // Screenshot con Personal + resumen proveedor visibles
  const ssPersonal = await capturar();
  if (ssPersonal) screenshots.push({ buffer: ssPersonal, nombre: "personal.jpg" });

  // Empresa
  const selEmp = await seleccionarTipo("empresa");
  if (selEmp.ok) {
    if (!selEmp.yaEstaba) await page.waitForTimeout(5000);
    await clickBuscar();
    const { items: itemsEmp } = await leerTabla("empresa", diasEmpresa);
    todosItems.push(...itemsEmp);
    console.log(`[VENC] Empresa: ${itemsEmp.length} items`);
    const ssEmp = await capturar();
    if (ssEmp) screenshots.push({ buffer: ssEmp, nombre: "empresa.jpg" });
  } else {
    console.warn("[VENC] No se encontró opción empresa en el dropdown.");
  }

  // Vehículos
  const selMaq = await seleccionarTipo("maquinas");
  if (selMaq.ok) {
    if (!selMaq.yaEstaba) await page.waitForTimeout(5000);
    await clickBuscar();
    const { items: itemsMaq } = await leerTabla("vehiculo", diasVehiculos);
    todosItems.push(...itemsMaq);
    console.log(`[VENC] Vehículos: ${itemsMaq.length} items`);
    const ssMaq = await capturar();
    if (ssMaq) screenshots.push({ buffer: ssMaq, nombre: "vehiculos.jpg" });
  } else {
    console.warn("[VENC] No se encontró opción maquinas en el dropdown.");
  }

  return { items: todosItems, screenshots };
}
