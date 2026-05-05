import "dotenv/config";
import { Bot, InputFile } from "grammy";
import { cargarCliente, registrarCliente, guardarPendiente, consumirPendiente } from "./clientes.js";
import { pdfAImagenes } from "./pdf.js";

const bot = new Bot(process.env.TG_TOKEN);
const ADMIN_ID = process.env.ADMIN_CHAT_ID;

const esperandoCodigo = new Set();

// --- /miid — cualquiera ---
bot.command("miid", (ctx) => {
  const chatId = String(ctx.chat.id);
  console.log(`[CMD] /miid chatId=${chatId}`);
  return ctx.reply(`Tu chat ID es: <code>${chatId}</code>`, { parse_mode: "HTML" });
});

// --- /nuevocliente — solo admin ---
bot.command("nuevocliente", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const esAdmin = chatId === String(ADMIN_ID);
  console.log(`[CMD] /nuevocliente chatId=${chatId} esAdmin=${esAdmin}`);
  if (!esAdmin) return;

  const args = ctx.match?.trim();
  const match = args?.match(/^(\S+)\s+(\S+)$/);
  if (!match) {
    return ctx.reply("Uso: /nuevocliente NombreApellido CODIGO");
  }
  const nombre = match[1].replace(/([A-Z])/g, " $1").trim().replace(/\b\w/g, (c) => c.toUpperCase());
  const codigo = match[2].trim();
  await guardarPendiente(codigo, nombre);
  console.log(`[ADMIN] nuevo cliente: ${nombre} código: ${codigo}`);
  return ctx.reply(`✅ Código <code>${codigo}</code> listo para <b>${nombre}</b>.`, { parse_mode: "HTML" });
});

bot.on("message", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const texto = ctx.message.text?.trim() || "";
  const esAdmin = chatId === String(ADMIN_ID);
  console.log(`[MSG] chatId=${chatId} esAdmin=${esAdmin} texto="${texto}"`);

  // --- PDF (admin y clientes) ---
  if (ctx.message.document?.mime_type === "application/pdf") {
    const cliente = await cargarCliente(chatId);
    if (!cliente && !esAdmin) return ctx.reply("Espera un poco... no nos conocemos, sabes la contraseña?");
    const nombreUsuario = cliente?.nombre || "Admin";
    await ctx.reply("📄 Renderizando páginas…");
    try {
      const file = await ctx.getFile();
      const url = `https://api.telegram.org/file/bot${process.env.TG_TOKEN}/${file.file_path}`;
      console.log(`[PDF] descargando desde Telegram…`);
      const res = await fetch(url);
      const buffer = Buffer.from(await res.arrayBuffer());
      console.log(`[PDF] descargado (${Math.round(buffer.length / 1024)}KB), renderizando…`);
      const imagenes = await pdfAImagenes(buffer);
      console.log(`[PDF] ${nombreUsuario} → ${imagenes.length} páginas`);
      for (const { pagina, base64 } of imagenes) {
        console.log(`[PDF] enviando página ${pagina}/${imagenes.length}…`);
        const imgBuffer = Buffer.from(base64, "base64");
        await ctx.replyWithPhoto(new InputFile(imgBuffer, `pagina-${pagina}.jpg`), { caption: `Página ${pagina}` });
      }
      await ctx.reply(`✅ ${imagenes.length} página${imagenes.length > 1 ? "s" : ""} renderizadas correctamente.`);
    } catch (e) {
      console.error("[PDF ERROR]", e.message);
      await ctx.reply(`❌ Error renderizando el PDF: ${e.message}`);
    }
    return;
  }

  // --- Admin: ignorar otros mensajes ---
  if (esAdmin) return;

  // --- Cliente registrado ---
  const cliente = await cargarCliente(chatId);
  if (cliente) {
    console.log(`[MSG] → cliente registrado: ${cliente.nombre}`);
    return ctx.reply(`Hola ${cliente.nombre}, recibido.`);
  }

  // --- Esperando código ---
  if (esperandoCodigo.has(chatId)) {
    const pendiente = await consumirPendiente(texto);
    if (pendiente) {
      esperandoCodigo.delete(chatId);
      await registrarCliente(chatId, pendiente.nombre);
      console.log(`[MSG] → registrado: ${pendiente.nombre}`);
      return ctx.reply(`¡Bienvenido <b>${pendiente.nombre}</b>! estoy listo para los PDF.`, { parse_mode: "HTML" });
    }
    console.log(`[MSG] → código incorrecto: "${texto}"`);
    return ctx.reply("Contraseña incorrecta");
  }

  // --- Desconocido ---
  console.log(`[MSG] → desconocido, pidiendo código`);
  esperandoCodigo.add(chatId);
  ctx.reply("No te conozco... ¿Contraseña?");
});

bot.catch((err) => console.error("[BOT ERROR]", err.message));

async function setupCommands() {
  await bot.api.setMyCommands(
    [{ command: "miid", description: "Ver tu chat ID" }],
    { scope: { type: "default" } }
  );
  if (ADMIN_ID) {
    await bot.api.setMyCommands(
      [
        { command: "miid", description: "Ver tu chat ID" },
        { command: "nuevocliente", description: "Registrar cliente: NombreApellido CODIGO" },
      ],
      { scope: { type: "chat", chat_id: Number(ADMIN_ID) } }
    );
  }
  console.log("[BOT] Comandos registrados en Telegram");
}

setupCommands().catch((e) => console.error("[SETUP ERROR]", e.message));
bot.start();
console.log(`ControlBun corriendo… Admin: ${ADMIN_ID || "⚠️ NO CONFIGURADO"}`);
