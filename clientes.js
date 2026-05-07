import fs from "fs/promises";
import path from "path";

const DIR = "./clientes";
const PENDIENTES = "./pendientes.json";

export async function cargarCliente(chatId) {
  try {
    const archivos = await fs.readdir(DIR);
    for (const archivo of archivos) {
      if (!archivo.endsWith(".json") || archivo === "ejemplo.json") continue;
      const data = JSON.parse(await fs.readFile(path.join(DIR, archivo), "utf8"));
      if (String(data.chatId) === String(chatId)) return data;
    }
  } catch {}
  return null;
}

export async function registrarCliente(chatId, nombre) {
  const slug = nombre.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const cliente = { chatId: String(chatId), nombre, cdUser: "", cdPass: "", diasPersonal: 7, diasVehiculos: 15 };
  await fs.writeFile(path.join(DIR, `${slug}.json`), JSON.stringify(cliente, null, 2));
  return cliente;
}

export async function cargarPendientes() {
  try { return JSON.parse(await fs.readFile(PENDIENTES, "utf8")); } catch { return {}; }
}

export async function guardarPendiente(codigo, nombre) {
  const pendientes = await cargarPendientes();
  pendientes[codigo] = { nombre };
  await fs.writeFile(PENDIENTES, JSON.stringify(pendientes, null, 2));
}

export async function actualizarCliente(chatId, datos) {
  const cliente = await cargarCliente(chatId);
  if (cliente) {
    const slug = cliente.nombre.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    const actualizado = { ...cliente, ...datos };
    await fs.writeFile(path.join(DIR, `${slug}.json`), JSON.stringify(actualizado, null, 2));
    return actualizado;
  }
  // Si no existe, crear entrada mínima
  const nuevo = { chatId: String(chatId), nombre: `Usuario ${chatId}`, cdUser: "", cdPass: "", diasPersonal: 7, diasVehiculos: 15, ...datos };
  await fs.writeFile(path.join(DIR, `cliente-${chatId}.json`), JSON.stringify(nuevo, null, 2));
  return nuevo;
}

export async function listarTodosClientes() {
  try {
    const archivos = await fs.readdir(DIR);
    const clientes = [];
    for (const archivo of archivos) {
      if (!archivo.endsWith(".json") || archivo === "ejemplo.json") continue;
      try { clientes.push(JSON.parse(await fs.readFile(path.join(DIR, archivo), "utf8"))); } catch {}
    }
    return clientes;
  } catch { return []; }
}

export async function consumirPendiente(codigo) {
  const pendientes = await cargarPendientes();
  const entrada = pendientes[codigo];
  if (!entrada) return null;
  delete pendientes[codigo];
  await fs.writeFile(PENDIENTES, JSON.stringify(pendientes, null, 2));
  return entrada;
}
