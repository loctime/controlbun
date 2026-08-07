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

// ── Tests Task 2: capacidades.json y trialEstadoDe ──────────────────────────
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

// ── Tests Task 4: listado cruzado clientes + capacidades ────────────────────
import fssync from "fs";
const { listarClientesCruzado } = await import("../admin.js");
const { crearClienteWA } = await import("../clientes.js");

test("listarClientesCruzado: cruza cliente+capacidades por telefono, detecta inconsistencias", async () => {
  const clientesTmp = path.join(os.tmpdir(), `clientes-cruzado-${Date.now()}`);
  fssync.mkdirSync(clientesTmp);
  process.env.CLIENTES_DIR = clientesTmp;
  const capTmp = path.join(os.tmpdir(), `cap-cruzado-${Date.now()}.json`);
  process.env.CAPACIDADES_PATH = capTmp;

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

test("listarClientesCruzado: cdConfigurado es true cuando cliente tiene cdUser", async () => {
  const clientesTmp = path.join(os.tmpdir(), `clientes-cdconf-${Date.now()}`);
  fssync.mkdirSync(clientesTmp);
  process.env.CLIENTES_DIR = clientesTmp;
  const capTmp = path.join(os.tmpdir(), `cap-cdconf-${Date.now()}.json`);
  process.env.CAPACIDADES_PATH = capTmp;

  const { setCdCreds } = await import("../clientes.js");

  // Crear cliente
  const cliente = await crearClienteWA("Diego Con CD", "5493364524759");
  // Setear cdUser
  await setCdCreds(cliente.userId, { cdUser: "diego@controlapps.ar", cdPass: "secret" });

  // Escribir capacidades para este cliente
  await escribirCapacidades({
    "5493364524759": { nombre: "Diego Con CD", sistemas: ["bunn", "redes"] },
  });

  const lista = await listarClientesCruzado();
  const conCD = lista.find((c) => c.waPhone === "5493364524759");

  assert.strictEqual(conCD.cdConfigurado, true);
  assert.strictEqual(conCD.inconsistente, false);
  assert.deepStrictEqual(conCD.sistemas, ["bunn", "redes"]);
});

// ── Tests Task 5: alta, edicion y baja de cliente ───────────────────────────
function nuevoTmpDir(prefix) {
  const d = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fssync.mkdirSync(d);
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
  assert.ok(fssync.existsSync(r.movidoA));

  const cap = await leerCapacidades();
  assert.strictEqual(cap["5493400000014"], undefined);
});

test("altaCliente: si falla escribir capacidades.json, devuelve warning en vez de tirar", async () => {
  process.env.CLIENTES_DIR = nuevoTmpDir("clientes-altawarn");
  // CAPACIDADES_PATH apunta a un directorio (no un archivo): fs.writeFile tira EISDIR,
  // lo cual dispara el catch y produce el warning sin perder el cliente ya creado.
  process.env.CAPACIDADES_PATH = nuevoTmpDir("cap-altawarn-dir");
  const { altaCliente } = await import("../admin.js");
  const { cargarClientePorUserId } = await import("../clientes.js");

  const r = await altaCliente({ nombre: "Con Warning", waPhone: "5493400000015", sistemas: ["bunn"] });
  assert.strictEqual(r.ok, true);
  assert.ok(r.userId);
  assert.strictEqual(typeof r.warning, "string");
  assert.ok(r.warning.length > 0);

  // el cliente se creó igual, aunque capacidades.json no se pudo actualizar
  const cliente = await cargarClientePorUserId(r.userId);
  assert.strictEqual(cliente.waPhone, "5493400000015");
});

test("editarCliente: si falla escribir capacidades.json, devuelve warning en vez de tirar (y la escritura primaria persiste)", async () => {
  process.env.CLIENTES_DIR = nuevoTmpDir("clientes-editwarn");
  process.env.CAPACIDADES_PATH = path.join(os.tmpdir(), `cap-editwarn-${Date.now()}.json`);
  const { altaCliente, editarCliente } = await import("../admin.js");
  const { cargarClientePorUserId } = await import("../clientes.js");

  const alta = await altaCliente({ nombre: "Editable Warning", waPhone: "5493400000016", sistemas: ["bunn"] });

  // ahora rompemos capacidades.json apuntándolo a un directorio antes de editar
  process.env.CAPACIDADES_PATH = nuevoTmpDir("cap-editwarn-dir");

  // el patch incluye trialUntil (además de sistemas) para forzar que actualizarClientePorUserId
  // SÍ se ejecute y persista antes de que falle escribirCapacidades — si solo mandáramos
  // "sistemas", no habría ninguna escritura primaria real que verificar acá.
  const r = await editarCliente(alta.userId, { trialUntil: "2026-12-31", sistemas: ["bunn", "redes"] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(typeof r.warning, "string");
  assert.ok(r.warning.length > 0);

  // la escritura primaria (clientes/<userId>.json) persistió pese al warning
  const cliente = await cargarClientePorUserId(alta.userId);
  assert.strictEqual(cliente.trialUntil, "2026-12-31");
});

test("bajaCliente: si falla escribir capacidades.json, devuelve warning en vez de tirar", async () => {
  process.env.CLIENTES_DIR = nuevoTmpDir("clientes-bajawarn");
  process.env.CAPACIDADES_PATH = path.join(os.tmpdir(), `cap-bajawarn-${Date.now()}.json`);
  const { altaCliente, bajaCliente } = await import("../admin.js");

  const alta = await altaCliente({ nombre: "Para Borrar Warning", waPhone: "5493400000017", sistemas: ["bunn"] });

  // ahora rompemos capacidades.json apuntándolo a un directorio antes de dar de baja
  process.env.CAPACIDADES_PATH = nuevoTmpDir("cap-bajawarn-dir");

  const r = await bajaCliente(alta.userId);
  assert.strictEqual(r.ok, true);
  assert.ok(r.movidoA);
  assert.ok(fssync.existsSync(r.movidoA));
  assert.strictEqual(typeof r.warning, "string");
  assert.ok(r.warning.length > 0);
});

test("editarCliente: cliente sin waPhone no corrompe capacidades.json (devuelve warning)", async () => {
  process.env.CLIENTES_DIR = nuevoTmpDir("clientes-editnowap");
  process.env.CAPACIDADES_PATH = path.join(os.tmpdir(), `cap-editnowap-${Date.now()}.json`);
  const { editarCliente, leerCapacidades } = await import("../admin.js");
  const { registrarCliente } = await import("../clientes.js");

  // Crear cliente SIN waPhone (via Telegram, sin teléfono)
  const cliente = await registrarCliente("999999999", "Cliente Sin Tel");

  // Intentar editarlo asignándole sistemas
  const r = await editarCliente(cliente.userId, { sistemas: ["bunn"] });

  // Debe devolver ok:true pero con warning
  assert.strictEqual(r.ok, true);
  assert.strictEqual(typeof r.warning, "string");
  assert.ok(r.warning.includes("sin waPhone"), "Warning debe mencionar falta de waPhone");

  // Verificar que capacidades.json NO tiene una entrada con key ""
  const cap = await leerCapacidades();
  assert.strictEqual(cap[""], undefined, "No debe haber entrada con key vacía en capacidades.json");
  // Verificar que capacidades está vacío (no debe haber ninguna otra entrada)
  assert.deepStrictEqual(cap, {}, "capacidades.json debe estar vacío, sin entradas corruptas");
});
