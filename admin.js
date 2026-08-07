import crypto from "node:crypto";

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
