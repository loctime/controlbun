import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "clientes-"));
process.env.CLIENTES_DIR = TMP;

const {
  slugify, genLinkCode, normalizeArgWa,
  cargarCliente, cargarClientePorUserId, registrarCliente, crearClienteWA, actualizarCliente,
  cargarClientePorLinkCode, vincularTelegram, setWaPhone,
} = await import("../clientes.js");

test("slugify", () => {
  assert.strictEqual(slugify("Miguel Rojas"), "miguel-rojas");
  assert.strictEqual(slugify("Áñ Empresa S.A."), "an-empresa-sa");
});

test("genLinkCode: 6 chars del alfabeto seguro", () => {
  assert.match(genLinkCode(), /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
});

test("normalizeArgWa", () => {
  assert.strictEqual(normalizeArgWa("3364345081"), "5493364345081");
  assert.strictEqual(normalizeArgWa("5493364345081"), "5493364345081");
  assert.strictEqual(normalizeArgWa("+54 9 11 2345-6789"), "5491123456789");
  assert.strictEqual(normalizeArgWa("1123456789"), "5491123456789");
});

test("crearClienteWA: WA-first, sin telegram, con linkCode", async () => {
  const c = await crearClienteWA("Miguel Rojas", "3364345081");
  assert.strictEqual(c.userId, "miguel-rojas");
  assert.strictEqual(c.waPhone, "5493364345081");
  assert.strictEqual(c.telegramChatId, null);
  assert.match(c.linkCode, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  // persiste
  assert.ok(fs.existsSync(path.join(TMP, "miguel-rojas.json")));
});

test("registrarCliente: Telegram-first", async () => {
  const c = await registrarCliente("12345", "Ana Lopez");
  assert.strictEqual(c.userId, "ana-lopez");
  assert.strictEqual(String(c.telegramChatId), "12345");
  assert.strictEqual(c.waPhone, null);
});

test("cargarCliente matchea por telegramChatId", async () => {
  const c = await cargarCliente("12345");
  assert.ok(c);
  assert.strictEqual(c.userId, "ana-lopez");
  assert.strictEqual(await cargarCliente("99999"), null);
});

test("cargarClientePorUserId", async () => {
  const c = await cargarClientePorUserId("miguel-rojas");
  assert.ok(c);
  assert.strictEqual(c.waPhone, "5493364345081");
});

test("actualizarCliente por telegramChatId", async () => {
  const u = await actualizarCliente("12345", { cdUser: "ana@x.com" });
  assert.strictEqual(u.cdUser, "ana@x.com");
  const reload = await cargarCliente("12345");
  assert.strictEqual(reload.cdUser, "ana@x.com");
  assert.strictEqual(await actualizarCliente("99999", { cdUser: "x" }), null);
});

test("dedup de userId (slug colisionado → -2)", async () => {
  const c2 = await crearClienteWA("Miguel Rojas", "3364345082");
  assert.strictEqual(c2.userId, "miguel-rojas-2");
});

test("cargarClientePorLinkCode encuentra por linkCode", async () => {
  const c = await crearClienteWA("Link Uno", "3364341111");
  const found = await cargarClientePorLinkCode(c.linkCode);
  assert.ok(found);
  assert.strictEqual(found.userId, "link-uno");
  assert.strictEqual(await cargarClientePorLinkCode("ZZZZZZ"), null);
});

test("vincularTelegram setea telegramChatId, consume el linkCode (un solo uso)", async () => {
  const c = await crearClienteWA("Link Dos", "3364342222");
  const v = await vincularTelegram(c.linkCode, "55501");
  assert.ok(v);
  assert.strictEqual(String(v.telegramChatId), "55501");
  assert.strictEqual(v.linkCode, null);
  // segundo intento con el mismo código → null (ya consumido)
  assert.strictEqual(await vincularTelegram(c.linkCode, "55502"), null);
  // ahora se carga por telegramChatId
  const byTg = await cargarCliente("55501");
  assert.strictEqual(byTg.userId, "link-dos");
});

test("vincularTelegram con código inválido → null", async () => {
  assert.strictEqual(await vincularTelegram("ZZZZZZ", "999"), null);
});

test("setWaPhone agrega waPhone normalizado a un cliente existente", async () => {
  const c = await registrarCliente("66601", "Tele Tres");
  const u = await setWaPhone(c.userId, "3364343333");
  assert.ok(u);
  assert.strictEqual(u.waPhone, "5493364343333");
  assert.strictEqual(await setWaPhone("no-existe", "1"), null);
});
