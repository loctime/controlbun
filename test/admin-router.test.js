import { test } from "node:test";
import assert from "node:assert";
import os from "node:os";
import path from "node:path";

const { handleAdmin, hashPassword } = await import("../admin.js");

// ── Mocks mínimos de req/res para ejercitar handleAdmin sin un server HTTP real ──

function mockReq({ headers = {}, body = "" } = {}) {
  const chunks = typeof body === "string" ? [Buffer.from(body)] : [Buffer.from(JSON.stringify(body))];
  return {
    headers,
    socket: { remoteAddress: "127.0.0.1" },
    // readBody hace `for await (const chunk of req)`, así que req necesita ser async-iterable.
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

function mockRes() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(code, h) { this.statusCode = code; this.headers = h; },
    end(b) { this.body = b; },
  };
}

function setupAdminEnv() {
  process.env.ADMIN_CREDENTIALS = JSON.stringify([{ user: "diego", passHash: hashPassword("passCorrecta") }]);
  process.env.CLIENTES_DIR = path.join(os.tmpdir(), `router-clientes-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env.CAPACIDADES_PATH = path.join(os.tmpdir(), `router-cap-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test("GET /admin/api/clientes sin cookie de sesión -> 401", async () => {
  setupAdminEnv();
  const req = mockReq({ headers: {} });
  const res = mockRes();
  await handleAdmin(req, res, "/admin/api/clientes", "GET");
  assert.strictEqual(res.statusCode, 401);
  const data = JSON.parse(res.body);
  assert.ok(data.error);
});

test("DELETE /admin/api/clientes/x sin cookie de sesión -> 401", async () => {
  setupAdminEnv();
  const req = mockReq({ headers: {} });
  const res = mockRes();
  await handleAdmin(req, res, "/admin/api/clientes/x", "DELETE");
  assert.strictEqual(res.statusCode, 401);
  const data = JSON.parse(res.body);
  assert.ok(data.error);
});

test("POST /admin/api/login con body malformado -> 400, no explota", async () => {
  setupAdminEnv();
  const req = mockReq({ headers: {}, body: "{no es json" });
  const res = mockRes();
  await handleAdmin(req, res, "/admin/api/login", "POST");
  assert.strictEqual(res.statusCode, 400);
  const data = JSON.parse(res.body);
  assert.ok(data.error);
});

test('POST /admin/api/login con body "null" -> 401, no explota', async () => {
  setupAdminEnv();
  const req = mockReq({ headers: {}, body: "null" });
  const res = mockRes();
  await handleAdmin(req, res, "/admin/api/login", "POST");
  assert.strictEqual(res.statusCode, 401);
  const data = JSON.parse(res.body);
  assert.ok(data.error);
});

test("POST /admin/api/login con usuario/password incorrectos -> 401", async () => {
  setupAdminEnv();
  const req = mockReq({ headers: {}, body: { user: "diego", password: "mala" } });
  const res = mockRes();
  await handleAdmin(req, res, "/admin/api/login", "POST");
  assert.strictEqual(res.statusCode, 401);
  const data = JSON.parse(res.body);
  assert.ok(data.error);
});

test("POST /admin/api/login con credenciales correctas -> 200 y setea cookie admin_session", async () => {
  setupAdminEnv();
  const req = mockReq({ headers: {}, body: { user: "diego", password: "passCorrecta" } });
  const res = mockRes();
  await handleAdmin(req, res, "/admin/api/login", "POST");
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.headers["Set-Cookie"].startsWith("admin_session="));
});

test("GET /admin/api/clientes con sesión válida -> 200", async () => {
  setupAdminEnv();
  // login primero, para obtener una cookie de sesión válida
  const loginReq = mockReq({ headers: {}, body: { user: "diego", password: "passCorrecta" } });
  const loginRes = mockRes();
  await handleAdmin(loginReq, loginRes, "/admin/api/login", "POST");
  const setCookie = loginRes.headers["Set-Cookie"];
  const sid = setCookie.split(";")[0]; // "admin_session=<sid>"

  const req = mockReq({ headers: { cookie: sid } });
  const res = mockRes();
  await handleAdmin(req, res, "/admin/api/clientes", "GET");
  assert.strictEqual(res.statusCode, 200);
  assert.ok(Array.isArray(JSON.parse(res.body)));
});
