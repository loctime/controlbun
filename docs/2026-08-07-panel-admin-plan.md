# Panel Admin de controlbun — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Panel web `/admin` dentro del proceso `controlbun` para que Diego y Fernando den de alta/baja clientes y les habiliten sistemas de Coreo, sin Telegram ni SSH manual.

**Architecture:** Nuevo módulo `admin.js` montado en el server HTTP nativo que ya expone `web.js` (mismo proceso PM2, mismo dominio `mapeos.controldoc.app`). Lee y escribe dos archivos por filesystem directo: `controlbun/clientes/*.json` (identidad+trial) y `cazador/config-state/capacidades.json` (sistemas habilitados). Auth propia de 2 cuentas fijas, separada del login de clientes.

**Tech Stack:** Node.js ESM, `node:http` nativo (sin Express), `node:crypto` (scrypt) para passwords, `node:test` para tests. Spec completo: `/opt/controlbun/docs/2026-08-07-panel-admin-design.md`.

## Global Constraints

- **No hay checkout local — todo se hace por SSH contra el VPS.** Conexión:
  `ssh -p 22022 -i ~/.ssh/vps_contabo root@5.189.136.177 "<comando>"`.
- Los archivos de `/opt/controlbun` son del user `claude`. Escribir como
  **root** (bypassa permisos), y `chown claude:claude <archivo>` en cada
  archivo nuevo que se cree.
- Para escribir un archivo multi-línea: heredoc local pipeado por stdin,
  `cat <<'EOF' | ssh -p 22022 -i ~/.ssh/vps_contabo root@5.189.136.177 "cat > /opt/controlbun/<ruta>"` — evita líos de escaping con comillas anidadas dentro de un solo `ssh "..."`.
- Correr tests: `ssh -p 22022 -i ~/.ssh/vps_contabo root@5.189.136.177 "cd /opt/controlbun && node --test test/<archivo>.test.js"`.
- Commits (mismo patrón ya usado en este repo):
  ```
  GIT_AUTHOR_NAME='diegobertosi' GIT_AUTHOR_EMAIL='diegobertosi@gmail.com' \
  GIT_COMMITTER_NAME='diegobertosi' GIT_COMMITTER_EMAIL='diegobertosi@gmail.com' \
  git commit -m '...'
  ```
- Push:
  ```
  GIT_SSH_COMMAND='ssh -i /home/claude/.ssh/deploy_controlbun -o IdentitiesOnly=yes -o StrictHostKeyChecking=no' \
  git push git@github.com:loctime/controlbun.git master
  ```
- **NO usar Express ni frameworks nuevos** — seguir el patrón `http` nativo +
  router a mano que ya usa `web.js`.
- **NO usar bcrypt/bcryptjs** — usar `node:crypto` (`scryptSync` +
  `timingSafeEqual`), cero dependencias npm nuevas.
- **NO exponer ni editar `cdUser`/`cdPass`** desde el panel — self-service
  100% del cliente por WhatsApp. El panel solo puede mostrar `cdConfigurado: true/false`.
- **NO tocar el mecanismo de alertas por Telegram** (cron de trials,
  `[EQUIPO]`) — sigue como está, el panel no lo reemplaza ni lo duplica.
- Datos: `/opt/controlbun/clientes/*.json` (identidad+trial, vía funciones
  de `clientes.js`) y `/opt/cazador/config-state/capacidades.json` (sistemas
  por número, leído/escrito directo por `admin.js` — sin importar código de
  `/opt/cazador`, son repos y procesos distintos).
- Sistemas válidos: `["bunn", "redes", "entrevista"]`.

---

### Task 1: admin.js — hashing de passwords, credenciales y sesiones

**Files:**
- Create: `/opt/controlbun/admin.js`
- Test: `/opt/controlbun/test/admin.test.js`

**Interfaces:**
- Consumes: nada (solo `node:crypto`, `process.env.ADMIN_CREDENTIALS`).
- Produces: `hashPassword(password: string): string`, `verifyPassword(password: string, stored: string): boolean`, `checkAdminCredentials(user: string, password: string): boolean`, `createAdminSession(user: string): string` (sid), `getAdminUser(sid: string|null): string|null`, `destroyAdminSession(sid: string): void`, `class AdminError extends Error { code: string }`.

- [ ] **Step 1: Escribir el archivo de test con los casos de hashing/credenciales/sesión**

```javascript
// /opt/controlbun/test/admin.test.js
import { test } from "node:test";
import assert from "node:assert";

const {
  hashPassword, verifyPassword, checkAdminCredentials,
  createAdminSession, getAdminUser, destroyAdminSession, AdminError,
} = await import("../admin.js");

test("hashPassword/verifyPassword: hash correcto verifica OK", () => {
  const stored = hashPassword("miClaveSegura123");
  assert.strictEqual(verifyPassword("miClaveSegura123", stored), true);
});

test("verifyPassword: clave incorrecta falla", () => {
  const stored = hashPassword("miClaveSegura123");
  assert.strictEqual(verifyPassword("otraClave", stored), false);
});

test("verifyPassword: stored vacío o corrupto no tira excepción", () => {
  assert.strictEqual(verifyPassword("x", ""), false);
  assert.strictEqual(verifyPassword("x", "sinseparador"), false);
  assert.strictEqual(verifyPassword("x", undefined), false);
});

test("checkAdminCredentials: usuario y password correctos", () => {
  const hash = hashPassword("passDiego");
  process.env.ADMIN_CREDENTIALS = JSON.stringify([{ user: "diego", passHash: hash }]);
  assert.strictEqual(checkAdminCredentials("diego", "passDiego"), true);
});

test("checkAdminCredentials: usuario inexistente o password mala", () => {
  const hash = hashPassword("passDiego");
  process.env.ADMIN_CREDENTIALS = JSON.stringify([{ user: "diego", passHash: hash }]);
  assert.strictEqual(checkAdminCredentials("fernando", "passDiego"), false);
  assert.strictEqual(checkAdminCredentials("diego", "mala"), false);
});

test("checkAdminCredentials: ADMIN_CREDENTIALS ausente o corrupto -> false, no tira", () => {
  process.env.ADMIN_CREDENTIALS = "";
  assert.strictEqual(checkAdminCredentials("diego", "x"), false);
  process.env.ADMIN_CREDENTIALS = "{no es json valido";
  assert.strictEqual(checkAdminCredentials("diego", "x"), false);
});

test("sesiones: crear, leer y destruir", () => {
  const sid = createAdminSession("diego");
  assert.strictEqual(typeof sid, "string");
  assert.strictEqual(getAdminUser(sid), "diego");
  destroyAdminSession(sid);
  assert.strictEqual(getAdminUser(sid), null);
});

test("sesiones: sid inexistente o null -> null", () => {
  assert.strictEqual(getAdminUser(null), null);
  assert.strictEqual(getAdminUser("no-existe"), null);
});

test("AdminError: guarda code", () => {
  const e = new AdminError("mensaje", "duplicado");
  assert.strictEqual(e.message, "mensaje");
  assert.strictEqual(e.code, "duplicado");
});
```

- [ ] **Step 2: Correr el test y verificar que falla (admin.js no existe todavía)**

Run: `ssh -p 22022 -i ~/.ssh/vps_contabo root@5.189.136.177 "cd /opt/controlbun && node --test test/admin.test.js"`
Expected: FAIL — `Cannot find module '../admin.js'`

- [ ] **Step 3: Crear admin.js con la implementación mínima**

```javascript
// /opt/controlbun/admin.js
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
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `ssh -p 22022 -i ~/.ssh/vps_contabo root@5.189.136.177 "cd /opt/controlbun && node --test test/admin.test.js"`
Expected: PASS — 9 tests, 0 fallas

- [ ] **Step 5: chown, commit**

```bash
ssh -p 22022 -i ~/.ssh/vps_contabo root@5.189.136.177 "chown claude:claude /opt/controlbun/admin.js /opt/controlbun/test/admin.test.js && cd /opt/controlbun && git add admin.js test/admin.test.js && GIT_AUTHOR_NAME='diegobertosi' GIT_AUTHOR_EMAIL='diegobertosi@gmail.com' GIT_COMMITTER_NAME='diegobertosi' GIT_COMMITTER_EMAIL='diegobertosi@gmail.com' git commit -m 'panel admin: hashing de passwords, credenciales y sesiones'"
```

---

### Task 2: admin.js — helpers de capacidades.json y estado de trial

**Files:**
- Modify: `/opt/controlbun/admin.js`
- Modify: `/opt/controlbun/test/admin.test.js`

**Interfaces:**
- Consumes: `process.env.CAPACIDADES_PATH` (default `/opt/cazador/config-state/capacidades.json`).
- Produces: `leerCapacidades(): Promise<Record<string,{nombre:string|null,sistemas:string[]}>>`, `escribirCapacidades(reg: object): Promise<void>`, `trialEstadoDe(trialUntil: string|null): {estado: "permanente"|"vigente"|"vencido", dias: number|null}`, `SISTEMAS_VALIDOS: string[]`.

- [ ] **Step 1: Agregar los tests de capacidades.json y trialEstadoDe**

```javascript
// agregar al final de /opt/controlbun/test/admin.test.js
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const {
  leerCapacidades, escribirCapacidades, trialEstadoDe, SISTEMAS_VALIDOS,
} = await import("../admin.js");

test("leerCapacidades: archivo inexistente -> objeto vacío, no tira", async () => {
  process.env.CAPACIDADES_PATH = path.join(os.tmpdir(), `cap-${Date.now()}-nope.json`);
  const reg = await leerCapacidades();
  assert.deepStrictEqual(reg, {});
});

test("leerCapacidades/escribirCapacidades: round-trip", async () => {
  const tmp = path.join(os.tmpdir(), `cap-${Date.now()}.json`);
  process.env.CAPACIDADES_PATH = tmp;
  await escribirCapacidades({ "5493364524758": { nombre: "Fernando", sistemas: ["bunn"] } });
  const reg = await leerCapacidades();
  assert.deepStrictEqual(reg, { "5493364524758": { nombre: "Fernando", sistemas: ["bunn"] } });
});

test("trialEstadoDe: null/undefined -> permanente", () => {
  assert.deepStrictEqual(trialEstadoDe(null), { estado: "permanente", dias: null });
  assert.deepStrictEqual(trialEstadoDe(undefined), { estado: "permanente", dias: null });
});

test("trialEstadoDe: fecha futura -> vigente con dias positivos", () => {
  const futuro = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const r = trialEstadoDe(futuro);
  assert.strictEqual(r.estado, "vigente");
  assert.ok(r.dias >= 4 && r.dias <= 5);
});

test("trialEstadoDe: fecha pasada -> vencido con dias negativos", () => {
  const pasado = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const r = trialEstadoDe(pasado);
  assert.strictEqual(r.estado, "vencido");
  assert.ok(r.dias < 0);
});

test("SISTEMAS_VALIDOS incluye bunn, redes, entrevista", () => {
  assert.deepStrictEqual(SISTEMAS_VALIDOS, ["bunn", "redes", "entrevista"]);
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `ssh -p 22022 -i ~/.ssh/vps_contabo root@5.189.136.177 "cd /opt/controlbun && node --test test/admin.test.js"`
Expected: FAIL — `leerCapacidades is not a function` (y similares)

- [ ] **Step 3: Agregar la implementación a admin.js**

```javascript
// agregar a /opt/controlbun/admin.js (después de los imports existentes)
import fs from "node:fs/promises";

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

export function trialEstadoDe(trialUntil) {
  if (!trialUntil) return { estado: "permanente", dias: null };
  const t = Date.parse(trialUntil);
  if (Number.isNaN(t)) return { estado: "permanente", dias: null };
  const dias = Math.ceil((t - Date.now()) / 86400000);
  return { estado: dias < 0 ? "vencido" : "vigente", dias };
}
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `ssh -p 22022 -i ~/.ssh/vps_contabo root@5.189.136.177 "cd /opt/controlbun && node --test test/admin.test.js"`
Expected: PASS — 15 tests, 0 fallas

- [ ] **Step 5: Commit**

```bash
ssh -p 22022 -i ~/.ssh/vps_contabo root@5.189.136.177 "cd /opt/controlbun && git add admin.js test/admin.test.js && GIT_AUTHOR_NAME='diegobertosi' GIT_AUTHOR_EMAIL='diegobertosi@gmail.com' GIT_COMMITTER_NAME='diegobertosi' GIT_COMMITTER_EMAIL='diegobertosi@gmail.com' git commit -m 'panel admin: helpers de capacidades.json y estado de trial'"
```

---

### Task 3: clientes.js — dar de baja (soft-delete)

**Files:**
- Modify: `/opt/controlbun/clientes.js`
- Modify: `/opt/controlbun/test/clientes.test.js`

**Interfaces:**
- Consumes: `dir()` (privado de clientes.js), convención ya existente `clientes/.deleted/<userId>.json.bak-<timestamp>`.
- Produces: `eliminarCliente(userId: string): Promise<{userId:string, movidoA:string}|null>`.

- [ ] **Step 1: Agregar el test al archivo existente**

```javascript
// agregar al final de /opt/controlbun/test/clientes.test.js
test("eliminarCliente: mueve el archivo a .deleted con timestamp, no lo borra", async () => {
  const { eliminarCliente } = await import("../clientes.js");
  const cliente = await crearClienteWA("Cliente De Prueba", "5493400000000");
  const resultado = await eliminarCliente(cliente.userId);
  assert.strictEqual(resultado.userId, cliente.userId);
  assert.ok(fs.existsSync(resultado.movidoA), "el archivo movido debe existir");
  assert.ok(resultado.movidoA.includes(path.join(TMP, ".deleted")), "debe estar dentro de .deleted");
  assert.ok(/\.json\.bak-\d{8}-\d{6}$/.test(resultado.movidoA), "debe tener el sufijo de timestamp");
  assert.strictEqual(fs.existsSync(path.join(TMP, `${cliente.userId}.json`)), false, "el original ya no debe existir en clientes/");
});

test("eliminarCliente: userId inexistente -> null, no tira", async () => {
  const { eliminarCliente } = await import("../clientes.js");
  const resultado = await eliminarCliente("no-existe-este-userid");
  assert.strictEqual(resultado, null);
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `ssh -p 22022 -i ~/.ssh/vps_contabo root@5.189.136.177 "cd /opt/controlbun && node --test test/clientes.test.js"`
Expected: FAIL — `eliminarCliente is not a function`

- [ ] **Step 3: Agregar la implementación a clientes.js**

Insertar después de la función `escribir` (que ya existe) y antes de `cargarCliente`:

```javascript
// agregar a /opt/controlbun/clientes.js
function timestampCompacto() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// Baja de cliente: mueve el archivo a .deleted/ con timestamp, nunca lo borra en seco.
export async function eliminarCliente(userId) {
  const origen = path.join(dir(), `${userId}.json`);
  if (!fssync.existsSync(origen)) return null;
  const deletedDir = path.join(dir(), ".deleted");
  await fs.mkdir(deletedDir, { recursive: true });
  const destino = path.join(deletedDir, `${userId}.json.bak-${timestampCompacto()}`);
  await fs.rename(origen, destino);
  return { userId, movidoA: destino };
}
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `ssh -p 22022 -i ~/.ssh/vps_contabo root@5.189.136.177 "cd /opt/controlbun && node --test test/clientes.test.js"`
Expected: PASS — todos los tests de clientes.test.js en verde, incluidos los 2 nuevos

- [ ] **Step 5: Commit**

```bash
ssh -p 22022 -i ~/.ssh/vps_contabo root@5.189.136.177 "cd /opt/controlbun && git add clientes.js test/clientes.test.js && GIT_AUTHOR_NAME='diegobertosi' GIT_AUTHOR_EMAIL='diegobertosi@gmail.com' GIT_COMMITTER_NAME='diegobertosi' GIT_COMMITTER_EMAIL='diegobertosi@gmail.com' git commit -m 'clientes: eliminarCliente (baja soft-delete a .deleted/)'"
```

---

### Task 4: admin.js — listado cruzado (clientes + capacidades)

**Files:**
- Modify: `/opt/controlbun/admin.js`
- Modify: `/opt/controlbun/test/admin.test.js`

**Interfaces:**
- Consumes: `listarTodosClientes()` y `normalizeArgWa()` de `clientes.js`; `leerCapacidades()` y `trialEstadoDe()` de Task 2.
- Produces: `listarClientesCruzado(): Promise<Array<{userId:string|null, nombre:string|null, waPhone:string, sistemas:string[], trialUntil:string|null, trialEstado:object|null, cdConfigurado:boolean, inconsistente:boolean}>>`.

- [ ] **Step 1: Agregar el test**

```javascript
// agregar al final de /opt/controlbun/test/admin.test.js
test("listarClientesCruzado: cruza cliente+capacidades por telefono, detecta inconsistencias", async () => {
  const clientesTmp = path.join(os.tmpdir(), `clientes-cruzado-${Date.now()}`);
  fs.mkdirSync(clientesTmp);
  process.env.CLIENTES_DIR = clientesTmp;
  const capTmp = path.join(os.tmpdir(), `cap-cruzado-${Date.now()}.json`);
  process.env.CAPACIDADES_PATH = capTmp;

  const { crearClienteWA } = await import("../clientes.js");
  const { listarClientesCruzado, escribirCapacidades } = await import("../admin.js");

  // Cliente completo: existe en clientes/ y en capacidades.json
  const completo = await crearClienteWA("Fernando Completo", "5493364524758");
  // Cliente inconsistente: existe en clientes/ pero NO en capacidades.json
  await crearClienteWA("Solo En Clientes", "5493400000001");

  await escribirCapacidades({
    "5493364524758": { nombre: "Fernando Completo", sistemas: ["bunn"] },
    // Inconsistente: existe en capacidades.json pero NO en clientes/
    "5493400000002": { nombre: "Solo En Capacidades", sistemas: ["entrevista"] },
  });

  const lista = await listarClientesCruzado();
  assert.strictEqual(lista.length, 3);

  const fernando = lista.find((c) => c.waPhone === "5493364524758");
  assert.strictEqual(fernando.userId, completo.userId);
  assert.deepStrictEqual(fernando.sistemas, ["bunn"]);
  assert.strictEqual(fernando.inconsistente, false);

  const soloClientes = lista.find((c) => c.waPhone === "5493400000001");
  assert.strictEqual(soloClientes.inconsistente, true);
  assert.deepStrictEqual(soloClientes.sistemas, []);

  const soloCapacidades = lista.find((c) => c.waPhone === "5493400000002");
  assert.strictEqual(soloCapacidades.inconsistente, true);
  assert.strictEqual(soloCapacidades.userId, null);
  assert.strictEqual(soloCapacidades.nombre, "Solo En Capacidades");
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `ssh -p 22022 -i ~/.ssh/vps_contabo root@5.189.136.177 "cd /opt/controlbun && node --test test/admin.test.js"`
Expected: FAIL — `listarClientesCruzado is not a function`

- [ ] **Step 3: Agregar la implementación a admin.js**

```javascript
// agregar a /opt/controlbun/admin.js
import { listarTodosClientes, normalizeArgWa } from "./clientes.js";

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
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `ssh -p 22022 -i ~/.ssh/vps_contabo root@5.189.136.177 "cd /opt/controlbun && node --test test/admin.test.js"`
Expected: PASS — 16 tests, 0 fallas

- [ ] **Step 5: Commit**

```bash
ssh -p 22022 -i ~/.ssh/vps_contabo root@5.189.136.177 "cd /opt/controlbun && git add admin.js test/admin.test.js && GIT_AUTHOR_NAME='diegobertosi' GIT_AUTHOR_EMAIL='diegobertosi@gmail.com' GIT_COMMITTER_NAME='diegobertosi' GIT_COMMITTER_EMAIL='diegobertosi@gmail.com' git commit -m 'panel admin: listado cruzado clientes+capacidades'"
```

---

### Task 5: admin.js — alta, edición y baja de cliente

**Files:**
- Modify: `/opt/controlbun/admin.js`
- Modify: `/opt/controlbun/test/admin.test.js`

**Interfaces:**
- Consumes: `crearClienteWA`, `actualizarClientePorUserId`, `cargarClientePorUserId`, `listarTodosClientes`, `normalizeArgWa`, `eliminarCliente` de `clientes.js`; `leerCapacidades`/`escribirCapacidades`/`SISTEMAS_VALIDOS` de Tasks 2/4; `AdminError` de Task 1.
- Produces: `altaCliente({nombre, waPhone, sistemas, trialUntil}): Promise<{ok:true, userId:string, warning?:string}>`, `editarCliente(userId, {nombre?, sistemas?, trialUntil?}): Promise<{ok:true, warning?:string}>`, `bajaCliente(userId): Promise<{ok:true, movidoA:string, warning?:string}>`.

- [ ] **Step 1: Agregar los tests**

```javascript
// agregar al final de /opt/controlbun/test/admin.test.js
function nuevoTmpDir(prefix) {
  const d = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d);
  return d;
}

test("altaCliente: crea en clientes/ y en capacidades.json", async () => {
  process.env.CLIENTES_DIR = nuevoTmpDir("clientes-alta");
  process.env.CAPACIDADES_PATH = path.join(os.tmpdir(), `cap-alta-${Date.now()}.json`);
  const { altaCliente, leerCapacidades } = await import("../admin.js");
  const { cargarClientePorUserId } = await import("../clientes.js");

  const r = await altaCliente({ nombre: "Cliente Nuevo", waPhone: "5493400000010", sistemas: ["bunn"], trialUntil: "2026-09-01" });
  assert.strictEqual(r.ok, true);
  assert.ok(r.userId);

  const cliente = await cargarClientePorUserId(r.userId);
  assert.strictEqual(cliente.waPhone, "5493400000010");
  assert.strictEqual(cliente.trialUntil, "2026-09-01");

  const cap = await leerCapacidades();
  assert.deepStrictEqual(cap["5493400000010"], { nombre: "Cliente Nuevo", sistemas: ["bunn"] });
});

test("altaCliente: waPhone duplicado -> AdminError codigo duplicado", async () => {
  process.env.CLIENTES_DIR = nuevoTmpDir("clientes-dup");
  process.env.CAPACIDADES_PATH = path.join(os.tmpdir(), `cap-dup-${Date.now()}.json`);
  const { altaCliente } = await import("../admin.js");

  await altaCliente({ nombre: "Primero", waPhone: "5493400000011", sistemas: ["bunn"] });
  await assert.rejects(
    () => altaCliente({ nombre: "Segundo", waPhone: "5493400000011", sistemas: ["bunn"] }),
    (e) => e.code === "duplicado"
  );
});

test("altaCliente: filtra sistemas invalidos", async () => {
  process.env.CLIENTES_DIR = nuevoTmpDir("clientes-sisval");
  process.env.CAPACIDADES_PATH = path.join(os.tmpdir(), `cap-sisval-${Date.now()}.json`);
  const { altaCliente, leerCapacidades } = await import("../admin.js");

  await altaCliente({ nombre: "X", waPhone: "5493400000012", sistemas: ["bunn", "sistema-inventado"] });
  const cap = await leerCapacidades();
  assert.deepStrictEqual(cap["5493400000012"].sistemas, ["bunn"]);
});

test("editarCliente: cambia sistemas y trial", async () => {
  process.env.CLIENTES_DIR = nuevoTmpDir("clientes-edit");
  process.env.CAPACIDADES_PATH = path.join(os.tmpdir(), `cap-edit-${Date.now()}.json`);
  const { altaCliente, editarCliente, leerCapacidades } = await import("../admin.js");
  const { cargarClientePorUserId } = await import("../clientes.js");

  const alta = await altaCliente({ nombre: "Editable", waPhone: "5493400000013", sistemas: ["bunn"] });
  await editarCliente(alta.userId, { sistemas: ["bunn", "redes"], trialUntil: "2026-10-01" });

  const cliente = await cargarClientePorUserId(alta.userId);
  assert.strictEqual(cliente.trialUntil, "2026-10-01");
  const cap = await leerCapacidades();
  assert.deepStrictEqual(cap["5493400000013"].sistemas, ["bunn", "redes"]);
});

test("editarCliente: userId inexistente -> AdminError not_found", async () => {
  process.env.CLIENTES_DIR = nuevoTmpDir("clientes-editnf");
  process.env.CAPACIDADES_PATH = path.join(os.tmpdir(), `cap-editnf-${Date.now()}.json`);
  const { editarCliente } = await import("../admin.js");
  await assert.rejects(
    () => editarCliente("no-existe", { sistemas: ["bunn"] }),
    (e) => e.code === "not_found"
  );
});

test("bajaCliente: mueve a .deleted y saca la entrada de capacidades.json", async () => {
  process.env.CLIENTES_DIR = nuevoTmpDir("clientes-baja");
  process.env.CAPACIDADES_PATH = path.join(os.tmpdir(), `cap-baja-${Date.now()}.json`);
  const { altaCliente, bajaCliente, leerCapacidades } = await import("../admin.js");

  const alta = await altaCliente({ nombre: "Para Borrar", waPhone: "5493400000014", sistemas: ["bunn"] });
  const r = await bajaCliente(alta.userId);
  assert.strictEqual(r.ok, true);
  assert.ok(fs.existsSync(r.movidoA));

  const cap = await leerCapacidades();
  assert.strictEqual(cap["5493400000014"], undefined);
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `ssh -p 22022 -i ~/.ssh/vps_contabo root@5.189.136.177 "cd /opt/controlbun && node --test test/admin.test.js"`
Expected: FAIL — `altaCliente is not a function` (y las siguientes)

- [ ] **Step 3: Agregar la implementación a admin.js**

```javascript
// agregar a /opt/controlbun/admin.js
import {
  crearClienteWA, actualizarClientePorUserId, cargarClientePorUserId, eliminarCliente,
} from "./clientes.js";

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
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `ssh -p 22022 -i ~/.ssh/vps_contabo root@5.189.136.177 "cd /opt/controlbun && node --test test/admin.test.js"`
Expected: PASS — 22 tests, 0 fallas

- [ ] **Step 5: Commit**

```bash
ssh -p 22022 -i ~/.ssh/vps_contabo root@5.189.136.177 "cd /opt/controlbun && git add admin.js test/admin.test.js && GIT_AUTHOR_NAME='diegobertosi' GIT_AUTHOR_EMAIL='diegobertosi@gmail.com' GIT_COMMITTER_NAME='diegobertosi' GIT_COMMITTER_EMAIL='diegobertosi@gmail.com' git commit -m 'panel admin: alta, edicion y baja de cliente'"
```

---

### Task 6: HTTP router — exportar helpers de web.js + montar /admin/api/*

**Files:**
- Modify: `/opt/controlbun/web.js:1-58` (agregar `export` a helpers existentes)
- Modify: `/opt/controlbun/admin.js` (agregar `handleAdmin`)

**Interfaces:**
- Consumes: `getClientIp`, `checkLoginRateLimit`, `recordFailedLogin`, `clearLoginAttempts`, `parseCookies`, `readBody`, `sendJson` (ahora exportados desde `web.js`); todo lo de Tasks 1, 2, 4, 5.
- Produces: `handleAdmin(req, res, pathname, method): Promise<void>` (escribe la respuesta directo en `res`, no devuelve nada).

No es TDD puro (es un router HTTP, se verifica con `curl` real contra el proceso corriendo) — los pasos son escribir código y verificar manualmente.

- [ ] **Step 1: Exportar los helpers privados de web.js que hacen falta reusar**

En `/opt/controlbun/web.js`, cambiar estas 7 declaraciones (son las mismas funciones que ya existen, solo se les agrega `export`):

```javascript
export function getClientIp(req) { ... }          // ya existe, agregar "export"
export function checkLoginRateLimit(ip) { ... }    // ya existe, agregar "export"
export function recordFailedLogin(ip) { ... }      // ya existe, agregar "export"
export function clearLoginAttempts(ip) { ... }      // ya existe, agregar "export"
export function parseCookies(header = "") { ... }   // ya existe, agregar "export"
export async function readBody(req) { ... }          // ya existe, agregar "export"
export function sendJson(res, data, status = 200) { ... } // ya existe, agregar "export"
```

(El cuerpo de cada función no cambia, solo se agrega la palabra `export` antes de `function`/`async function`.)

- [ ] **Step 2: Agregar handleAdmin a admin.js**

```javascript
// agregar a /opt/controlbun/admin.js
import {
  getClientIp, checkLoginRateLimit, recordFailedLogin, clearLoginAttempts,
  parseCookies, readBody, sendJson,
} from "./web.js";

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
```

- [ ] **Step 3: Reiniciar el proceso y verificar con curl (sin sesión -> 401)**

```bash
ssh -p 22022 -i ~/.ssh/vps_contabo root@5.189.136.177 "sudo -iu claude pm2 restart controlbun && sleep 2 && curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3100/admin/api/clientes"
```
Expected: `401`

- [ ] **Step 4: Verificar login + listado con sesión**

```bash
ssh -p 22022 -i ~/.ssh/vps_contabo root@5.189.136.177 "
curl -s -c /tmp/admincookie -X POST http://localhost:3100/admin/api/login -H 'Content-Type: application/json' -d '{\"user\":\"__test_no_existe__\",\"password\":\"x\"}'
echo
curl -s -b /tmp/admincookie http://localhost:3100/admin/api/clientes
"
```
Expected: primera respuesta `{"error":"Usuario o contraseña incorrectos"}` (401, todavía no hay credenciales reales en `.env` — eso es Task 8); segunda respuesta `{"error":"No autorizado"}` (sin cookie válida).

- [ ] **Step 5: chown archivos nuevos y commit**

```bash
ssh -p 22022 -i ~/.ssh/vps_contabo root@5.189.136.177 "chown claude:claude /opt/controlbun/web.js /opt/controlbun/admin.js && cd /opt/controlbun && git add web.js admin.js && GIT_AUTHOR_NAME='diegobertosi' GIT_AUTHOR_EMAIL='diegobertosi@gmail.com' GIT_COMMITTER_NAME='diegobertosi' GIT_COMMITTER_EMAIL='diegobertosi@gmail.com' git commit -m 'panel admin: router HTTP /admin/api (login, logout, me, CRUD clientes)'"
```

---

### Task 7: Montar /admin en web.js + frontend admin.html

**Files:**
- Modify: `/opt/controlbun/web.js` (función `handle()`)
- Create: `/opt/controlbun/public/admin.html`

**Interfaces:**
- Consumes: `handleAdmin` de Task 6.
- Produces: `GET /admin` sirve la SPA; todo bajo `/admin/*` delega a `admin.js`.

- [ ] **Step 1: Montar el router en web.js**

En `/opt/controlbun/web.js`, dentro de `handle(req, res)`, agregar el import arriba del archivo:

```javascript
import { handleAdmin } from "./admin.js";
```

E insertar este bloque en `handle()`, inmediatamente después del bloque `if (p === "/auth" && method === "GET") { ... }` y antes de `// ── Serve app shell ──`:

```javascript
  // ── Panel admin (separado del panel de mapeos de clientes) ─────────────────
  if (p === "/admin" || p.startsWith("/admin/")) {
    await handleAdmin(req, res, p, method);
    return;
  }
```

- [ ] **Step 2: Crear public/admin.html**

```html
<!-- /opt/controlbun/public/admin.html -->
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Panel Admin — ControlBun</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, sans-serif; background: #EDE8DF; color: #1C2228; padding: 24px; }
  .card { background: #FAF8F4; border: 1px solid #D8D2C6; border-radius: 12px; padding: 24px; max-width: 900px; margin: 0 auto 16px; }
  h1 { font-size: 22px; margin-bottom: 16px; }
  label { display: block; font-size: 13px; margin: 8px 0 4px; }
  input, select { width: 100%; padding: 8px; border: 1px solid #D8D2C6; border-radius: 6px; font-size: 14px; }
  button { margin-top: 12px; padding: 8px 16px; border: none; border-radius: 6px; background: #1C2228; color: #fff; cursor: pointer; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px; }
  th, td { text-align: left; padding: 8px; border-bottom: 1px solid #EDE8DF; }
  .warn { color: #B24; font-weight: 600; }
  .err { color: #B24; font-size: 13px; margin-top: 8px; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 10px; background: #EDE8DF; font-size: 11px; margin-right: 4px; }
  .row-actions button { margin: 0 4px 0 0; padding: 4px 10px; font-size: 12px; }
</style>
</head>
<body>

<div id="login" class="card">
  <h1>Panel Admin</h1>
  <label>Usuario</label>
  <input id="loginUser" type="text" autocomplete="username">
  <label>Contraseña</label>
  <input id="loginPass" type="password" autocomplete="current-password">
  <button id="loginBtn">Entrar</button>
  <div id="loginErr" class="err"></div>
</div>

<div id="panel" class="card" style="display:none">
  <h1>Clientes <button id="logoutBtn" style="float:right;background:#888">Salir</button></h1>
  <table>
    <thead><tr><th>Nombre</th><th>WhatsApp</th><th>Sistemas</th><th>Trial</th><th>CD</th><th></th></tr></thead>
    <tbody id="tbody"></tbody>
  </table>
</div>

<div id="altaCard" class="card" style="display:none">
  <h1>Dar de alta</h1>
  <label>Nombre</label>
  <input id="altaNombre" type="text">
  <label>WhatsApp (con código de país, ej. 5493364524758)</label>
  <input id="altaPhone" type="text">
  <label>Sistemas</label>
  <label><input type="checkbox" value="bunn" class="altaSistema"> bunn</label>
  <label><input type="checkbox" value="redes" class="altaSistema"> redes</label>
  <label><input type="checkbox" value="entrevista" class="altaSistema"> entrevista</label>
  <label>Trial hasta (vacío = permanente)</label>
  <input id="altaTrial" type="date">
  <button id="altaBtn">Crear cliente</button>
  <div id="altaErr" class="err"></div>
</div>

<script>
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

async function checkSesion() {
  try {
    await api("/admin/api/me");
    document.getElementById("login").style.display = "none";
    document.getElementById("panel").style.display = "block";
    document.getElementById("altaCard").style.display = "block";
    await cargarClientes();
  } catch {
    document.getElementById("login").style.display = "block";
    document.getElementById("panel").style.display = "none";
    document.getElementById("altaCard").style.display = "none";
  }
}

document.getElementById("loginBtn").addEventListener("click", async () => {
  const user = document.getElementById("loginUser").value.trim();
  const password = document.getElementById("loginPass").value;
  document.getElementById("loginErr").textContent = "";
  try {
    await api("/admin/api/login", { method: "POST", body: JSON.stringify({ user, password }) });
    await checkSesion();
  } catch (e) {
    document.getElementById("loginErr").textContent = e.message;
  }
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await api("/admin/api/logout", { method: "POST" });
  await checkSesion();
});

async function cargarClientes() {
  const lista = await api("/admin/api/clientes");
  const tbody = document.getElementById("tbody");
  tbody.innerHTML = "";
  for (const c of lista) {
    const tr = document.createElement("tr");
    const trialTxt = !c.trialEstado ? "—" : c.trialEstado.estado === "permanente" ? "permanente" : `${c.trialEstado.estado} (${c.trialEstado.dias}d)`;
    tr.innerHTML = `
      <td>${c.nombre || "—"}${c.inconsistente ? ' <span class="warn">⚠</span>' : ""}</td>
      <td>${c.waPhone}</td>
      <td>${c.sistemas.map((s) => `<span class="pill">${s}</span>`).join("") || "—"}</td>
      <td>${trialTxt}</td>
      <td>${c.cdConfigurado ? "sí" : "no"}</td>
      <td class="row-actions">${c.userId ? `<button data-editar="${c.userId}" data-sistemas="${c.sistemas.join(",")}" data-trial="${c.trialUntil || ""}">Editar</button><button data-baja="${c.userId}">Baja</button>` : ""}</td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll("[data-baja]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("¿Dar de baja este cliente? (queda respaldado, no se borra)")) return;
      await api(`/admin/api/clientes/${encodeURIComponent(btn.dataset.baja)}`, { method: "DELETE" });
      await cargarClientes();
    });
  });
  tbody.querySelectorAll("[data-editar]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const userId = btn.dataset.editar;
      const sistemasActuales = btn.dataset.sistemas;
      const sistemasStr = prompt(`Sistemas (separados por coma): bunn, redes, entrevista`, sistemasActuales);
      if (sistemasStr === null) return;
      const trialActual = btn.dataset.trial;
      const trialStr = prompt(`Trial hasta (YYYY-MM-DD, vacío = permanente)`, trialActual);
      if (trialStr === null) return;
      const sistemas = sistemasStr.split(",").map((s) => s.trim()).filter(Boolean);
      try {
        await api(`/admin/api/clientes/${encodeURIComponent(userId)}`, {
          method: "PATCH",
          body: JSON.stringify({ sistemas, trialUntil: trialStr.trim() || null }),
        });
        await cargarClientes();
      } catch (e) {
        alert(e.message);
      }
    });
  });
}

document.getElementById("altaBtn").addEventListener("click", async () => {
  const nombre = document.getElementById("altaNombre").value.trim();
  const waPhone = document.getElementById("altaPhone").value.trim();
  const sistemas = [...document.querySelectorAll(".altaSistema:checked")].map((el) => el.value);
  const trialUntil = document.getElementById("altaTrial").value || null;
  document.getElementById("altaErr").textContent = "";
  try {
    await api("/admin/api/clientes", { method: "POST", body: JSON.stringify({ nombre, waPhone, sistemas, trialUntil }) });
    document.getElementById("altaNombre").value = "";
    document.getElementById("altaPhone").value = "";
    document.getElementById("altaTrial").value = "";
    document.querySelectorAll(".altaSistema").forEach((el) => (el.checked = false));
    await cargarClientes();
  } catch (e) {
    document.getElementById("altaErr").textContent = e.message;
  }
});

checkSesion();
</script>
</body>
</html>
```

- [ ] **Step 3: Reiniciar y verificar GET /admin sirve la página**

```bash
ssh -p 22022 -i ~/.ssh/vps_contabo root@5.189.136.177 "sudo -iu claude pm2 restart controlbun && sleep 2 && curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3100/admin"
```
Expected: `200`

- [ ] **Step 4: chown y commit**

```bash
ssh -p 22022 -i ~/.ssh/vps_contabo root@5.189.136.177 "chown -R claude:claude /opt/controlbun/web.js /opt/controlbun/public/admin.html && cd /opt/controlbun && git add web.js public/admin.html && GIT_AUTHOR_NAME='diegobertosi' GIT_AUTHOR_EMAIL='diegobertosi@gmail.com' GIT_COMMITTER_NAME='diegobertosi' GIT_COMMITTER_EMAIL='diegobertosi@gmail.com' git commit -m 'panel admin: montar /admin en web.js + frontend admin.html'"
```

---

### Task 8: Credenciales reales, deploy y smoke test end-to-end

**Files:**
- Modify: `/opt/controlbun/.env` (no versionado — nunca se commitea)

- [ ] **Step 1: Generar los hashes de las 2 cuentas reales**

Pedirle a Diego y Fernando que elijan sus contraseñas, o generar unas temporales para el primer login (a cambiar después). Ejemplo con placeholders — reemplazar `<PASSWORD_DIEGO>`/`<PASSWORD_FERNANDO>` por las reales antes de correr:

```bash
ssh -p 22022 -i ~/.ssh/vps_contabo root@5.189.136.177 "cd /opt/controlbun && node -e \"
const { hashPassword } = require('./admin.js');
\" 2>&1 || node --input-type=module -e \"
import { hashPassword } from '/opt/controlbun/admin.js';
console.log(JSON.stringify([
  { user: 'diego', passHash: hashPassword('<PASSWORD_DIEGO>') },
  { user: 'fernando', passHash: hashPassword('<PASSWORD_FERNANDO>') },
]));
\""
```

- [ ] **Step 2: Agregar la línea a .env**

Con el JSON que devolvió el paso anterior:

```bash
ssh -p 22022 -i ~/.ssh/vps_contabo root@5.189.136.177 "echo 'ADMIN_CREDENTIALS='\''<PEGAR_EL_JSON_ACA>'\''' >> /opt/controlbun/.env"
```

- [ ] **Step 3: Reiniciar el proceso**

```bash
ssh -p 22022 -i ~/.ssh/vps_contabo root@5.189.136.177 "sudo -iu claude pm2 restart controlbun && sleep 2 && sudo -iu claude pm2 logs controlbun --lines 15 --nostream"
```
Expected: sin errores de arranque, log normal.

- [ ] **Step 4: Smoke test end-to-end vía curl (login real + listado + alta + baja de un cliente de prueba)**

```bash
ssh -p 22022 -i ~/.ssh/vps_contabo root@5.189.136.177 "
curl -s -c /tmp/admincookie -X POST http://localhost:3100/admin/api/login -H 'Content-Type: application/json' -d '{\"user\":\"diego\",\"password\":\"<PASSWORD_DIEGO>\"}'
echo
echo '--- listado (debe incluir fernando-vidal) ---'
curl -s -b /tmp/admincookie http://localhost:3100/admin/api/clientes
echo
echo '--- alta de prueba ---'
curl -s -b /tmp/admincookie -X POST http://localhost:3100/admin/api/clientes -H 'Content-Type: application/json' -d '{\"nombre\":\"Smoke Test\",\"waPhone\":\"5493400009999\",\"sistemas\":[\"bunn\"]}'
echo
echo '--- baja de prueba (usar el userId que devolvio el alta) ---'
"
```
Verificar a mano: el login devuelve `{"ok":true,"user":"diego"}`; el listado incluye `fernando-vidal` con sus sistemas reales; el alta devuelve `{"ok":true,"userId":"smoke-test"}`; después dar de baja ese `userId` con `curl -s -b /tmp/admincookie -X DELETE http://localhost:3100/admin/api/clientes/smoke-test` y confirmar que `/opt/controlbun/clientes/.deleted/` tiene el archivo movido.

- [ ] **Step 5: Push final de todo lo pendiente**

```bash
ssh -p 22022 -i ~/.ssh/vps_contabo root@5.189.136.177 "cd /opt/controlbun && git status --short && GIT_SSH_COMMAND='ssh -i /home/claude/.ssh/deploy_controlbun -o IdentitiesOnly=yes -o StrictHostKeyChecking=no' git push git@github.com:loctime/controlbun.git master"
```
Expected: `git status --short` sin nada pendiente (todo se fue commiteando por task), push exitoso.

---
