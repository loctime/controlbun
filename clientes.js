import fs from "fs/promises";
import fssync from "fs";
import path from "path";

function dir() { return process.env.CLIENTES_DIR || "./clientes"; }
const PENDIENTES = process.env.PENDIENTES_FILE || "./pendientes.json";

export function slugify(nombre) {
  return String(nombre)
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // saca acentos
    .toLowerCase().trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-").replace(/^-|-$/g, "");
}

export function genLinkCode() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

export function normalizeArgWa(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("54")) return d;
  if (d.length === 10) return "549" + d;
  return d;
}

function slugDisponible(base) {
  const root = base || "cliente";
  let n = 1;
  while (true) {
    const candidato = n === 1 ? root : `${root}-${n}`;
    if (!fssync.existsSync(path.join(dir(), `${candidato}.json`))) return candidato;
    n++;
  }
}

function clienteBase(userId, nombre, extra) {
  return {
    userId, nombre,
    waPhone: null, telegramChatId: null, linkCode: null,
    cdUser: "", cdPass: "", diasPersonal: 10, diasVehiculos: 10, diasEmpresa: 10,
    ...extra,
  };
}

async function escribir(cliente) {
  await fs.writeFile(path.join(dir(), `${cliente.userId}.json`), JSON.stringify(cliente, null, 2));
  return cliente;
}

export async function cargarCliente(telegramChatId) {
  try {
    const archivos = await fs.readdir(dir());
    for (const archivo of archivos) {
      if (!archivo.endsWith(".json") || archivo === "ejemplo.json") continue;
      const data = JSON.parse(await fs.readFile(path.join(dir(), archivo), "utf8"));
      if (data.telegramChatId != null && String(data.telegramChatId) === String(telegramChatId)) return data;
    }
  } catch {}
  return null;
}

export async function cargarClientePorUserId(userId) {
  try {
    const archivos = await fs.readdir(dir());
    for (const archivo of archivos) {
      if (!archivo.endsWith(".json") || archivo === "ejemplo.json") continue;
      const data = JSON.parse(await fs.readFile(path.join(dir(), archivo), "utf8"));
      if (String(data.userId) === String(userId)) return data;
    }
  } catch {}
  return null;
}

// Resuelve cualquier id (telegramChatId numérico o userId slug) al userId canónico.
// Idempotente: si ya es userId lo devuelve igual; si es un telegramChatId vinculado
// devuelve el userId del cliente; si no matchea nada devuelve el id tal cual.
export function resolverUserId(id) {
  const sid = String(id);
  try {
    let porTelegram = null;
    for (const archivo of fssync.readdirSync(dir())) {
      if (!archivo.endsWith(".json") || archivo === "ejemplo.json") continue;
      let data;
      try { data = JSON.parse(fssync.readFileSync(path.join(dir(), archivo), "utf8")); } catch { continue; }
      if (String(data.userId) === sid) return sid;
      if (data.telegramChatId != null && String(data.telegramChatId) === sid) porTelegram = String(data.userId);
    }
    if (porTelegram) return porTelegram;
  } catch {}
  return sid;
}

export async function registrarCliente(telegramChatId, nombre) {
  const userId = slugDisponible(slugify(nombre));
  return escribir(clienteBase(userId, nombre, { telegramChatId: String(telegramChatId) }));
}

export async function crearClienteWA(nombre, waPhone) {
  const userId = slugDisponible(slugify(nombre));
  return escribir(clienteBase(userId, nombre, { waPhone: normalizeArgWa(waPhone), linkCode: genLinkCode() }));
}

export async function actualizarCliente(telegramChatId, datos) {
  const cliente = await cargarCliente(telegramChatId);
  if (!cliente) return null;
  return escribir({ ...cliente, ...datos });
}

export async function cargarClientePorLinkCode(code) {
  if (!code) return null;
  try {
    const archivos = await fs.readdir(dir());
    for (const archivo of archivos) {
      if (!archivo.endsWith(".json") || archivo === "ejemplo.json") continue;
      const data = JSON.parse(await fs.readFile(path.join(dir(), archivo), "utf8"));
      if (data.linkCode && String(data.linkCode) === String(code)) return data;
    }
  } catch {}
  return null;
}

export async function vincularTelegram(code, telegramChatId) {
  const cliente = await cargarClientePorLinkCode(code);
  if (!cliente) return null;
  if (cliente.telegramChatId != null) return null; // ya vinculado
  return escribir({ ...cliente, telegramChatId: String(telegramChatId), linkCode: null });
}

export async function setWaPhone(userId, waPhone) {
  const cliente = await cargarClientePorUserId(userId);
  if (!cliente) return null;
  return escribir({ ...cliente, waPhone: normalizeArgWa(waPhone) });
}

export async function setCdCreds(userId, { cdUser, cdPass, nombreEmpresa } = {}) {
  const cliente = await cargarClientePorUserId(userId);
  if (!cliente) return null;
  const patch = { cdUser, cdPass };
  if (nombreEmpresa) patch.nombreEmpresa = nombreEmpresa;
  return escribir({ ...cliente, ...patch });
}

export async function listarTodosClientes() {
  try {
    const archivos = await fs.readdir(dir());
    const clientes = [];
    for (const archivo of archivos) {
      if (!archivo.endsWith(".json") || archivo === "ejemplo.json") continue;
      try { clientes.push(JSON.parse(await fs.readFile(path.join(dir(), archivo), "utf8"))); } catch {}
    }
    return clientes;
  } catch { return []; }
}

export async function cargarPendientes() {
  try { return JSON.parse(await fs.readFile(PENDIENTES, "utf8")); } catch { return {}; }
}

export async function guardarPendiente(codigo, nombre) {
  const pendientes = await cargarPendientes();
  pendientes[codigo] = { nombre };
  await fs.writeFile(PENDIENTES, JSON.stringify(pendientes, null, 2));
}

export async function consumirPendiente(codigo) {
  const pendientes = await cargarPendientes();
  const entrada = pendientes[codigo];
  if (!entrada) return null;
  delete pendientes[codigo];
  await fs.writeFile(PENDIENTES, JSON.stringify(pendientes, null, 2));
  return entrada;
}
