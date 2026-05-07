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

export async function leerMapeoBruto(clienteId, nombre) {
  try {
    return JSON.parse(await fs.readFile(path.join(DIR, String(clienteId), `${nombre}.json`), "utf8"));
  } catch {
    return null;
  }
}

// Lee todos los mapeos en el formato nuevo del bot (por tipo de requerimiento).
// Devuelve [{ nombre, paginas: [{ num, imagen, texto }] }]
const _baseNombreMapeo = (s) => String(s || "").replace(/-\d{4}-\d+$/i, "").trim().toLowerCase();

export async function guardarTipoMapeo(clienteId, nombreBase, tipo) {
  const nombres = await listarMapeos(clienteId);
  for (const nombre of nombres) {
    if (_baseNombreMapeo(nombre) === _baseNombreMapeo(nombreBase)) {
      const filePath = path.join(DIR, String(clienteId), `${nombre}.json`);
      try {
        const data = JSON.parse(await fs.readFile(filePath, "utf8"));
        data.tipo = tipo;
        await fs.writeFile(filePath, JSON.stringify(data, null, 2));
      } catch {}
      return;
    }
  }
}

export async function leerTipoMapeo(clienteId, nombreBase) {
  const nombres = await listarMapeos(clienteId);
  for (const nombre of nombres) {
    if (_baseNombreMapeo(nombre) === _baseNombreMapeo(nombreBase)) {
      try {
        const data = JSON.parse(await fs.readFile(path.join(DIR, String(clienteId), `${nombre}.json`), "utf8"));
        return data.tipo || null;
      } catch {}
    }
  }
  return null;
}

export async function leerTodosMapeosPorTipo(clienteId) {
  const nombres = await listarMapeos(clienteId);
  const resultado = [];
  for (const nombre of nombres) {
    try {
      const data = JSON.parse(
        await fs.readFile(path.join(DIR, String(clienteId), `${nombre}.json`), "utf8")
      );
      if (Array.isArray(data.paginas) && data.paginas.length > 0 && data.paginas[0]?.imagen) {
        resultado.push({
          nombre: data.nombre || nombre,
          paginas: data.paginas,
        });
      }
    } catch {}
  }
  return resultado;
}
