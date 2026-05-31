/**
 * test-verificacion.js — Ejecuta cdLeerVencimientos modificado para Fernando Vidal
 * y muestra los items finales + el debug interno. Sirve para validar end-to-end
 * sin tener que reiniciar el bot.
 */
import fs from "fs";
import { cdCrearSesion, cdLogin, cdLeerVencimientos, cdCerrarSesion } from "./cd.js";

const CLIENTE = JSON.parse(fs.readFileSync("./clientes/fernando-vidal.json", "utf8"));

(async () => {
  const sesion = await cdCrearSesion();
  const login = await cdLogin(sesion.page, CLIENTE.cdUser, CLIENTE.cdPass);
  if (!login.ok) {
    console.error("LOGIN FAIL:", login.motivo);
    process.exit(1);
  }
  const r = await cdLeerVencimientos(
    sesion.page,
    CLIENTE.diasPersonal || 10,
    CLIENTE.diasVehiculos || 10,
    CLIENTE.diasEmpresa || 10,
  );
  console.log(`\n=== ${r.items.length} items finales ===`);
  for (const it of r.items) {
    console.log(`  [${it.tipo}] ${it.nombre} | ${it.columna} | ${it.fecha} | ${it.diasFaltantes}d${it._corregidoDesde ? " (era " + it._corregidoDesde + ")" : ""}`);
  }
  await cdCerrarSesion(sesion.context);
})();
