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
