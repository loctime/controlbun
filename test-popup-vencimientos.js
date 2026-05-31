/**
 * test-popup-vencimientos.js — Explora el popup que abre CD cuando hacés click en una celda con fecha
 * de la tabla de Vencimientos.aspx (vista Personal). Captura:
 *  - HTML del popup
 *  - XHRs disparados durante el click (para evaluar approach "endpoint directo")
 *  - Screenshots paso a paso
 *
 * Uso: node test-popup-vencimientos.js
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const CD_URL = "https://controldocumentario.com";
const CLIENTE = JSON.parse(fs.readFileSync("./clientes/fernando-vidal.json", "utf8"));
const OUT = "./test-popup-screenshots";
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log("[POPUP]", ...a);
const save = async (page, name) => {
  const p = path.join(OUT, `${name}.jpg`);
  await page.screenshot({ path: p, type: "jpeg", quality: 80, fullPage: true });
  log(`screenshot → ${p}`);
};
const dumpHtml = (name, html) => {
  const p = path.join(OUT, `${name}.html`);
  fs.writeFileSync(p, html);
  log(`html → ${p}`);
};

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Captura de XHR/fetch
  const requests = [];
  page.on("request", (req) => {
    const t = req.resourceType();
    if (t === "xhr" || t === "fetch") {
      requests.push({ ts: Date.now(), method: req.method(), url: req.url(), postData: req.postData() || null });
    }
  });
  const responses = [];
  page.on("response", async (res) => {
    const req = res.request();
    const t = req.resourceType();
    if (t === "xhr" || t === "fetch") {
      let body = null;
      try { body = (await res.text()).slice(0, 2000); } catch {}
      responses.push({ ts: Date.now(), status: res.status(), url: res.url(), bodyPreview: body });
    }
  });

  // === Login ===
  log("login…");
  await page.goto(`${CD_URL}/Login.aspx`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.locator('input:not([type="password"]):not([type="hidden"]):visible').first().fill(CLIENTE.cdUser);
  await page.locator('input[type="password"]:visible').first().fill(CLIENTE.cdPass);
  const espera = page.waitForURL((u) => !u.href.toLowerCase().includes("login"), { timeout: 60000 });
  await page.locator('button, input[type="submit"], input[type="button"]').filter({ hasText: /ingresar/i }).first().click();
  await espera.catch(() => {});
  log("logged. URL:", page.url());
  await save(page, "00-post-login");

  // === Vencimientos.aspx ===
  await page.goto(`${CD_URL}/Vencimientos.aspx?menu=11`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await save(page, "01-vencimientos-inicial");

  // Seleccionar tipo "Personal" — dispara postback ASP.NET
  const navSel = page.waitForLoadState("domcontentloaded").catch(() => {});
  const sel = await page.evaluate(() => {
    function norm(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim(); }
    const conocidos = ["personal", "maquinas", "empresa"];
    for (const s of document.querySelectorAll("select")) {
      const opts = Array.from(s.options || []);
      if (!opts.some(o => conocidos.includes(norm(o.text)))) continue;
      const obj = opts.find(o => norm(o.text) === "personal");
      if (!obj) continue;
      s.value = obj.value;
      s.dispatchEvent(new Event("change", { bubbles: true }));
      try { if (typeof s.onchange === "function") s.onchange(); } catch {}
      return { ok: true, value: s.value };
    }
    return { ok: false };
  });
  log("select personal:", sel);
  await navSel;
  // Producción espera 5s tras cambiar tipo
  await page.waitForTimeout(5000);

  // Esperar a que la barra de progreso del postback anterior termine
  const esperarBarra = async () => {
    try {
      await page.waitForFunction(() => {
        const b = document.getElementById("divBarraProgreso");
        if (!b) return true;
        const s = window.getComputedStyle(b);
        return s.display === "none" || s.visibility === "hidden";
      }, null, { timeout: 15000 });
    } catch { log("WARN: divBarraProgreso no se ocultó"); }
  };
  await esperarBarra();

  // Click Buscar via locator (con divBarraProgreso ya oculto)
  const btn = page.locator('#ctl00_ContentPlaceHolderMain_btBuscar').first();
  const navP = page.waitForLoadState("domcontentloaded").catch(() => {});
  await btn.click({ timeout: 10000 });
  log("click buscar");
  await navP;
  await esperarBarra();
  // Esperar a que aparezcan tablas con fechas
  try {
    await page.waitForFunction(() => {
      function isFecha(t) { return /^\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}$/.test(String(t || "").trim()); }
      for (const t of document.querySelectorAll("table")) {
        if (t.querySelector("table")) continue;
        if (t.offsetParent === null) continue;
        for (const td of t.querySelectorAll("td")) { if (isFecha(td.textContent)) return true; }
      }
      return false;
    }, null, { timeout: 15000 });
    log("tablas con fechas detectadas");
  } catch {
    log("WARN: no se detectaron fechas en tablas tras buscar");
  }
  await page.waitForTimeout(1500);
  await save(page, "02-post-buscar");

  // Volcar conteo de tablas y headers visibles
  const stats = await page.evaluate(() => {
    function norm(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim(); }
    const out = [];
    for (const t of document.querySelectorAll("table")) {
      if (t.querySelector("table")) continue;
      if (t.offsetParent === null) continue;
      const headers = Array.from(t.querySelectorAll("th")).map(th => norm(th.textContent));
      const tds = t.querySelectorAll("td").length;
      out.push({ headers: headers.slice(0, 6), tds });
    }
    return out;
  });
  log("tablas visibles:");
  for (const t of stats) log(`  tds=${t.tds} headers=[${t.headers.join(", ")}]`);

  // Encontrar primera celda con onclick="LRSopen(...)" — esas son las que abren el popup
  const info = await page.evaluate(() => {
    function isFecha(t) { return /^\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}$/.test(String(t || "").trim()); }
    function getHeaders(table) {
      return Array.from(table.querySelectorAll("th")).map(th => (th.textContent || "").trim());
    }

    for (const t of document.querySelectorAll("table")) {
      if (t.querySelector("table")) continue;
      if (t.offsetParent === null) continue;
      const headers = getHeaders(t);
      for (const tr of t.querySelectorAll("tr")) {
        const tds = Array.from(tr.querySelectorAll("td"));
        if (!tds.length) continue;
        for (let i = 0; i < tds.length; i++) {
          const td = tds[i];
          const onclick = td.getAttribute("onclick") || "";
          if (!/LRSopen\s*\(/.test(onclick)) continue;
          if (!isFecha(td.textContent)) continue;
          td.setAttribute("data-popup-target", "1");
          const nombre = tds[1] ? (tds[1].textContent || "").trim() : "";
          const lrsMatch = onclick.match(/LRSopen\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/);
          return {
            ok: true,
            columna: headers[i] || "",
            fecha: (tds[i].textContent || "").trim(),
            nombre,
            onclick,
            lrsArgs: lrsMatch ? { reqId: lrsMatch[1], otherId: lrsMatch[2] } : null,
          };
        }
      }
    }
    return { ok: false, msg: "no LRSopen cell with date" };
  });
  log("celda objetivo:", info);
  if (!info.ok) {
    log("ABORT — no encontré celda con fecha. Revisar screenshots.");
    await browser.close();
    process.exit(1);
  }

  // Snapshot HTML pre-click
  const htmlPre = await page.content();
  dumpHtml("03-html-pre-click", htmlPre);

  // Limpiar XHRs previas y hacer click sobre la celda marcada
  const xhrsAntesDelClick = requests.length;
  await page.locator('[data-popup-target="1"]').first().click();
  log(`click hecho — XHRs antes=${xhrsAntesDelClick}`);
  // Esperar a que aparezca el popup (probamos varios selectores)
  await page.waitForTimeout(2500);
  await save(page, "04-post-click");

  // Snapshot HTML post-click y detectar diferencias / popup
  const htmlPost = await page.content();
  dumpHtml("05-html-post-click", htmlPost);

  // Detectar candidato a popup: elementos VISIBLES con "Último Enviado", "Vigencia:", o "Requerimiento:"
  // Filtramos por visibilidad real (rect.width>0, rect.height>0)
  const popupCandidates = await page.evaluate(() => {
    const out = [];
    const all = document.querySelectorAll("body *");
    for (const el of all) {
      const txt = (el.innerText || "").trim();
      if (!txt) continue;
      if (txt.length > 4000) continue;
      if (!/(ltimo\s+Enviado|Vigencia:\s*Desde|Requerimiento:)/i.test(txt)) continue;
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const visible = r.width > 0 && r.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      out.push({
        tag: el.tagName,
        id: el.id || null,
        cls: el.className || null,
        width: Math.round(r.width),
        height: Math.round(r.height),
        x: Math.round(r.x),
        y: Math.round(r.y),
        visible,
        zIndex: style.zIndex,
        position: style.position,
        outerHTML: el.outerHTML.slice(0, 4000),
        innerText: txt.slice(0, 1000),
      });
    }
    // Priorizar visibles, después los más chicos
    out.sort((a, b) => {
      if (a.visible !== b.visible) return a.visible ? -1 : 1;
      return a.outerHTML.length - b.outerHTML.length;
    });
    return out.slice(0, 8);
  });
  fs.writeFileSync(path.join(OUT, "06-popup-candidates.json"), JSON.stringify(popupCandidates, null, 2));
  log(`popup candidates: ${popupCandidates.length}`);
  for (const c of popupCandidates) log(`  ${c.tag}#${c.id} cls="${c.cls}" ${c.width}x${c.height} visible=${c.visible}`);

  // XHRs durante/después del click
  const xhrsNuevos = requests.slice(xhrsAntesDelClick);
  fs.writeFileSync(path.join(OUT, "07-xhrs-tras-click.json"), JSON.stringify({ requests: xhrsNuevos, responses: responses.filter(r => r.ts >= (requests[xhrsAntesDelClick]?.ts || 0)) }, null, 2));
  log(`XHRs nuevos tras click: ${xhrsNuevos.length}`);
  for (const r of xhrsNuevos) log(`  ${r.method} ${r.url}`);

  await browser.close();
  log("DONE — revisar carpeta test-popup-screenshots/");
})();
