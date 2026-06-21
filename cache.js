// Cache compartido con Bunn — vive en /opt/bunn/cache/<chatId>/.
//
// Formato canónico (heredado de /opt/bunn/scripts/_lib.js + cd-listar-*.js):
//   <chatId>/pendientes.json      → { fetched_at, data: [reqs] }
//   <chatId>/vencimientos.json    → { fetched_at, data: { items, screenshots: [{name, path}] } }
//   <chatId>/screenshots/         → JPGs referenciados por path desde vencimientos.json
//
// TTLs (mismos que Bunn):
//   pendientes:   1h
//   vencimientos: 6h
//
// Permisos: dir creado por user `claude` con ACL u:bunn:rwx + default heredado,
// para que tanto bot.js (claude) como Bunn (user bunn) puedan leer y escribir.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { resolverUserId } from './clientes.js';

const CACHE_DIR = '/opt/bunn/cache';

export const TTL_PENDIENTES = 6 * 60 * 60;       // 6h
export const TTL_VENCIMIENTOS = 48 * 60 * 60;    // 48h

function cachePath(chatId, tipo) {
  return join(CACHE_DIR, String(chatId), `${tipo}.json`);
}

function screenshotsDir(chatId) {
  return join(CACHE_DIR, String(chatId), 'screenshots');
}

// Devuelve { fetched_at, age_seconds, data } o null si no hay cache fresco.
export function readCache(chatId, tipo, ttlSeconds) {
  chatId = resolverUserId(chatId);
  const path = cachePath(chatId, tipo);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const fetchedAt = new Date(parsed.fetched_at).getTime();
    if (!fetchedAt) return null;
    const ageSeconds = Math.floor((Date.now() - fetchedAt) / 1000);
    if (ageSeconds > ttlSeconds) return null;
    return { fetched_at: parsed.fetched_at, age_seconds: ageSeconds, data: parsed.data };
  } catch {
    return null;
  }
}

export function writeCache(chatId, tipo, data) {
  chatId = resolverUserId(chatId);
  const dir = join(CACHE_DIR, String(chatId));
  mkdirSync(dir, { recursive: true });
  const payload = { fetched_at: new Date().toISOString(), data };
  // Sin mode explícito: respeta umask y NO pisa el ACL mask (compartido con bunn).
  writeFileSync(cachePath(chatId, tipo), JSON.stringify(payload, null, 2) + '\n');
}

// Borra screenshots viejos de un tipo (prefijo `<tipo>-`) antes de guardar los nuevos.
function purgeOldScreenshots(chatId, tipo) {
  const dir = screenshotsDir(chatId);
  if (!existsSync(dir)) return;
  const prefix = `${tipo}-`;
  for (const f of readdirSync(dir)) {
    if (f.startsWith(prefix)) {
      try { unlinkSync(join(dir, f)); } catch {}
    }
  }
}

// Convierte screenshots con `buffer` a archivos en disco y devuelve [{name, path}].
// Compatible con el formato que graba cd-listar-vencimientos.js de Bunn.
export function saveScreenshots(chatId, tipo, screenshots) {
  chatId = resolverUserId(chatId);
  if (!screenshots || !screenshots.length) return [];
  purgeOldScreenshots(chatId, tipo);
  const dir = screenshotsDir(chatId);
  mkdirSync(dir, { recursive: true });
  const ts = Date.now();
  return screenshots.map((ss, i) => {
    const cleanName = String(ss.nombre || `${i}.jpg`).replace(/[^a-zA-Z0-9._-]/g, '_');
    const fname = `${tipo}-${ts}-${cleanName}`;
    const path = join(dir, fname);
    writeFileSync(path, ss.buffer);  // sin mode (preserva ACL)
    return { name: ss.nombre || cleanName, path };
  });
}

// Borra todo el cache de un chatId (o solo un tipo si se pasa).
export function invalidateCache(chatId, tipo = null) {
  chatId = resolverUserId(chatId);
  const dir = join(CACHE_DIR, String(chatId));
  if (!existsSync(dir)) return 0;
  let count = 0;
  if (tipo) {
    const p = cachePath(chatId, tipo);
    if (existsSync(p)) { unlinkSync(p); count++; }
    const ssDir = screenshotsDir(chatId);
    if (existsSync(ssDir)) {
      const prefix = `${tipo}-`;
      for (const f of readdirSync(ssDir)) {
        if (f.startsWith(prefix)) { unlinkSync(join(ssDir, f)); count++; }
      }
    }
    return count;
  }
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    unlinkSync(join(dir, f)); count++;
  }
  const ssDir = screenshotsDir(chatId);
  if (existsSync(ssDir)) {
    for (const f of readdirSync(ssDir)) {
      unlinkSync(join(ssDir, f)); count++;
    }
  }
  return count;
}
