import "dotenv/config";
import { readFileSync } from "fs";
import { cdObtenerSesionActiva, cdLeerRequerimientos, cdSubirArchivo } from "./cd.js";

// Uso: node test-subir.js <archivo.pdf> [nombre_req]
// Ejemplo: node test-subir.js test.pdf "F 931-2026-4"

const archivoPdf = process.argv[2];
const reqFiltro = process.argv[3] || "";

if (!archivoPdf) {
  console.log("Uso: node test-subir.js <archivo.pdf> [parte_del_nombre_req]");
  process.exit(1);
}

const bufferPdf = readFileSync(archivoPdf);
const nombreArchivo = archivoPdf.split(/[\\/]/).pop();
console.log(`\nPDF: ${nombreArchivo} (${(bufferPdf.length / 1024).toFixed(1)} KB)`);

// Credenciales del cliente diego (admin)
const cliente = JSON.parse(readFileSync("./clientes/diego.json", "utf8"));
console.log(`Cliente: ${cliente.nombre} (${cliente.cdUser})\n`);

const chatId = cliente.chatId;

console.log("Conectando a CD...");
const ses = await cdObtenerSesionActiva(chatId, cliente.cdUser, cliente.cdPass);
if (!ses.ok) {
  console.error("Login falló:", ses.motivo);
  process.exit(1);
}
console.log("Login OK\n");

console.log("Leyendo requerimientos pendientes...");
const reqs = await cdLeerRequerimientos(ses.page);
if (!reqs.length) {
  console.log("No hay requerimientos pendientes.");
  process.exit(0);
}

// Filtrar si se pasó un nombre
const lista = reqFiltro
  ? reqs.filter((r) => r.nombre.toLowerCase().includes(reqFiltro.toLowerCase()))
  : reqs;

if (!lista.length) {
  console.log(`No encontré reqs con "${reqFiltro}". Reqs disponibles:`);
  reqs.forEach((r, i) => console.log(`  ${i + 1}. ${r.nombre}${r.entidad ? ` — ${r.entidad}` : ""}`));
  process.exit(1);
}

console.log(`Requerimientos encontrados (${lista.length}):`);
lista.forEach((r, i) => console.log(`  ${i + 1}. ${r.nombre}${r.entidad ? ` — ${r.entidad}` : ""} | href: ${r.href ? "sí" : "no"}`));

// Usar el primero de la lista filtrada
const req = lista[0];
console.log(`\n→ Usando: "${req.nombre}"${req.entidad ? ` (${req.entidad})` : ""}\n`);

try {
  await cdSubirArchivo(ses.page, req.href, bufferPdf, nombreArchivo, req.nombre, req.entidad);
  console.log("\n✅ Prueba completada sin errores");
} catch (e) {
  console.error("\n❌ Error en subida:", e.message);
  if (e.screenshot) {
    const { writeFileSync } = await import("fs");
    writeFileSync("error-screenshot.jpg", e.screenshot);
    console.log("Screenshot guardado: error-screenshot.jpg");
  }
}

process.exit(0);
