import http from "http";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { leerTodosMapeosPorTipo, leerMapeoBruto, eliminarMapeo, guardarMapeo } from "./mapeos.js";
import { cargarCliente } from "./clientes.js";
import { pdfAImagenes } from "./pdf.js";
import { cdObtenerSesionActiva, cdLeerTiposRequerimientos } from "./cd.js";

async function buscarClientesPorCredenciales(cdUser, cdPass) {
  const matches = [];
  try {
    const archivos = await fs.readdir("./clientes");
    for (const archivo of archivos) {
      if (!archivo.endsWith(".json") || archivo === "ejemplo.json") continue;
      const data = JSON.parse(await fs.readFile(path.join("./clientes", archivo), "utf8"));
      if (data.cdUser === cdUser && data.cdPass === cdPass) matches.push(data);
    }
  } catch {}
  return matches;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// token → { chatId, expires }
const tokens = new Map();
// sessionId → { chatId, expires }
const sessions = new Map();

// Rate limiting en login: ip → { count, blockedUntil }
const loginAttempts = new Map();
const MAX_LOGIN_ATTEMPTS = 6;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;

function getClientIp(req) {
  return (
    req.headers["cf-connecting-ip"] ||
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.socket.remoteAddress
  );
}

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) return { blocked: false };
  if (entry.blockedUntil > now) {
    return { blocked: true, retryAfter: Math.ceil((entry.blockedUntil - now) / 60000) };
  }
  if (entry.blockedUntil > 0) loginAttempts.delete(ip);
  return { blocked: false };
}

function recordFailedLogin(ip) {
  const entry = loginAttempts.get(ip) || { count: 0, blockedUntil: 0 };
  entry.count++;
  if (entry.count >= MAX_LOGIN_ATTEMPTS) entry.blockedUntil = Date.now() + LOGIN_BLOCK_MS;
  loginAttempts.set(ip, entry);
}

function clearLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

const PORT = Number(process.env.WEB_PORT) || 3100;

export function generarTokenWeb(chatId) {
  for (const [tok, val] of tokens) {
    if (val.chatId === chatId) tokens.delete(tok);
  }
  const token = crypto.randomBytes(24).toString("hex");
  tokens.set(token, { chatId, expires: Date.now() + 10 * 60 * 1000 });
  return token;
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header.split(";").flatMap((c) => {
      const [k, ...v] = c.trim().split("=");
      return k ? [[decodeURIComponent(k.trim()), decodeURIComponent(v.join("=").trim())]] : [];
    })
  );
}

function getChatId(req) {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies["session"];
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session || session.expires < Date.now()) {
    sessions.delete(sid);
    return null;
  }
  return session.chatId;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

const EXPIRED_PAGE = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>Link expirado — ControlBun</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Crimson+Pro:wght@400;600&family=DM+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'DM Sans',sans-serif;background:#EDE8DF;color:#1C2228;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:32px}.card{background:#FAF8F4;border:1px solid #D8D2C6;border-radius:16px;padding:48px 40px;max-width:400px;box-shadow:0 4px 16px rgba(28,34,40,.1)}.num{font-family:'Crimson Pro',serif;font-size:96px;font-weight:600;line-height:1;color:#D8D2C6;letter-spacing:-0.04em}.title{font-family:'Crimson Pro',serif;font-size:28px;font-weight:600;margin:12px 0 10px}.text{font-size:14px;color:#666;line-height:1.6}code{background:#EDE8DF;padding:2px 6px;border-radius:4px;font-size:13px}</style>
</head><body><div class="card"><div class="num">401</div><h1 class="title">Sesión expirada</h1><p class="text">Pedí un nuevo link enviando <code>/web</code> en el chat de Telegram.</p></div></body></html>`;

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const method = req.method;

  // ── Token exchange ──────────────────────────────────────────────────────────
  if (p === "/auth" && method === "GET") {
    const token = url.searchParams.get("t");
    const entry = token ? tokens.get(token) : null;
    if (!entry || entry.expires < Date.now()) {
      tokens.delete(token);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(EXPIRED_PAGE);
      return;
    }
    tokens.delete(token);
    const sid = crypto.randomBytes(32).toString("hex");
    sessions.set(sid, { chatId: entry.chatId, expires: Date.now() + 24 * 60 * 60 * 1000 });
    res.writeHead(302, {
      Location: "/",
      "Set-Cookie": `session=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
    });
    res.end();
    return;
  }

  // ── Serve app shell ─────────────────────────────────────────────────────────
  if (p === "/" && method === "GET") {
    const html = await fs.readFile(path.join(__dirname, "public", "app.html"), "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  // ── API ─────────────────────────────────────────────────────────────────────
  if (p.startsWith("/api/")) {

    // POST /api/login — autenticación por credenciales de CD (no requiere sesión previa)
    if (p === "/api/login" && method === "POST") {
      const ip = getClientIp(req);
      const rateCheck = checkLoginRateLimit(ip);
      if (rateCheck.blocked) {
        sendJson(res, { error: `Demasiados intentos. Intentá de nuevo en ${rateCheck.retryAfter} minutos.` }, 429);
        return;
      }
      const body = await readBody(req);
      const { cdUser, cdPass } = JSON.parse(body.toString("utf8"));
      if (!cdUser || !cdPass) { sendJson(res, { error: "Faltan credenciales" }, 400); return; }
      const clientes = await buscarClientesPorCredenciales(cdUser.trim(), cdPass);
      if (!clientes.length) {
        recordFailedLogin(ip);
        sendJson(res, { error: "Credenciales incorrectas" }, 401);
        return;
      }
      clearLoginAttempts(ip);
      if (clientes.length > 1) {
        sendJson(res, { ambiguous: true, opciones: clientes.map(c => ({ chatId: String(c.telegramChatId), nombre: c.nombre })) });
        return;
      }
      const cliente = clientes[0];
      if (!cliente.telegramChatId) { sendJson(res, { error: "Este cliente todavía no tiene Telegram vinculado. Pedí el acceso desde Telegram con /web." }, 403); return; }
      const sid = crypto.randomBytes(32).toString("hex");
      sessions.set(sid, { chatId: String(cliente.telegramChatId), expires: Date.now() + 7 * 24 * 60 * 60 * 1000 });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": `session=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
      });
      res.end(JSON.stringify({ ok: true, nombre: cliente.nombre }));
      return;
    }

    // POST /api/login/select — elegir workspace cuando hay múltiples con las mismas credenciales
    if (p === "/api/login/select" && method === "POST") {
      const ip = getClientIp(req);
      const rateCheck = checkLoginRateLimit(ip);
      if (rateCheck.blocked) {
        sendJson(res, { error: `Demasiados intentos. Intentá de nuevo en ${rateCheck.retryAfter} minutos.` }, 429);
        return;
      }
      const body = await readBody(req);
      const { cdUser, cdPass, chatId } = JSON.parse(body.toString("utf8"));
      if (!cdUser || !cdPass || !chatId) { sendJson(res, { error: "Faltan datos" }, 400); return; }
      const clientes = await buscarClientesPorCredenciales(cdUser.trim(), cdPass);
      const cliente = clientes.find(c => String(c.telegramChatId) === String(chatId));
      if (!cliente) {
        recordFailedLogin(ip);
        sendJson(res, { error: "Credenciales incorrectas" }, 401);
        return;
      }
      clearLoginAttempts(ip);
      const sid = crypto.randomBytes(32).toString("hex");
      sessions.set(sid, { chatId: String(cliente.telegramChatId), expires: Date.now() + 7 * 24 * 60 * 60 * 1000 });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": `session=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
      });
      res.end(JSON.stringify({ ok: true, nombre: cliente.nombre }));
      return;
    }

    const chatId = getChatId(req);
    if (!chatId) { sendJson(res, { error: "No autorizado" }, 401); return; }

    // GET /api/me
    if (p === "/api/me" && method === "GET") {
      const cliente = await cargarCliente(chatId);
      sendJson(res, { chatId, nombre: cliente?.nombre || "Usuario" });
      return;
    }


    // GET /api/requirements
    if (p === "/api/requirements" && method === "GET") {
      const reqFile = path.join("mapeos", chatId, "_requirements.json");
      try {
        const data = JSON.parse(await fs.readFile(reqFile, "utf8"));
        sendJson(res, data);
      } catch {
        sendJson(res, { tipos: [], timestamp: null });
      }
      return;
    }

    // POST /api/requirements/refresh
    if (p === "/api/requirements/refresh" && method === "POST") {
      const cliente = await cargarCliente(chatId);
      if (!cliente?.cdUser || !cliente?.cdPass) {
        sendJson(res, { error: "Credenciales no configuradas" }, 400);
        return;
      }
      try {
        const sesion = await cdObtenerSesionActiva(chatId, cliente.cdUser, cliente.cdPass);
        if (!sesion.ok) {
          sendJson(res, { error: `Login fallido: ${sesion.motivo || "credenciales inválidas"}` }, 401);
          return;
        }
        const tipos = await cdLeerTiposRequerimientos(sesion.page);
        const data = { tipos, timestamp: Date.now() };
        await fs.mkdir(path.join("mapeos", chatId), { recursive: true });
        await fs.writeFile(path.join("mapeos", chatId, "_requirements.json"), JSON.stringify(data, null, 2));
        sendJson(res, data);
      } catch (e) {
        sendJson(res, { error: `Error al obtener requerimientos: ${e.message}` }, 500);
      }
      return;
    }

    // POST /api/pdf/render
    if (p === "/api/pdf/render" && method === "POST") {
      const body = await readBody(req);
      const imagenes = await pdfAImagenes(body);
      sendJson(res, { paginas: imagenes.map((i) => ({ num: i.pagina, imagen: i.base64 })) });
      return;
    }

    // GET /api/mapeos
    if (p === "/api/mapeos" && method === "GET") {
      const mapeos = await leerTodosMapeosPorTipo(chatId);
      sendJson(res, mapeos.map((m) => ({ nombre: m.nombre, paginas: m.paginas.length, guardadoEn: m.guardadoEn })));
      return;
    }

    // GET /api/mapeo/:nombre/pages — páginas con base64 (para editor)
    const pagesMatch = p.match(/^\/api\/mapeo\/(.+?)\/pages$/);
    if (pagesMatch && method === "GET") {
      const nombre = path.basename(decodeURIComponent(pagesMatch[1]));
      const bruto = await leerMapeoBruto(chatId, nombre);
      if (!bruto) { res.writeHead(404); res.end(); return; }
      sendJson(res, { paginas: (bruto.paginas || []).map((pg, i) => ({ num: i + 1, imagen: pg.imagen })) });
      return;
    }

    // GET /api/mapeo/:nombre/img/:idx
    const imgMatch = p.match(/^\/api\/mapeo\/(.+?)\/img\/(\d+)$/);
    if (imgMatch && method === "GET") {
      const nombre = path.basename(decodeURIComponent(imgMatch[1]));
      const idx = parseInt(imgMatch[2]);
      const bruto = await leerMapeoBruto(chatId, nombre);
      const img = bruto?.paginas?.[idx]?.imagen;
      if (!img) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=3600" });
      res.end(Buffer.from(img, "base64"));
      return;
    }

    // POST /api/mapeo/:nombre/upload
    const uploadMatch = p.match(/^\/api\/mapeo\/(.+?)\/upload$/);
    if (uploadMatch && method === "POST") {
      const nombre = path.basename(decodeURIComponent(uploadMatch[1]));
      const body = await readBody(req);
      const imagenes = await pdfAImagenes(body);
      sendJson(res, { paginas: imagenes.map((i) => ({ num: i.pagina, imagen: i.base64 })) });
      return;
    }

    // PATCH /api/mapeo/:nombre  — save new reference pages
    if (method === "PATCH" && p.match(/^\/api\/mapeo\/[^/]+$/)) {
      const nombre = path.basename(decodeURIComponent(p.slice("/api/mapeo/".length)));
      const body = await readBody(req);
      const { paginas } = JSON.parse(body.toString("utf8"));
      const bruto = await leerMapeoBruto(chatId, nombre);
      await guardarMapeo(chatId, nombre, {
        paginas,
        href: bruto?.href || "",
        entidad: bruto?.entidad || "",
      });
      sendJson(res, { ok: true });
      return;
    }

    // DELETE /api/mapeo/:nombre
    if (method === "DELETE" && p.match(/^\/api\/mapeo\/[^/]+$/)) {
      const nombre = path.basename(decodeURIComponent(p.slice("/api/mapeo/".length)));
      await eliminarMapeo(chatId, nombre);
      sendJson(res, { ok: true });
      return;
    }

    sendJson(res, { error: "Not found" }, 404);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
}

export function startWebServer() {
  const server = http.createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (e) {
      console.error("[WEB]", e.message);
      if (!res.headersSent) { res.writeHead(500); res.end(e.message); }
    }
  });
  server.listen(PORT, () => console.log(`[WEB] http://localhost:${PORT}`));
  return server;
}
