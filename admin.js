import crypto from "node:crypto";
import fs from "node:fs/promises";
import {
  getClientIp, checkLoginRateLimit, recordFailedLogin, clearLoginAttempts,
  parseCookies, readBody, sendJson,
} from "./web.js";

// ── Passwords (scrypt, sin dependencias nuevas) ─────────────────────────────
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  try {
    const hashBuffer = Buffer.from(hash, "hex");
    const testHash = crypto.scryptSync(String(password), salt, 64);
    if (hashBuffer.length !== testHash.length) return false;
    return crypto.timingSafeEqual(hashBuffer, testHash);
  } catch {
    return false;
  }
}

// ── Credenciales admin (2 cuentas fijas, en .env como JSON) ────────────────
function leerAdminCredentials() {
  try {
    const parsed = JSON.parse(process.env.ADMIN_CREDENTIALS || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function checkAdminCredentials(user, password) {
  const cuenta = leerAdminCredentials().find((c) => c.user === user);
  if (!cuenta) return false;
  return verifyPassword(password, cuenta.passHash);
}

// ── Sesiones admin (en memoria, separadas de las sesiones de cliente) ──────
const adminSessions = new Map(); // sid -> { user, expires }
const ADMIN_SESSION_MS = 24 * 60 * 60 * 1000;

export function createAdminSession(user) {
  const sid = crypto.randomBytes(32).toString("hex");
  adminSessions.set(sid, { user, expires: Date.now() + ADMIN_SESSION_MS });
  return sid;
}

export function getAdminUser(sid) {
  if (!sid) return null;
  const s = adminSessions.get(sid);
  if (!s || s.expires < Date.now()) {
    adminSessions.delete(sid);
    return null;
  }
  return s.user;
}

export function destroyAdminSession(sid) {
  adminSessions.delete(sid);
}

// ── Errores con código, para mapear a status HTTP en el router ─────────────
export class AdminError extends Error {
  constructor(message, code = "bad_request") {
    super(message);
    this.code = code;
  }
}

// ── Capacidades (registro JSON de clientes y sus sistemas autorizados) ──────
export const SISTEMAS_VALIDOS = ["bunn", "redes", "entrevista"];

function capacidadesPath() {
  return process.env.CAPACIDADES_PATH || "/opt/cazador/config-state/capacidades.json";
}

export async function leerCapacidades() {
  try {
    return JSON.parse(await fs.readFile(capacidadesPath(), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw new Error(`capacidades.json ilegible: ${e.message}`);
  }
}

export async function escribirCapacidades(reg) {
  await fs.writeFile(capacidadesPath(), JSON.stringify(reg, null, 2));
}

// ── Estado de trial (cálculo de vigencia y días restantes) ───────────────────
export function trialEstadoDe(trialUntil) {
  if (!trialUntil) return { estado: "permanente", dias: null };
  const t = Date.parse(trialUntil);
  if (Number.isNaN(t)) return { estado: "permanente", dias: null };
  const dias = Math.ceil((t - Date.now()) / 86400000);
  return { estado: dias < 0 ? "vencido" : "vigente", dias };
}

// ── Listado cruzado (clientes + capacidades) ───────────────────────────────
import {
  listarTodosClientes, normalizeArgWa,
  crearClienteWA, actualizarClientePorUserId, cargarClientePorUserId, eliminarCliente,
} from "./clientes.js";

export async function listarClientesCruzado() {
  const clientes = await listarTodosClientes();
  const capacidades = await leerCapacidades();

  const porTelefono = new Map();
  for (const c of clientes) {
    const tel = normalizeArgWa(c.waPhone);
    if (tel) porTelefono.set(tel, c);
  }

  const telefonos = new Set([...porTelefono.keys(), ...Object.keys(capacidades)]);
  const resultado = [];
  for (const tel of telefonos) {
    const cliente = porTelefono.get(tel) || null;
    const cap = capacidades[tel] || null;
    resultado.push({
      userId: cliente ? cliente.userId : null,
      nombre: (cliente && cliente.nombre) || (cap && cap.nombre) || null,
      waPhone: tel,
      sistemas: (cap && cap.sistemas) || [],
      trialUntil: cliente ? (cliente.trialUntil ?? null) : null,
      trialEstado: cliente ? trialEstadoDe(cliente.trialUntil) : null,
      cdConfigurado: !!(cliente && cliente.cdUser),
      inconsistente: !cliente || !cap,
    });
  }
  return resultado;
}

// ── Alta, edición y baja de cliente (escriben en clientes/ y capacidades.json) ─
export async function altaCliente({ nombre, waPhone, sistemas, trialUntil }) {
  if (!nombre || !waPhone) throw new AdminError("Falta nombre o waPhone", "bad_request");
  const telNorm = normalizeArgWa(waPhone);
  const existentes = await listarTodosClientes();
  if (existentes.some((c) => normalizeArgWa(c.waPhone) === telNorm)) {
    throw new AdminError("Ese número ya pertenece a otro cliente", "duplicado");
  }
  const sistemasValidos = (sistemas || []).filter((s) => SISTEMAS_VALIDOS.includes(s));
  const cliente = await crearClienteWA(nombre, waPhone);
  if (trialUntil) await actualizarClientePorUserId(cliente.userId, { trialUntil });

  try {
    const cap = await leerCapacidades();
    cap[telNorm] = { nombre, sistemas: sistemasValidos };
    await escribirCapacidades(cap);
  } catch (e) {
    return { ok: true, userId: cliente.userId, warning: `Cliente creado pero no se pudo actualizar capacidades.json: ${e.message}` };
  }
  return { ok: true, userId: cliente.userId };
}

export async function editarCliente(userId, { nombre, sistemas, trialUntil } = {}) {
  const cliente = await cargarClientePorUserId(userId);
  if (!cliente) throw new AdminError("Cliente no encontrado", "not_found");

  const patch = {};
  if (nombre !== undefined) patch.nombre = nombre;
  if (trialUntil !== undefined) patch.trialUntil = trialUntil;
  if (Object.keys(patch).length) await actualizarClientePorUserId(userId, patch);

  if (sistemas !== undefined) {
    const telNorm = normalizeArgWa(cliente.waPhone);
    const sistemasValidos = sistemas.filter((s) => SISTEMAS_VALIDOS.includes(s));
    try {
      const cap = await leerCapacidades();
      cap[telNorm] = { nombre: nombre || cliente.nombre, sistemas: sistemasValidos };
      await escribirCapacidades(cap);
    } catch (e) {
      return { ok: true, warning: `Cliente actualizado pero no se pudo actualizar capacidades.json: ${e.message}` };
    }
  }
  return { ok: true };
}

export async function bajaCliente(userId) {
  const cliente = await cargarClientePorUserId(userId);
  if (!cliente) throw new AdminError("Cliente no encontrado", "not_found");
  const telNorm = normalizeArgWa(cliente.waPhone);
  const movido = await eliminarCliente(userId);

  try {
    const cap = await leerCapacidades();
    if (telNorm && cap[telNorm]) {
      delete cap[telNorm];
      await escribirCapacidades(cap);
    }
  } catch (e) {
    return { ok: true, movidoA: movido.movidoA, warning: `Cliente dado de baja pero no se pudo limpiar capacidades.json: ${e.message}` };
  }
  return { ok: true, movidoA: movido.movidoA };
}

// ── Router HTTP /admin/api/* ────────────────────────────────────────────────
const ADMIN_ERROR_STATUS = { bad_request: 400, not_found: 404, duplicado: 409 };

function getAdminSessionUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  return getAdminUser(cookies["admin_session"] || null);
}

export async function handleAdmin(req, res, pathname, method) {
  // GET /admin — shell de la SPA (login vive del lado del cliente)
  if (pathname === "/admin" && method === "GET") {
    const fs2 = await import("node:fs/promises");
    const path2 = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname2 = path2.dirname(fileURLToPath(import.meta.url));
    const html = await fs2.readFile(path2.join(__dirname2, "public", "admin.html"), "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (!pathname.startsWith("/admin/api/")) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  // POST /admin/api/login
  if (pathname === "/admin/api/login" && method === "POST") {
    const ip = getClientIp(req);
    const rate = checkLoginRateLimit(ip);
    if (rate.blocked) { sendJson(res, { error: `Demasiados intentos. Probá en ${rate.retryAfter} minutos.` }, 429); return; }
    const body = await readBody(req);
    const { user, password } = JSON.parse(body.toString("utf8") || "{}");
    if (!user || !password || !checkAdminCredentials(user, password)) {
      recordFailedLogin(ip);
      sendJson(res, { error: "Usuario o contraseña incorrectos" }, 401);
      return;
    }
    clearLoginAttempts(ip);
    const sid = createAdminSession(user);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": `admin_session=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
    });
    res.end(JSON.stringify({ ok: true, user }));
    return;
  }

  // POST /admin/api/logout
  if (pathname === "/admin/api/logout" && method === "POST") {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies["admin_session"]) destroyAdminSession(cookies["admin_session"]);
    res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "admin_session=; Path=/; Max-Age=0" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // GET /admin/api/me
  if (pathname === "/admin/api/me" && method === "GET") {
    const user = getAdminSessionUser(req);
    if (!user) { sendJson(res, { error: "No autorizado" }, 401); return; }
    sendJson(res, { user });
    return;
  }

  // Todo lo demás requiere sesión admin
  const user = getAdminSessionUser(req);
  if (!user) { sendJson(res, { error: "No autorizado" }, 401); return; }

  // GET /admin/api/clientes
  if (pathname === "/admin/api/clientes" && method === "GET") {
    sendJson(res, await listarClientesCruzado());
    return;
  }

  // POST /admin/api/clientes
  if (pathname === "/admin/api/clientes" && method === "POST") {
    try {
      const body = await readBody(req);
      const r = await altaCliente(JSON.parse(body.toString("utf8") || "{}"));
      sendJson(res, r, 201);
    } catch (e) {
      sendJson(res, { error: e.message }, ADMIN_ERROR_STATUS[e.code] || 500);
    }
    return;
  }

  // PATCH /admin/api/clientes/:userId
  const patchMatch = pathname.match(/^\/admin\/api\/clientes\/([^/]+)$/);
  if (patchMatch && method === "PATCH") {
    try {
      const body = await readBody(req);
      const r = await editarCliente(decodeURIComponent(patchMatch[1]), JSON.parse(body.toString("utf8") || "{}"));
      sendJson(res, r);
    } catch (e) {
      sendJson(res, { error: e.message }, ADMIN_ERROR_STATUS[e.code] || 500);
    }
    return;
  }

  // DELETE /admin/api/clientes/:userId
  if (patchMatch && method === "DELETE") {
    try {
      const r = await bajaCliente(decodeURIComponent(patchMatch[1]));
      sendJson(res, r);
    } catch (e) {
      sendJson(res, { error: e.message }, ADMIN_ERROR_STATUS[e.code] || 500);
    }
    return;
  }

  sendJson(res, { error: "Not found" }, 404);
}
