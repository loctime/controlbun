/**
 * test-generar.js — Prueba aislada del flujo de generación de requeridos en CD.
 * Uso: node test-generar.js
 *
 * Poné tus credenciales abajo y el nombre del requerido a generar.
 */

import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";

// ─── CONFIGURAR AQUÍ ────────────────────────────────────────────────────────
const CD_USER = "ferzepsas@gmail.com";
const CD_PASS = "Sistema01?";
const NOMBRE_REQUERIDO = "listado de operarios"; // nombre exacto como aparece en el modal
const TIPO = "empresa"; // empresa | personal | maquinas
// ────────────────────────────────────────────────────────────────────────────

const CD_URL = "https://controldocumentario.com";
const BANDEJA_URL = `${CD_URL}/Bandeja.aspx?menu=1`;

const SS_DIR = "./test-generar-screenshots";
let ssIdx = 0;

async function ss(page, nombre) {
  await fs.mkdir(SS_DIR, { recursive: true });
  const file = path.join(SS_DIR, `${String(ssIdx++).padStart(2, "0")}-${nombre}.jpg`);
  await page.screenshot({ path: file, type: "jpeg", quality: 80, fullPage: false });
  console.log(`  📸 ${file}`);
}

async function main() {
  console.log("=== test-generar.js ===\n");

  const browser = await chromium.launch({ headless: false, slowMo: 300 });
  const context = await browser.newContext();
  const page = await context.newPage();

  // ── Login ──────────────────────────────────────────────────────────────────
  console.log("1. Login...");
  await page.goto(`${CD_URL}/Login.aspx`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.locator('input:not([type="password"]):not([type="hidden"]):visible').first().fill(CD_USER);
  await page.locator('input[type="password"]:visible').first().fill(CD_PASS);
  const espera = page.waitForURL((url) => !url.href.toLowerCase().includes("login"), { timeout: 30000 });
  await page.locator('button, input[type="submit"], input[type="button"]').filter({ hasText: /ingresar/i }).first().click();
  await espera;
  console.log("   ✅ Login OK:", page.url().slice(0, 80));
  await ss(page, "login-ok");

  // ── Ir a la bandeja ────────────────────────────────────────────────────────
  console.log("\n2. Ir a Bandeja...");
  await page.goto(BANDEJA_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await ss(page, "bandeja");

  // ── Buscar botón Generar ───────────────────────────────────────────────────
  console.log("\n3. Buscando botón Generar...");
  const todosBtn = await page.locator('input[type="button"], button').filter({ hasText: /generar/i }).all();
  console.log(`   Botones con "generar": ${todosBtn.length}`);
  for (let i = 0; i < todosBtn.length; i++) {
    const txt = await todosBtn[i].innerText().catch(() => "?");
    const vis = await todosBtn[i].isVisible().catch(() => false);
    console.log(`   [${i}] "${txt.trim()}" visible=${vis}`);
  }

  const btnGenerar = page.locator('input[type="button"], button').filter({ hasText: /^generar$/i }).last();
  const btnVisible = await btnGenerar.isVisible().catch(() => false);
  console.log(`   Botón Generar (último, exact): visible=${btnVisible}`);

  if (!btnVisible) {
    console.log("   ❌ Botón Generar no visible — abortando");
    await ss(page, "error-sin-boton");
    await browser.close();
    return;
  }

  // ── Click Generar ──────────────────────────────────────────────────────────
  console.log("\n4. Click Generar...");
  await btnGenerar.click();
  console.log("   Click enviado, esperando modal...");
  await ss(page, "post-click-generar");

  // ── Esperar frame del modal ────────────────────────────────────────────────
  console.log("\n5. Buscando frame modal (#cmbTipoRecurso)...");
  let mf = null;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    const frames = page.frames();
    console.log(`   Intento ${i + 1}: ${frames.length} frames`);
    for (const frame of frames) {
      try {
        const found = await frame.evaluate(() => !!document.getElementById("cmbTipoRecurso"));
        if (found) {
          mf = frame;
          console.log(`   ✅ Frame encontrado: ${frame.url().slice(0, 100)}`);
          break;
        }
      } catch {}
    }
    if (mf) break;
  }

  if (!mf) {
    console.log("   ❌ Frame no encontrado — listando todos los frames:");
    page.frames().forEach((f, i) => console.log(`   [${i}] ${f.url()}`));
    await ss(page, "error-sin-frame");
    await browser.close();
    return;
  }

  await ss(page, "modal-abierto");

  // ── Extraer fuente de GrabarRequerimientos ─────────────────────────────────
  console.log("\n6. GrabarRequerimientos fuente:");
  const grabarSrc = await mf.evaluate(() =>
    typeof GrabarRequerimientos === "function" ? GrabarRequerimientos.toString() : "NOT_FOUND"
  ).catch(() => "ERROR");
  console.log(grabarSrc);

  // ── Seleccionar tipo ───────────────────────────────────────────────────────
  console.log(`\n7. Seleccionando tipo "${TIPO}"...`);
  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

  const tipoValue = await mf.evaluate((t) => {
    const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
    const sel = document.getElementById("cmbTipoRecurso");
    if (!sel) return null;
    return Array.from(sel.options).find(o => norm(o.text) === t)?.value || null;
  }, norm(TIPO));

  console.log(`   Valor para "${TIPO}": ${tipoValue}`);
  if (!tipoValue) {
    console.log("   ❌ Tipo no encontrado — abortando");
    await browser.close();
    return;
  }

  await mf.evaluate((v) => {
    const sel = document.getElementById("cmbTipoRecurso");
    sel.value = v;
    if (typeof setTipoRecurso === "function") setTipoRecurso(sel);
    else sel.dispatchEvent(new Event("change", { bubbles: true }));
  }, tipoValue);

  // ── Esperar cmbSobre ───────────────────────────────────────────────────────
  console.log("   Esperando cmbSobre...");
  try {
    await mf.waitForFunction(() => {
      const sel = document.getElementById("cmbSobre");
      return sel && sel.options.length > 1;
    }, { timeout: 10000 });
    console.log("   ✅ cmbSobre cargado");
  } catch {
    console.log("   ⚠️ cmbSobre timeout");
  }
  await ss(page, "tipo-seleccionado");

  // ── Leer opciones de cmbSobre ──────────────────────────────────────────────
  console.log("\n8. cmbSobre opciones:");
  const sobreOpts = await mf.evaluate(() => {
    const sel = document.getElementById("cmbSobre");
    if (!sel) return [];
    return Array.from(sel.options).map(o => ({ value: o.value, text: o.text.trim() }));
  });
  console.log(JSON.stringify(sobreOpts, null, 2));

  // ── Seleccionar el requerido via native selectOption ──────────────────────
  console.log(`\n9. Seleccionando requerido "${NOMBRE_REQUERIDO}"...`);
  const buscado = norm(NOMBRE_REQUERIDO.replace(/-\d{4}-\d+$/i, "").trim());

  const sobreOpt = sobreOpts.find(o => {
    const t = norm(o.text.replace(/-\d{4}-\d+$/i, "").trim());
    return t === buscado || t.includes(buscado) || buscado.includes(t);
  });

  if (!sobreOpt) {
    console.log("   ❌ Requerido no encontrado en cmbSobre — abortando");
    await browser.close();
    return;
  }
  console.log(`   Encontrado: "${sobreOpt.text}" (value=${sobreOpt.value})`);

  // Use native selectOption to fire real DOM change → triggers setSobre AJAX
  await mf.locator('#cmbSobre').selectOption({ value: sobreOpt.value });
  console.log("   selectOption enviado — esperando AJAX de entidades (hasta 10s)...");

  // Wait for entity checkboxes to appear
  try {
    await mf.waitForFunction(() =>
      document.querySelectorAll("input[type='checkbox']").length > 0, { timeout: 10000 }
    );
    const cbCount = await mf.evaluate(() =>
      document.querySelectorAll("input[type='checkbox']").length
    );
    console.log(`   ✅ ${cbCount} checkboxes de entidades cargados`);
  } catch {
    console.log("   ⚠️ Sin checkboxes (req global o AJAX no cargó)");
  }
  await ss(page, "req-seleccionado");

  // ── Snapshot post-setSobre ────────────────────────────────────────────────
  console.log("\n10. Estado post-selectOption:");
  const snap10 = await mf.evaluate(() => {
    const cbs = document.querySelectorAll("input[type='checkbox']");
    const inputs = Array.from(document.querySelectorAll("input")).map(i =>
      `${i.type}#${i.id || i.name} val=${String(i.value).slice(0, 20)} chk=${i.checked}`
    );
    const links = Array.from(document.querySelectorAll("a")).map(a => a.textContent.trim()).filter(Boolean);
    return { cbs: cbs.length, inputs: inputs.slice(0, 30), links };
  });
  console.log(`   cbs=${snap10.cbs} links=${JSON.stringify(snap10.links)}`);
  console.log(`   inputs=${JSON.stringify(snap10.inputs)}`);

  // ── Click Todos ────────────────────────────────────────────────────────────
  console.log("\n11. Clickeando 'Todos'...");
  try {
    await mf.locator('a').filter({ hasText: /^todos?$/i }).first().click({ timeout: 3000 });
    console.log("   ✅ 'Todos' clickeado (native)");
    await page.waitForTimeout(800);
  } catch {
    console.log("   'Todos' no encontrado");
  }

  const snap11 = await mf.evaluate(() => {
    const cbs = Array.from(document.querySelectorAll("input[type='checkbox']"));
    return { total: cbs.length, checked: cbs.filter(c => c.checked).length };
  });
  console.log(`   Post-Todos: ${snap11.checked}/${snap11.total} tildados`);
  await ss(page, "todos-clickeado");

  // ── Llamar GrabarRequerimientos manualmente ────────────────────────────────
  console.log("\n12. Llamando GrabarRequerimientos manualmente...");
  const grabarResult = await mf.evaluate(() => {
    const btn = document.getElementById("btGrabar");
    if (!btn) return { error: "btn no encontrado" };
    if (typeof GrabarRequerimientos !== "function") return { error: "función no existe" };
    const result = GrabarRequerimientos(btn);
    return { result };
  }).catch(e => ({ error: e.message }));
  console.log(`   GrabarRequerimientos() → ${JSON.stringify(grabarResult)}`);
  await ss(page, "post-grabar-manual");

  // ── Bypass si validación falla ─────────────────────────────────────────────
  if (grabarResult.result !== true) {
    console.log("\n   Validación falló — bypass via __doPostBack directo");
    await mf.evaluate(() => {
      if (typeof __doPostBack === "function") __doPostBack("btGrabar", "");
    }).catch(e => console.log("   Bypass error:", e.message));
  }

  // ── Esperar resultado ──────────────────────────────────────────────────────
  console.log("\n13. Esperando 8s para ver resultado...");
  await page.waitForTimeout(2000);
  await ss(page, "post-submit-2s");
  await page.waitForTimeout(6000);
  await ss(page, "post-submit-8s");

  // ── Ver frames finales ─────────────────────────────────────────────────────
  const framesFinales = page.frames().map(f => f.url());
  console.log("\n14. Frames después de Generar:", framesFinales);

  // Leer contenido del modal si sigue abierto
  for (const frame of page.frames()) {
    try {
      const hayModal = await frame.evaluate(() => !!document.getElementById("cmbTipoRecurso"));
      if (hayModal) {
        const texto = await frame.evaluate(() => document.body.innerText.slice(0, 600));
        console.log("\n   Modal sigue abierto. Texto:\n", texto);
        await ss(page, "modal-sigue-abierto");
        break;
      }
    } catch {}
  }

  console.log("\n=== FIN TEST ===");
  console.log(`Screenshots guardados en: ${SS_DIR}/`);
  console.log("Cerrando browser en 10s...");
  await page.waitForTimeout(10000);
  await browser.close();
}

main().catch(e => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
