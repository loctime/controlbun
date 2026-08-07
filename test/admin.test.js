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
