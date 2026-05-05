import fs from "fs/promises";
import path from "path";

const DIR = "./mapeos";

async function ensureDir(clienteId) {
  const dir = path.join(DIR, String(clienteId));
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function guardarMapeo(clienteId, nombre, datos) {
  const dir = await ensureDir(clienteId);
  await fs.writeFile(
    path.join(dir, `${nombre}.json`),
    JSON.stringify({ nombre, ...datos, guardadoEn: Date.now() }, null, 2)
  );
}

export async function leerMapeo(clienteId, nombre) {
  try {
    const data = JSON.parse(
      await fs.readFile(path.join(DIR, String(clienteId), `${nombre}.json`), "utf8")
    );
    const tieneImagenes =
      (data.imagenesPorBloque && Object.keys(data.imagenesPorBloque).length > 0) ||
      (Array.isArray(data.imagenes) && data.imagenes.length > 0);
    if (!tieneImagenes || !Array.isArray(data.bloques) || !data.bloques.length) return null;
    return {
      nombre: data.nombre,
      imagenes: data.imagenes || [],
      imagenesPorBloque: data.imagenesPorBloque || null,
      bloques: data.bloques,
    };
  } catch {
    return null;
  }
}

export async function listarMapeos(clienteId) {
  try {
    const files = await fs.readdir(path.join(DIR, String(clienteId)));
    return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""));
  } catch {
    return [];
  }
}

export async function leerTodosMapeos(clienteId) {
  const nombres = await listarMapeos(clienteId);
  const refs = [];
  for (const nombre of nombres) {
    const ref = await leerMapeo(clienteId, nombre);
    if (ref) refs.push(ref);
  }
  return refs;
}

export async function eliminarMapeo(clienteId, nombre) {
  try {
    await fs.unlink(path.join(DIR, String(clienteId), `${nombre}.json`));
  } catch {}
}
