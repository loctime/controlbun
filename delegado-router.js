// delegado-router.js — Capa de routing chatId → Bunn-N para soportar múltiples
// instancias de Bunn (bunn, bunn-2, ...) en paralelo, cada una con su propio
// usuario Linux, OAuth y carpeta /opt/bunn-N/delegado/.
//
// Config en /opt/controlbun/bunn-routing.json:
//   {
//     "default": "bunn-1",
//     "bunns": [
//       { "name": "bunn-1", "root": "/opt/bunn/delegado",   "tmuxSession": "bunn-agent",   "user": "bunn"   },
//       { "name": "bunn-2", "root": "/opt/bunn-2/delegado", "tmuxSession": "bunn-2-agent", "user": "bunn-2" }
//     ],
//     "mapping": { "<chatId>": "bunn-N" }
//   }
//
// Si el archivo de config no existe o no es válido, el router usa una config
// por defecto que apunta solo a Bunn-1 (compatible con el comportamiento previo).
//
// Las funciones isDelegated, enterDelegated, closeDelegated, appendInbox,
// saveUpload, readState reciben chatId y resuelven el ROOT correcto.
// findActiveDelegated() chequea SOLO el Bunn al que le tocaría este chatId.

import fs from "node:fs";
import path from "node:path";
import {
  isDelegated as _isDelegated,
  enterDelegated as _enterDelegated,
  closeDelegated as _closeDelegated,
  appendInbox as _appendInbox,
  saveUpload as _saveUpload,
  readState as _readState,
  findActiveDelegated as _findActiveDelegated,
} from "/opt/bunn/delegado/lib.mjs";

const CONFIG_PATH = "/opt/controlbun/bunn-routing.json";

const DEFAULT_CONFIG = {
  default: "bunn-1",
  bunns: [
    { name: "bunn-1", root: "/opt/bunn/delegado", tmuxSession: "bunn-agent", user: "bunn" },
  ],
  mapping: {},
};

let _config = null;
let _configMtime = 0;

function loadConfig() {
  try {
    const st = fs.statSync(CONFIG_PATH);
    if (_config && st.mtimeMs === _configMtime) return _config;
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.bunns?.length) throw new Error("config.bunns vacío");
    _config = parsed;
    _configMtime = st.mtimeMs;
    return _config;
  } catch (e) {
    if (e.code !== "ENOENT") console.warn("[router] config inválida, usando default:", e.message);
    _config = DEFAULT_CONFIG;
    _configMtime = 0;
    return _config;
  }
}

export function getBunnForChat(chatId) {
  const cfg = loadConfig();
  const name = cfg.mapping?.[String(chatId)] || cfg.default;
  const bunn = cfg.bunns.find(b => b.name === name) || cfg.bunns[0];
  return bunn;
}

export function listBunns() {
  return loadConfig().bunns.slice();
}

// ─── Helpers — operaciones sobre ROOT específico ──────────────────────────────
// lib.mjs hardcodea ROOT=/opt/bunn/delegado. Para escribir/leer en
// /opt/bunn-2/delegado/ necesitamos hacer las ops a mano sin esa lib.
// Mantenemos misma interfaz que lib.mjs.

const ENC = "utf8";

function statePath(root, chatId) { return path.join(root, "state", `${chatId}.json`); }
function inboxDir(root, chatId)  { return path.join(root, "inbox", String(chatId)); }
function uploadsDir(root, chatId){ return path.join(root, "uploads", String(chatId)); }

async function ensureDir(p) {
  await fs.promises.mkdir(p, { recursive: true });
}

async function readStateAt(root, chatId) {
  try {
    const txt = await fs.promises.readFile(statePath(root, chatId), ENC);
    return JSON.parse(txt);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

async function writeStateAt(root, chatId, state) {
  await ensureDir(path.join(root, "state"));
  await fs.promises.writeFile(statePath(root, chatId), JSON.stringify(state, null, 2));
}

async function isDelegatedAt(root, chatId) {
  const s = await readStateAt(root, chatId);
  return s?.mode === "delegated";
}

async function enterDelegatedAt(root, chatId, extra = {}) {
  const now = new Date().toISOString();
  const state = {
    mode: "delegated",
    started_at: now,
    last_activity: now,
    ...extra,
  };
  await writeStateAt(root, chatId, state);
  return state;
}

async function closeDelegatedAt(root, chatId, summary) {
  const now = new Date().toISOString();
  const s = (await readStateAt(root, chatId)) || {};
  const state = { ...s, mode: "idle", last_activity: now, closed_at: now };
  if (summary) state.summary = summary;
  await writeStateAt(root, chatId, state);
  return state;
}

async function appendInboxAt(root, chatId, msg) {
  const dir = inboxDir(root, chatId);
  await ensureDir(dir);
  const ts = Date.now();
  // n para evitar colisiones cuando llegan varios mensajes en el mismo ms
  const files = await fs.promises.readdir(dir).catch(() => []);
  const ns = files
    .filter(f => f.startsWith(`${ts}-`) && f.endsWith(".json"))
    .map(f => parseInt(f.split("-")[1], 10))
    .filter(n => !Number.isNaN(n));
  const n = (ns.length ? Math.max(...ns) : -1) + 1;
  const file = path.join(dir, `${ts}-${n}.json`);
  await fs.promises.writeFile(file, JSON.stringify({ ts, ...msg }, null, 2));
  // Toca last_activity
  const s = (await readStateAt(root, chatId)) || {};
  s.last_activity = new Date().toISOString();
  await writeStateAt(root, chatId, s);
  return file;
}

async function saveUploadAt(root, chatId, buffer, originalFilename) {
  const dir = uploadsDir(root, chatId);
  await ensureDir(dir);
  const ts = Date.now();
  const safe = (originalFilename || "doc.pdf").replace(/[^A-Za-z0-9._-]/g, "_");
  const file = path.join(dir, `${ts}-${safe}`);
  await fs.promises.writeFile(file, buffer);
  return file;
}

const STALE_MS = 15 * 60 * 1000;

async function findActiveDelegatedAt(root) {
  const dir = path.join(root, "state");
  let files;
  try {
    files = await fs.promises.readdir(dir);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  let active = null;
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const chatId = f.replace(/\.json$/, "");
    const s = await readStateAt(root, chatId).catch(() => null);
    if (!s || s.mode !== "delegated") continue;
    const last = s.last_activity ? new Date(s.last_activity).getTime() : 0;
    if (Date.now() - last > STALE_MS) {
      // Auto-cierre de huérfano
      await closeDelegatedAt(root, chatId, "auto-cerrado por stale").catch(() => {});
      continue;
    }
    if (!active || last > new Date(active.state.last_activity || 0).getTime()) {
      active = { chatId, state: s };
    }
  }
  return active;
}

// ─── API pública — wrappers que resuelven ROOT por chatId ────────────────────
// Mantiene la misma interfaz que el lib.mjs original, así bot.js cambia poco.

export async function isDelegated(chatId) {
  const bunn = getBunnForChat(chatId);
  if (bunn.root === "/opt/bunn/delegado") return _isDelegated(chatId);
  return isDelegatedAt(bunn.root, chatId);
}

export async function enterDelegated(chatId, extra) {
  const bunn = getBunnForChat(chatId);
  if (bunn.root === "/opt/bunn/delegado") return _enterDelegated(chatId, extra);
  return enterDelegatedAt(bunn.root, chatId, extra);
}

export async function closeDelegated(chatId, summary) {
  const bunn = getBunnForChat(chatId);
  if (bunn.root === "/opt/bunn/delegado") return _closeDelegated(chatId, summary);
  return closeDelegatedAt(bunn.root, chatId, summary);
}

export async function appendInbox(chatId, msg) {
  const bunn = getBunnForChat(chatId);
  if (bunn.root === "/opt/bunn/delegado") return _appendInbox(chatId, msg);
  return appendInboxAt(bunn.root, chatId, msg);
}

export async function saveUpload(chatId, buffer, originalFilename) {
  const bunn = getBunnForChat(chatId);
  if (bunn.root === "/opt/bunn/delegado") return _saveUpload(chatId, buffer, originalFilename);
  return saveUploadAt(bunn.root, chatId, buffer, originalFilename);
}

export async function readState(chatId) {
  const bunn = getBunnForChat(chatId);
  if (bunn.root === "/opt/bunn/delegado") return _readState(chatId);
  return readStateAt(bunn.root, chatId);
}

// findActiveDelegated devuelve el chat activo SOLO en el Bunn al que iría chatId.
// Sin chatId, chequea el bunn default (compatibilidad con código viejo).
export async function findActiveDelegated(chatIdHint) {
  const bunn = chatIdHint ? getBunnForChat(chatIdHint) : getBunnForChat("__default__");
  if (bunn.root === "/opt/bunn/delegado") return _findActiveDelegated();
  return findActiveDelegatedAt(bunn.root);
}
