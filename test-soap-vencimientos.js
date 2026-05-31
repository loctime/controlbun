/**
 * test-soap-vencimientos.js — Valida approach 3:
 *  llamar directamente el endpoint SOAP getDocumentoUltimoEstado por cada celda LRSopen
 *  de la vista Personal, y reportar cuáles tienen "Último Enviado" diferente al "Source"
 *  (esos son los falsos positivos del calendario que estamos cazando).
 *
 * Uso: node test-soap-vencimientos.js
 */
import { chromium } from "playwright";
import fs from "fs";

const CD_URL = "https://controldocumentario.com";
const CLIENTE = JSON.parse(fs.readFileSync("./clientes/fernando-vidal.json", "utf8"));
const log = (...a) => console.log("[SOAP]", ...a);

function parseSoap(xml, field) {
  const m = xml.match(new RegExp(`<${field}[^>]*>([^<]*)</${field}>`));
  return m ? m[1] : null;
}
function parseDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}
function fmtDate(d) {
  if (!d) return "";
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Login
  await page.goto(`${CD_URL}/Login.aspx`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.locator('input:not([type="password"]):not([type="hidden"]):visible').first().fill(CLIENTE.cdUser);
  await page.locator('input[type="password"]:visible').first().fill(CLIENTE.cdPass);
  const wait1 = page.waitForURL((u) => !u.href.toLowerCase().includes("login"), { timeout: 60000 });
  await page.locator('button, input[type="submit"], input[type="button"]').filter({ hasText: /ingresar/i }).first().click();
  await wait1.catch(() => {});
  log("logged");

  await page.goto(`${CD_URL}/Vencimientos.aspx?menu=11`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  // Seleccionar Personal y buscar
  const navSel = page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.evaluate(() => {
    function norm(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim(); }
    for (const s of document.querySelectorAll("select")) {
      const opts = Array.from(s.options || []);
      const obj = opts.find(o => norm(o.text) === "personal");
      if (!obj) continue;
      s.value = obj.value;
      s.dispatchEvent(new Event("change", { bubbles: true }));
      try { if (typeof s.onchange === "function") s.onchange(); } catch {}
      return;
    }
  });
  await navSel;
  await page.waitForTimeout(5000);

  const esperarBarra = async () => {
    try {
      await page.waitForFunction(() => {
        const b = document.getElementById("divBarraProgreso");
        if (!b) return true;
        const s = window.getComputedStyle(b);
        return s.display === "none" || s.visibility === "hidden";
      }, null, { timeout: 15000 });
    } catch {}
  };
  await esperarBarra();

  const nav2 = page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.locator("#ctl00_ContentPlaceHolderMain_btBuscar").click();
  await nav2;
  await esperarBarra();
  await page.waitForFunction(() => {
    function isFecha(t) { return /^\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}$/.test(String(t || "").trim()); }
    for (const t of document.querySelectorAll("table")) {
      if (t.querySelector("table")) continue;
      if (t.offsetParent === null) continue;
      for (const td of t.querySelectorAll("td")) { if (isFecha(td.textContent)) return true; }
    }
    return false;
  }, null, { timeout: 15000 }).catch(() => {});

  // Extraer hCodigo + todas las celdas LRSopen con su contexto
  const datos = await page.evaluate(() => {
    function isFecha(t) { return /^\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}$/.test(String(t || "").trim()); }
    const hCodigo = document.getElementById("ctl00_ContentPlaceHolderMain_hfHCodigo")?.value || null;

    const celdas = [];
    for (const t of document.querySelectorAll("table")) {
      if (t.querySelector("table")) continue;
      if (t.offsetParent === null) continue;
      const headers = Array.from(t.querySelectorAll("th")).map(th => (th.textContent || "").trim());
      for (const tr of t.querySelectorAll("tr")) {
        const tds = Array.from(tr.querySelectorAll("td"));
        if (!tds.length) continue;
        const nombre = tds[1] ? (tds[1].textContent || "").trim() : "";
        for (let i = 0; i < tds.length; i++) {
          const oc = tds[i].getAttribute("onclick") || "";
          const m = oc.match(/LRSopen\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/);
          if (!m) continue;
          const txt = (tds[i].textContent || "").trim();
          celdas.push({
            nombre,
            columna: headers[i] || "",
            fechaCelda: isFecha(txt) ? txt : "",
            textoCelda: txt,
            idRequerimiento: m[1],
            codigoDocumento: m[2],
          });
        }
      }
    }
    return { hCodigo, celdas };
  });
  log(`hCodigo: ${datos.hCodigo}`);
  log(`celdas LRSopen encontradas: ${datos.celdas.length}`);

  if (!datos.hCodigo) { log("ABORT: no hCodigo"); await browser.close(); return; }

  // Llamar SOAP por cada celda (desde el contexto de la página para reusar cookies)
  const llamarSoap = async (req, doc) => {
    return await page.evaluate(async ({ hCodigo, req, doc }) => {
      const body = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <getDocumentoUltimoEstado xmlns="http://tempuri.org/">
      <hCodigo>${hCodigo}</hCodigo>
      <idRequerimiento>${req}</idRequerimiento>
      <codigoDocumento>${doc}</codigoDocumento>
    </getDocumentoUltimoEstado>
  </soap:Body>
</soap:Envelope>`;
      const r = await fetch("/Services/ClienteWS.asmx", {
        method: "POST",
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          "SOAPAction": "http://tempuri.org/getDocumentoUltimoEstado",
        },
        body,
      });
      return { status: r.status, text: await r.text() };
    }, { hCodigo: datos.hCodigo, req, doc });
  };

  const desfasados = [];
  let llamadas = 0;
  for (const c of datos.celdas) {
    llamadas++;
    const res = await llamarSoap(c.idRequerimiento, c.codigoDocumento);
    if (res.status !== 200) { log(`  ${c.nombre} / ${c.columna} → HTTP ${res.status}`); continue; }
    const idSource = parseSoap(res.text, "IdRequerimientoSource");
    const idLast = parseSoap(res.text, "IdRequerimientoLast");
    const vHastaSource = parseDate(parseSoap(res.text, "VigenciaHastaSource"));
    const vHastaLast = parseDate(parseSoap(res.text, "VigenciaHastaLast"));
    const sourceMismoQueLast = idSource && idLast && idSource === idLast;

    if (!sourceMismoQueLast) {
      desfasados.push({
        nombre: c.nombre,
        columna: c.columna,
        fechaEnCelda: c.fechaCelda,
        idSource, vHastaSource: fmtDate(vHastaSource),
        idLast,   vHastaLast:   fmtDate(vHastaLast),
      });
    }
  }
  log(`\n=== ${llamadas} llamadas, ${desfasados.length} celdas con Last != Source (calendario desactualizado) ===`);
  for (const d of desfasados) {
    log(`  ${d.nombre} | ${d.columna}: celda=${d.fechaEnCelda} | source(${d.idSource}) hasta ${d.vHastaSource} → last(${d.idLast}) hasta ${d.vHastaLast}`);
  }
  fs.writeFileSync("./test-popup-screenshots/08-desfasados.json", JSON.stringify(desfasados, null, 2));

  await browser.close();
  log("DONE");
})();
