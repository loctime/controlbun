import "dotenv/config";
import http from "http";
import { cargarCliente } from "./clientes.js";
import { readCache, writeCache, TTL_VENCIMIENTOS } from "./cache.js";
import { cdObtenerSesionActiva, cdLeerVencimientos, cdInvalidarSesion } from "./cd.js";

const PORT = Number(process.env.INTERNAL_API_PORT) || 3110;
const TOKEN = process.env.INTERNAL_API_TOKEN || "";

function hoyAR_UTCms() {
  // Argentina = UTC-3 (sin DST). Medianoche AR expresada en UTC ms.
  const ar = new Date(Date.now() - 3 * 3600 * 1000);
  return Date.UTC(ar.getUTCFullYear(), ar.getUTCMonth(), ar.getUTCDate());
}

function recomputarDiasFaltantes(items) {
  if (!Array.isArray(items)) return [];
  const hoy = hoyAR_UTCms();
  return items.map(item => {
    const mm = String(item?.fecha || "").trim().match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
    if (!mm) return item;
    let y = parseInt(mm[3], 10); if (y < 100) y += 2000;
    const f = Date.UTC(y, parseInt(mm[2], 10) - 1, parseInt(mm[1], 10));
    return { ...item, diasFaltantes: Math.round((f - hoy) / 864e5) };
  });
}

async function obtenerVencimientos(chatId) {
  const cliente = await cargarCliente(chatId);
  if (!cliente) return { ok: false, error: "cliente_no_encontrado" };
  const diasP = cliente.diasPersonal ?? 10;
  const diasV = cliente.diasVehiculos ?? 10;
  const diasE = cliente.diasEmpresa ?? 10;

  let items, fetched_at;
  const cached = readCache(chatId, "vencimientos", TTL_VENCIMIENTOS);
  if (cached) {
    items = recomputarDiasFaltantes(cached.data?.items || []);
    fetched_at = cached.fetched_at;
  } else {
    if (!cliente.cdUser || !cliente.cdPass) return { ok: false, error: "sin_credenciales" };
    const ses = await cdObtenerSesionActiva(chatId, cliente.cdUser, cliente.cdPass);
    if (!ses.ok) { cdInvalidarSesion(chatId); return { ok: false, error: "login_cd", motivo: ses.motivo }; }
    try {
      const venc = await cdLeerVencimientos(ses.page, diasP, diasV, diasE);
      items = venc.items || [];
      writeCache(chatId, "vencimientos", { items, screenshots: [] });
      fetched_at = new Date().toISOString();
    } catch (e) {
      cdInvalidarSesion(chatId);
      return { ok: false, error: "scrape_error", motivo: e.message };
    }
  }

  const proximos = items.filter(i => typeof i.diasFaltantes === "number" && i.diasFaltantes >= 0);
  const vencidos = items.filter(i => typeof i.diasFaltantes === "number" && i.diasFaltantes < 0);
  return { ok: true, fetched_at, proximos, vencidos, thresholds: { diasP, diasV, diasE } };
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  try {
    if (TOKEN && req.headers["x-internal-token"] !== TOKEN) return sendJSON(res, 401, { ok: false, error: "unauthorized" });
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (req.method === "GET" && url.pathname === "/internal/health") return sendJSON(res, 200, { ok: true });
    if (req.method === "GET" && url.pathname === "/internal/vencimientos") {
      const chatId = url.searchParams.get("chatId");
      if (!chatId) return sendJSON(res, 400, { ok: false, error: "missing_chatId" });
      const result = await obtenerVencimientos(String(chatId));
      return sendJSON(res, 200, result);
    }
    return sendJSON(res, 404, { ok: false, error: "not_found" });
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: "server_error", motivo: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`[internal-api] http://127.0.0.1:${PORT}`));
