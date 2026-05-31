import "dotenv/config";
import { Bot, InputFile } from "grammy";
import cron from "node-cron";
import { cargarCliente, registrarCliente, guardarPendiente, consumirPendiente, actualizarCliente, listarTodosClientes } from "./clientes.js";
import { pdfAImagenes, cortarPaginas, inicializarPdf } from "./pdf.js";
import { guardarMapeo, leerTodosMapeosPorTipo, eliminarMapeo, leerMapeoBruto, guardarTipoMapeo, leerTipoMapeo } from "./mapeos.js";
import { cdObtenerSesionActiva, cdInvalidarSesion, cdLeerRequerimientos, cdLeerTiposRequerimientos, cdSubirArchivo, cdLeerVencimientos, cdGrabarParteMensual, cdScrapearTipoRequerimiento, cdGenerarRequerimiento, cdDetectarNombreEmpresa } from "./cd.js";
import { matchearPaginasConReqs, setAiProvider, getCurrentProviderLabel } from "./claude.js";
import { tonteria } from "./tonterias.js";
import { startWebServer, generarTokenWeb } from "./web.js";
import { startTunnel } from "./tunnel.js";
import { isDelegated, enterDelegated, closeDelegated, appendInbox, saveUpload, readState, findActiveDelegated } from "./delegado-router.js";
import { readCache, writeCache, saveScreenshots, invalidateCache, TTL_PENDIENTES, TTL_VENCIMIENTOS } from "./cache.js";

const bot = new Bot(process.env.TG_TOKEN);
const ADMIN_IDS = (process.env.ADMIN_CHAT_ID || "").split(",").map(s => s.trim()).filter(Boolean);

// ─── Middleware: modo delegado (DEBE ir antes de cualquier bot.command/bot.on) ─
// Si Bunn está atendiendo a este chat, captura todo (texto + PDF + comandos) y
// lo deja en su inbox. bot.js NO responde — el cliente solo ve los mensajes de
// Bunn (que usa el mismo token de @ControlBunBot via send-as-controlbun.js).
//
// Escape de emergencia: /destrancar (solo admins) fuerza la salida del modo.
bot.use(async (ctx, next) => {
  if (!ctx.message || !ctx.chat) return next();
  const chatId = String(ctx.chat.id);

  let delegated;
  try {
    delegated = await isDelegated(chatId);
  } catch (e) {
    console.error("[delegado] isDelegated error:", e.message);
    return next();
  }
  if (!delegated) return next();

  if (ctx.message.text === "/destrancar" && ADMIN_IDS.includes(chatId)) {
    await closeDelegated(chatId, "destrabado por admin");
    return ctx.reply("✅ Modo delegado cerrado. Volvés a hablar con controlbun.");
  }

  // Cliente cierra el modo delegado voluntariamente.
  if (ctx.message.text === "/listo") {
    await closeDelegated(chatId, "cerrado por cliente con /listo");
    return ctx.reply("Listo, modo libre cerrado. Si necesitás comandos rápidos: /pendientes /vencimientos /partemes /aprender.");
  }

  try {
    if (ctx.message.document?.mime_type === "application/pdf") {
      const file = await ctx.getFile();
      const url = `https://api.telegram.org/file/bot${process.env.TG_TOKEN}/${file.file_path}`;
      const res = await fetch(url);
      const buffer = Buffer.from(await res.arrayBuffer());
      const filename = ctx.message.document.file_name || "doc.pdf";
      const savedFile = await saveUpload(chatId, buffer, filename);
      await appendInbox(chatId, {
        kind: "pdf",
        file: savedFile,
        original_filename: filename,
        text: ctx.message.caption || "",
      });
    } else if (ctx.message.text) {
      await appendInbox(chatId, { kind: "text", text: ctx.message.text });
    } else {
      // Otros tipos (foto, voz, etc.) — placeholder para que Bunn sepa que
      // llegó algo no soportado y pueda pedirle al cliente que reenvíe.
      await appendInbox(chatId, {
        kind: "text",
        text: "(el cliente mandó un mensaje de tipo no soportado todavía: foto/audio/video)",
      });
    }
  } catch (e) {
    console.error("[delegado] error guardando en inbox:", e.message);
  }
  // Sin respuesta — Bunn habla por su lado.
});

// ─── Estado de sesión por usuario (en memoria) ───────────────────────────────

const sesiones = new Map();
const esperandoCodigo = new Set();

function getSesion(chatId) {
  if (!sesiones.has(chatId)) sesiones.set(chatId, { fase: "idle" });
  return sesiones.get(chatId);
}

function setSesion(chatId, datos) {
  sesiones.set(chatId, { ...getSesion(chatId), ...datos });
}

function resetSesion(chatId) {
  sesiones.set(chatId, { fase: "idle" });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MAX_REQS_VISIBLE = 20;

function formatearReqs(reqs, { mostrarTodos = false } = {}) {
  const visibles = mostrarTodos ? reqs : reqs.slice(0, MAX_REQS_VISIBLE);
  const resto = reqs.length - visibles.length;
  const lineas = visibles.map((r, i) => {
    const entidad = r.entidad ? ` — <i>${escapeHtml(r.entidad)}</i>` : "";
    return `${i + 1}. ${escapeHtml(r.nombre)}${entidad}`;
  });
  if (resto > 0) lineas.push(`\n<i>... y ${resto} más. Escribí parte del nombre para filtrar.</i>`);
  return lineas.join("\n");
}

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Quita el sufijo de período "-2026-4" para comparar tipos de documentos
const baseNombreReq = (s) => String(s || "").replace(/-\d{4}-\d+$/i, "").trim().toLowerCase();

async function continuarAprendiendoDesdeConflicto(ctx, chatId) {
  const sesion = getSesion(chatId);
  const { pendingGrupos, pendingPaginasSinAsignar, pendingNombresReqs, pendingGrupoActual } = sesion;
  setSesion(chatId, { grupos: pendingGrupos, paginasSinAsignar: pendingPaginasSinAsignar, grupoActual: null, fase: "aprender_agrupando" });
  const confirmacion = `✅ ${pendingNombresReqs} = páginas ${pendingGrupoActual.paginas.join(", ")}\n\n`;

  if (!pendingPaginasSinAsignar.size) {
    const asignados = await guardarSesionMapeo(chatId);
    const resumen = asignados.map((g) => `• <b>${escapeHtml(g.req.nombre)}</b>${g.req.entidad ? ` (${escapeHtml(g.req.entidad)})` : ""} → ${g.paginas.length} pág.`).join("\n");
    setSesion(chatId, { fase: "aprender_preguntando_mas", grupos: [], imagenes: [], paginasSinAsignar: new Set() });
    return ctx.reply(confirmacion + `Todas las páginas mapeadas. Mapeo guardado:\n\n${resumen}\n\n¿Querés mapear otro documento? Mandame el PDF o escribí <b>no</b> para terminar.`, { parse_mode: "HTML" });
  }

  if (pendingPaginasSinAsignar.size === 1) {
    const [solaUnica] = pendingPaginasSinAsignar;
    setSesion(chatId, { grupoActual: { paginas: [solaUnica] }, fase: "aprender_asignando", filtroActual: null });
    return ctx.reply(
      confirmacion + `Solo queda la página <b>${solaUnica}</b>. ¿A qué requerimiento corresponde?\n\nEscribí parte del nombre para buscar, o <code>lista</code> para verlos todos.\n\n/listo para finalizar el mapeo.`,
      { parse_mode: "HTML" }
    );
  }

  return ctx.reply(confirmacion + msgAgrupar(pendingPaginasSinAsignar), { parse_mode: "HTML" });
}

async function mostrarListaMapeos(ctx, chatId, prefijo = "") {
  const lista = await leerTodosMapeosPorTipo(chatId);
  if (!lista.length) {
    resetSesion(chatId);
    return ctx.reply(prefijo + "No quedan mapeos guardados. Usá /aprender para crear nuevos.", { parse_mode: "HTML" });
  }
  setSesion(chatId, { fase: "mapeos_lista", mapeosList: lista });
  const items = lista.map((m, i) => `${i + 1}. ${escapeHtml(m.nombre)} — ${m.paginas.length} pág.`).join("\n");
  return ctx.reply(
    prefijo + `📚 <b>${lista.length} tipo${lista.length !== 1 ? "s" : ""} aprendido${lista.length !== 1 ? "s" : ""}:</b>\n\n${items}\n\nEscribí el número del que querés revisar, o cualquier comando para salir.`,
    { parse_mode: "HTML" }
  );
}

function msgAgrupar(paginasDisponibles) {
  const lista = [...paginasDisponibles];
  const disponibles = lista.join(", ");
  const ejAgrupar = lista.length >= 2 ? `<code>${lista.slice(0, 2).join(",")}</code> para agrupar · ` : "";
  return (
    `Páginas disponibles: <b>${disponibles}</b>\n\n` +
    `Agrupá páginas para asignarle un requerimiento, o elegí una sola.\n` +
    `ej: ${ejAgrupar}<code>${lista[0]}</code> para elegir sola.\n\n` +
    `/listo para finalizar el mapeo.`
  );
}

async function bajarPdf(ctx) {
  const file = await ctx.getFile();
  const url = `https://api.telegram.org/file/bot${process.env.TG_TOKEN}/${file.file_path}`;
  const res = await fetch(url);
  return Buffer.from(await res.arrayBuffer());
}

async function guardarSesionMapeo(chatId) {
  const sesion = getSesion(chatId);
  const { grupos = [], imagenes = [] } = sesion;
  const asignados = grupos.filter((g) => g.req);
  if (!asignados.length) return null;

  for (const grupo of asignados) {
    const paginasRef = grupo.paginas.map((pNum) => {
      const img = imagenes.find((i) => i.pagina === pNum);
      return { num: pNum, imagen: img?.base64 || "", texto: "" };
    });
    await guardarMapeo(chatId, grupo.req.nombre, {
      paginas: paginasRef,
      href: grupo.req.href,
      entidad: grupo.req.entidad,
    });
  }

  return asignados;
}

// ─── Comandos ─────────────────────────────────────────────────────────────────

bot.command("miid", (ctx) =>
  ctx.reply(`Tu chat ID es: <code>${ctx.chat.id}</code>`, { parse_mode: "HTML" })
);

// /bunn — DESACTIVADO temporalmente (2026-05-30) por decisión de loctime.
// La implementación original entraba al modo delegado (Bunn maneja la conversación
// con Playwright MCP). Quedó comentada abajo para re-habilitación rápida.
// El trigger automático por PDF sigue activo — solo se silencia el comando manual.
bot.command("bunn", async (ctx) => {
  return ctx.reply("Sistema inteligente desactivado temporalmente.");
});

// --- Implementación original (re-habilitar reemplazando el handler de arriba) ---
// bot.command("bunn", async (ctx) => {
//   const chatId = String(ctx.chat.id);
//   const cliente = await cargarCliente(chatId);
//   if (!cliente) return ctx.reply("No tengo tu cuenta registrada. Usá /nuevocliente para arrancar.");
//   const activo = await findActiveDelegated(chatId);
//   if (activo && activo.chatId !== chatId) {
//     return ctx.reply("⏳ Estoy con otro cliente justo ahora. Probá de nuevo en un par de minutos.");
//   }
//   try {
//     await enterDelegated(chatId, {
//       trigger: "/bunn",
//       cliente_nombre: cliente.nombre || "",
//       cd_user: cliente.cdUser || "",
//       cd_pass: cliente.cdPass || "",
//       nombre_empresa: cliente.nombreEmpresa || "",
//     });
//     await appendInbox(chatId, {
//       kind: "text",
//       text: "/bunn — cliente pidió modo libre",
//       meta: {
//         entry: "trigger",
//         cliente_nombre: cliente.nombre || "",
//         cd_user: cliente.cdUser || "",
//         nombre_empresa: cliente.nombreEmpresa || "",
//       },
//     });
//     return ctx.reply("📥 Activando inteligencia flexible, dame un momento y te escribo apenas esté lista para charlar. Cuando termines la conversación escribí /listo.");
//   } catch (e) {
//     console.error("[BUNN COMMAND]", e.message);
//     return ctx.reply(`❌ No pude activar el modo: ${e.message}`);
//   }
// });

bot.command("web", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const cliente = await cargarCliente(chatId);
  if (!cliente) return ctx.reply("No tengo tu cuenta registrada.");
  const token = generarTokenWeb(chatId);
  const webUrl = process.env.WEB_URL || "https://mapeos.controldoc.app";
  return ctx.reply(
    `🌐 <b>Panel de mapeos</b>\n\nHacé click en el link para acceder desde tu computadora:\n<a href="${webUrl}/auth?t=${token}">${webUrl}</a>\n\n⏱ El link expira en 10 minutos.`,
    { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
  );
});

bot.command("modelo", async (ctx) => {
  if (!ADMIN_IDS.includes(String(ctx.chat.id))) return;
  const arg = ctx.match?.trim().toLowerCase();
  if (!arg) {
    return ctx.reply(`🤖 Modelo actual: <b>${getCurrentProviderLabel()}</b>`, { parse_mode: "HTML" });
  }
  if (arg === "gemini") {
    setAiProvider("gemini");
    return ctx.reply(`✅ Cambiado a <b>${getCurrentProviderLabel()}</b>`, { parse_mode: "HTML" });
  }
  if (arg === "claude" || arg === "haiku") {
    setAiProvider("claude");
    return ctx.reply(`✅ Cambiado a <b>${getCurrentProviderLabel()}</b>`, { parse_mode: "HTML" });
  }
  return ctx.reply("❌ Opciones: <code>/modelo claude</code> o <code>/modelo gemini</code>", { parse_mode: "HTML" });
});

// Cache del username del bot para armar deep-links. Lleno bajo demanda.
let _botUsername = null;
async function getBotUsername() {
  if (_botUsername) return _botUsername;
  try {
    const me = await bot.api.getMe();
    _botUsername = me.username;
  } catch (e) {
    console.error("[getBotUsername] error:", e.message);
  }
  return _botUsername;
}

bot.command("nuevocliente", async (ctx) => {
  if (!ADMIN_IDS.includes(String(ctx.chat.id))) return;
  const match = ctx.match?.trim().match(/^(\S+)\s+(\S+)$/);
  if (!match) return ctx.reply("Uso: /nuevocliente NombreApellido CODIGO");
  const nombre = match[1].replace(/([A-Z])/g, " $1").trim().replace(/\b\w/g, (c) => c.toUpperCase());
  const codigo = match[2].trim();

  // El payload de un deep-link de Telegram solo admite [A-Za-z0-9_-] hasta 64 chars.
  const codigoValidoParaLink = /^[A-Za-z0-9_-]{1,64}$/.test(codigo);

  await guardarPendiente(codigo, nombre);

  let respuesta = `✅ Código <code>${codigo}</code> listo para <b>${nombre}</b>.`;
  if (codigoValidoParaLink) {
    const username = await getBotUsername();
    if (username) {
      const link = `https://t.me/${username}?start=${codigo}`;
      const primerNombre = nombre.split(/\s+/)[0] || nombre;
      // Bloque <pre> = Telegram lo muestra como código con "tap para copiar".
      // Pegás el bloque entero en WhatsApp/mail/lo que sea y el link queda funcional.
      const mensajeParaCliente = `Hola ${primerNombre}! 👋 Iniciate en ControlBun y gestioná Control Documentario desde tu celular: verificá vencimientos, subí documentación y consultá tus requerimientos pendientes, todo desde Telegram.\n\n${link}`;
      respuesta += `\n\n📋 Mensaje listo para mandarle (tocá el bloque para copiar):\n<pre>${mensajeParaCliente}</pre>`;
    }
  } else {
    respuesta += `\n\n⚠️ El código tiene caracteres que Telegram no permite en deep-links (solo A-Z, a-z, 0-9, guion y guion bajo, máx 64). El cliente va a tener que escribirlo a mano.`;
  }
  return ctx.reply(respuesta, { parse_mode: "HTML", disable_web_page_preview: true });
});

// /start con payload — usado por el deep-link generado en /nuevocliente.
// Si vino con código, consume el pendiente y registra al cliente directo.
// Si vino sin código, da un mensaje genérico de bienvenida.
bot.command("start", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const payload = (ctx.match || "").trim();

  const yaCliente = await cargarCliente(chatId);
  if (yaCliente) {
    return ctx.reply(`Ya estás registrado como <b>${yaCliente.nombre}</b>. Mandame un PDF o usá /pendientes, /vencimientos, /partemes.`, { parse_mode: "HTML" });
  }

  if (!payload) {
    esperandoCodigo.add(chatId);
    return ctx.reply("Hola 👋 No te conozco todavía. ¿Cuál es tu contraseña de registro?");
  }

  const pendiente = await consumirPendiente(payload);
  if (!pendiente) {
    return ctx.reply("❌ Ese código no es válido o ya fue usado. Pedile uno nuevo a tu administrador.");
  }
  await registrarCliente(chatId, pendiente.nombre);
  esperandoCodigo.delete(chatId);
  return ctx.reply(`¡Bienvenido <b>${pendiente.nombre}</b>! Ahora cargá tus credenciales de control documentario con /config.`, { parse_mode: "HTML" });
});

bot.command("config", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const cliente = await cargarCliente(chatId);
  if (!cliente) return ctx.reply("No tengo tu cuenta registrada.");
  setSesion(chatId, { fase: "config_esperando_user" });
  return ctx.reply(
    "⚙️ Configuración de cuenta de controldocumentario.com\n\nMandame tu <b>usuario de control documentario</b> (email):",
    { parse_mode: "HTML" }
  );
});

bot.command("pendientes", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const cliente = await cargarCliente(chatId);
  if (!cliente) return ctx.reply("No tengo tu cuenta registrada.");
  if (!cliente.cdUser || !cliente.cdPass)
    return ctx.reply("❌ No tenés cuenta configuradas. Usá /config primero.");

  // Cache compartido con Bunn — si está fresco (< 6h) servimos eso.
  const force = (ctx.match || "").trim().toLowerCase() === "force";
  let reqs;
  let fromCache = false;
  if (!force) {
    const cached = readCache(chatId, "pendientes", TTL_PENDIENTES);
    if (cached) {
      reqs = cached.data;
      fromCache = true;
    }
  }

  if (!fromCache) {
    await ctx.reply("⏳ Consultando requerimientos pendientes…");
    try {
      const sesCD = await cdObtenerSesionActiva(chatId, cliente.cdUser, cliente.cdPass);
      if (!sesCD.ok) {
        if (sesCD.screenshot) {
          return ctx.replyWithPhoto(new InputFile(sesCD.screenshot, "login.jpg"), { caption: `❌ ${sesCD.motivo}` });
        }
        return ctx.reply(`❌ ${sesCD.motivo}`);
      }
      reqs = await cdLeerRequerimientos(sesCD.page);
      writeCache(chatId, "pendientes", reqs);
    } catch (e) {
      cdInvalidarSesion(chatId);
      console.error("[PENDIENTES]", e.message);
      return ctx.reply(`❌ Error: ${e.message}`);
    }
  }

  if (!reqs.length)
    return ctx.reply("✅ No hay requerimientos pendientes en CD.");

  const lineas = reqs.map((r, i) => {
    const entidad = r.entidad ? ` — <i>${escapeHtml(r.entidad)}</i>` : "";
    return `${i + 1}. ${escapeHtml(r.nombre)}${entidad}`;
  });

  const tag = "";
  return ctx.reply(
    `📋 <b>${reqs.length} requerimiento${reqs.length !== 1 ? "s" : ""} pendiente${reqs.length !== 1 ? "s" : ""}:</b>${tag}\n\n${lineas.join("\n")}`,
    { parse_mode: "HTML" }
  );
});

bot.command("vencimientos", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const cliente = await cargarCliente(chatId);
  if (!cliente) return ctx.reply("No tengo tu cuenta registrada.");
  if (!cliente.cdUser || !cliente.cdPass)
    return ctx.reply("❌ No tenés credenciales configuradas. Usá /config primero.");

  const diasP = cliente.diasPersonal ?? 10;
  const diasV = cliente.diasVehiculos ?? 10;
  const diasE = cliente.diasEmpresa ?? 10;

  // Cache compartido con Bunn — TTL 48h. `/vencimientos force` salta el cache.
  const force = (ctx.match || "").trim().toLowerCase() === "force";
  let items, screenshotsForReply, fromCache = false;
  if (!force) {
    const cached = readCache(chatId, "vencimientos", TTL_VENCIMIENTOS);
    if (cached) {
      items = recomputarDiasFaltantes(cached.data?.items || []);
      screenshotsForReply = (cached.data?.screenshots || [])
        .filter(s => s?.path)
        .map(s => ({ kind: "path", path: s.path, nombre: s.name }));
      fromCache = true;
    }
  }

  if (!fromCache) {
    await ctx.reply(`🔎 Consultando vencimientos (empresa: ${diasE}d · personal: ${diasP}d · vehículos: ${diasV}d)…`);
    try {
      const sesCD = await cdObtenerSesionActiva(chatId, cliente.cdUser, cliente.cdPass);
      if (!sesCD.ok) {
        if (sesCD.screenshot)
          return ctx.replyWithPhoto(new InputFile(sesCD.screenshot, "login.jpg"), { caption: `❌ ${sesCD.motivo}` });
        return ctx.reply(`❌ ${sesCD.motivo}`);
      }
      const venc = await cdLeerVencimientos(sesCD.page, diasP, diasV, diasE);
      items = venc.items || [];
      const screenshotPaths = saveScreenshots(chatId, "vencimientos", venc.screenshots);
      writeCache(chatId, "vencimientos", { items, screenshots: screenshotPaths });
      // Para la respuesta de este turno usamos buffers que ya tenemos en memoria (más rápido que releer disco).
      screenshotsForReply = (venc.screenshots || []).map(ss => ({ kind: "buffer", buffer: ss.buffer, nombre: ss.nombre }));
    } catch (e) {
      cdInvalidarSesion(chatId);
      console.error("[VENCIMIENTOS]", e.message);
      return ctx.reply(`❌ Error: ${e.message}`);
    }
  }

  const tag = "";

  // /vencimientos solo muestra los PRÓXIMOS a vencer (diasFaltantes >= 0).
  // Los vencidos (< 0) se ven con /vencidos.
  const proximos = (items || []).filter(i => i.diasFaltantes >= 0);

  if (!proximos.length) {
    const umbralMsg = (diasE === diasP && diasP === diasV)
      ? `los próximos ${diasE} días`
      : `los próximos días (empresa ${diasE}d · personal ${diasP}d · vehículos ${diasV}d)`;
    await ctx.reply(
      `✅ No tenés vencimientos en ${umbralMsg}.${tag}`,
      { parse_mode: "HTML" }
    );
  } else {
    const chunks = [..._chunksVenc(_buildMsgVencimientos(proximos, diasP, diasV, diasE))];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i] + (i === 0 ? tag : "");
      await ctx.reply(chunk, { parse_mode: "HTML" });
    }
  }

  for (const ss of screenshotsForReply || []) {
    const input = ss.kind === "buffer" ? new InputFile(ss.buffer, ss.nombre) : new InputFile(ss.path, ss.nombre);
    await ctx.replyWithPhoto(input);
  }
});

bot.command("vencidos", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const cliente = await cargarCliente(chatId);
  if (!cliente) return ctx.reply("No tengo tu cuenta registrada.");
  if (!cliente.cdUser || !cliente.cdPass)
    return ctx.reply("❌ No tenés credenciales configuradas. Usá /config primero.");

  // Reusa el mismo cache que /vencimientos (cdLeerVencimientos devuelve todo, vencidos + próximos).
  const diasP = cliente.diasPersonal ?? 10;
  const diasV = cliente.diasVehiculos ?? 10;
  const diasE = cliente.diasEmpresa ?? 10;

  const force = (ctx.match || "").trim().toLowerCase() === "force";
  let items, fromCache = false;
  if (!force) {
    const cached = readCache(chatId, "vencimientos", TTL_VENCIMIENTOS);
    if (cached) { items = recomputarDiasFaltantes(cached.data?.items || []); fromCache = true; }
  }

  if (!fromCache) {
    await ctx.reply(`🔎 Consultando vencidos…`);
    try {
      const sesCD = await cdObtenerSesionActiva(chatId, cliente.cdUser, cliente.cdPass);
      if (!sesCD.ok) {
        if (sesCD.screenshot)
          return ctx.replyWithPhoto(new InputFile(sesCD.screenshot, "login.jpg"), { caption: `❌ ${sesCD.motivo}` });
        return ctx.reply(`❌ ${sesCD.motivo}`);
      }
      const venc = await cdLeerVencimientos(sesCD.page, diasP, diasV, diasE);
      items = venc.items || [];
      const screenshotPaths = saveScreenshots(chatId, "vencimientos", venc.screenshots);
      writeCache(chatId, "vencimientos", { items, screenshots: screenshotPaths });
    } catch (e) {
      cdInvalidarSesion(chatId);
      console.error("[VENCIDOS]", e.message);
      return ctx.reply(`❌ Error: ${e.message}`);
    }
  }

  const tag = "";
  const vencidos = (items || []).filter(i => i.diasFaltantes < 0);

  if (!vencidos.length) {
    return ctx.reply(`✅ No tenés vencimientos atrasados.${tag}`, { parse_mode: "HTML" });
  }
  const chunks = [..._chunksVenc(_buildMsgVencidos(vencidos))];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i] + (i === 0 ? tag : "");
    await ctx.reply(chunk, { parse_mode: "HTML" });
  }
});

bot.command("aprender", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const cliente = await cargarCliente(chatId);
  if (!cliente) return ctx.reply("No tengo tu cuenta registrada.");
  if (!cliente.cdUser || !cliente.cdPass)
    return ctx.reply("❌ No tenés credenciales de CD configuradas. Contactá al administrador.");

  await ctx.reply("⏳ Conectando a controldocumentario.com…");

  try {
    const sesion = await cdObtenerSesionActiva(chatId, cliente.cdUser, cliente.cdPass);
    if (!sesion.ok) {
      if (sesion.screenshot) {
        await ctx.replyWithPhoto(new InputFile(sesion.screenshot, "login.jpg"), { caption: `❌ ${sesion.motivo}` });
      } else {
        await ctx.reply(`❌ ${sesion.motivo}`);
      }
      return;
    }

    const nombres = await cdLeerTiposRequerimientos(sesion.page);

    if (!nombres.length)
      return ctx.reply("No encontré tipos de requerimientos en tu cuenta de CD.");

    const tiposUnicos = nombres.map((nombre) => ({ nombre, entidad: "", href: "" }));
    setSesion(chatId, { fase: "aprender_esperando_pdf", requerimientos: tiposUnicos });

    const mapeosYa = await leerTodosMapeosPorTipo(chatId);
    if (mapeosYa.length > 0) {
      const lista = mapeosYa.map((m) => `• ${escapeHtml(m.nombre)} (${m.paginas.length} pág.)`).join("\n");
      await ctx.reply(
        `📚 Ya tenés <b>${mapeosYa.length}</b> tipo${mapeosYa.length !== 1 ? "s" : ""} aprendido${mapeosYa.length !== 1 ? "s" : ""}:\n\n${lista}\n\n💡 Si querés revisar, editar o eliminar alguno, usá /mapeos antes de continuar.`,
        { parse_mode: "HTML" }
      );
    }

    return ctx.reply(
      `✅ ${tiposUnicos.length} tipo${tiposUnicos.length !== 1 ? "s" : ""} de requerimiento encontrado${tiposUnicos.length !== 1 ? "s" : ""}.\n\nMandame el PDF de referencia para agregar o actualizar un tipo de documento.`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    cdInvalidarSesion(chatId);
    console.error("[APRENDER]", e.message);
    return ctx.reply(`❌ Error conectando a CD: ${e.message}`);
  }
});

bot.command("mapeos", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const cliente = await cargarCliente(chatId);
  if (!cliente) return ctx.reply("No tengo tu cuenta registrada.");
  return mostrarListaMapeos(ctx, chatId);
});

bot.command("generar", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const cliente = await cargarCliente(chatId);
  if (!cliente) return ctx.reply("No tengo tu cuenta registrada.");
  if (!cliente.cdUser || !cliente.cdPass)
    return ctx.reply("❌ No tenés credenciales configuradas. Usá /config primero.");

  await ctx.reply("⏳ Consultando tipos de requerimientos…");
  try {
    const sesCD = await cdObtenerSesionActiva(chatId, cliente.cdUser, cliente.cdPass);
    if (!sesCD.ok) {
      if (sesCD.screenshot)
        return ctx.replyWithPhoto(new InputFile(sesCD.screenshot, "login.jpg"), { caption: `❌ ${sesCD.motivo}` });
      return ctx.reply(`❌ ${sesCD.motivo}`);
    }

    const tipos = await cdLeerTiposRequerimientos(sesCD.page);
    if (!tipos.length)
      return ctx.reply("No encontré tipos de requerimientos en CD.");

    // tipos is a flat array of strings (req names)
    const lista = tipos.map((nombre) => ({ nombre }));
    setSesion(chatId, { fase: "generar_buscando", lista, filtroActual: null, cdUser: cliente.cdUser, cdPass: cliente.cdPass });

    const lineas = lista.slice(0, 20).map((r, i) => `${i + 1}. ${escapeHtml(r.nombre)}`);
    if (lista.length > 20) lineas.push(`\n<i>... y ${lista.length - 20} más. Escribí parte del nombre para filtrar.</i>`);
    return ctx.reply(
      `📋 <b>${lista.length} tipo${lista.length !== 1 ? "s" : ""} de requerimiento${lista.length !== 1 ? "s" : ""}:</b>\n\n${lineas.join("\n")}\n\nEscribí el número o parte del nombre para buscar.`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    cdInvalidarSesion(chatId);
    console.error("[GENERAR-CMD]", e.message);
    return ctx.reply(`❌ Error: ${e.message}`);
  }
});

bot.command("unico", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const cliente = await cargarCliente(chatId);
  if (!cliente) return ctx.reply("No tengo tu cuenta registrada.");
  if (!cliente.cdUser || !cliente.cdPass)
    return ctx.reply("❌ No tenés credenciales configuradas. Usá /config primero.");
  setSesion(chatId, { fase: "unico_esperando_pdf" });
  return ctx.reply("📎 Modo único activado. Mandame el PDF a subir.");
});

bot.command("partemes", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const cliente = await cargarCliente(chatId);
  if (!cliente) return ctx.reply("No tengo tu cuenta registrada.");
  if (!cliente.cdUser || !cliente.cdPass)
    return ctx.reply("❌ No tenés credenciales configuradas. Usá /config primero.");

  await ctx.reply("⏳ Grabando parte mensual…");
  try {
    const sesCD = await cdObtenerSesionActiva(chatId, cliente.cdUser, cliente.cdPass);
    if (!sesCD.ok) {
      if (sesCD.screenshot)
        return ctx.replyWithPhoto(new InputFile(sesCD.screenshot, "login.jpg"), { caption: `❌ ${sesCD.motivo}` });
      return ctx.reply(`❌ ${sesCD.motivo}`);
    }
    const { personal, maquinas } = await cdGrabarParteMensual(sesCD.page);
    invalidateCache(chatId);  // parte mensual genera requerimientos/cumple vencimientos: invalida ambos
    return ctx.reply(_msgParteMensual(personal, maquinas), { parse_mode: "HTML" });
  } catch (e) {
    cdInvalidarSesion(chatId);
    console.error("[PARTEMES]", e.message);
    return ctx.reply(`❌ Error grabando parte mensual: ${e.message}`);
  }
});

bot.command("estado", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const cliente = await cargarCliente(chatId);
  if (!cliente) return ctx.reply("No tengo tu cuenta registrada.");

  const mapeos = await leerTodosMapeosPorTipo(chatId);
  const cuentaCD = cliente.cdUser
    ? `✅ <code>${escapeHtml(cliente.cdUser)}</code>`
    : "❌ No configurada — usá /config";

  return ctx.reply(
    `👤 <b>${escapeHtml(cliente.nombre)}</b>\n\nCuenta CD: ${cuentaCD}\nMapeos aprendidos: <b>${mapeos.length}</b>`,
    { parse_mode: "HTML" }
  );
});

bot.command("listo", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const sesion = getSesion(chatId);
  if (sesion.fase !== "aprender_agrupando") return;

  const asignados = await guardarSesionMapeo(chatId);
  if (!asignados) {
    resetSesion(chatId);
    return ctx.reply("No quedó ningún grupo asignado. Empezá de nuevo con /aprender.");
  }

  const resumen = asignados
    .map(
      (g) =>
        `• <b>${escapeHtml(g.req.nombre)}</b>${g.req.entidad ? ` (${escapeHtml(g.req.entidad)})` : ""} → ${g.paginas.length} pág.`
    )
    .join("\n");

  const sinAsignar = sesion.paginasSinAsignar?.size || 0;
  const nota = sinAsignar > 0 ? `\n\n⚠️ ${sinAsignar} página${sinAsignar !== 1 ? "s" : ""} sin mappear.` : "";

  setSesion(chatId, { fase: "aprender_preguntando_mas", grupos: [], imagenes: [], paginasSinAsignar: new Set() });
  return ctx.reply(`✅ Mapeo guardado:\n\n${resumen}${nota}\n\n¿Querés mapear otro documento? Mandame el PDF o escribí <b>no</b> para terminar.`, { parse_mode: "HTML" });
});

// ─── Manejador principal ──────────────────────────────────────────────────────

bot.on("message", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const texto = (ctx.message.text || "").trim();
  const sesion = getSesion(chatId);

  // ── PDF recibido ──
  if (ctx.message.document?.mime_type === "application/pdf") {
    const cliente = await cargarCliente(chatId);
    if (!cliente) return ctx.reply("No te conozco. ¿Contraseña?");

    // Mapeos: reemplazar referencia de un mapeo existente
    if (sesion.fase === "mapeos_reemplazando_pdf") {
      const { mapeoActual } = sesion;
      await ctx.reply("📄 Renderizando páginas de referencia…");
      try {
        const buffer = await bajarPdf(ctx);
        const imagenes = await pdfAImagenes(buffer);

        for (const { pagina, base64 } of imagenes) {
          await ctx.replyWithPhoto(new InputFile(Buffer.from(base64, "base64"), `p${pagina}.jpg`), {
            caption: `Página ${pagina}`,
          });
        }

        if (imagenes.length === 1) {
          const bruto = await leerMapeoBruto(chatId, mapeoActual.nombre);
          await guardarMapeo(chatId, mapeoActual.nombre, {
            paginas: [{ num: 1, imagen: imagenes[0].base64, texto: "" }],
            href: bruto?.href || "",
            entidad: bruto?.entidad || "",
          });
          return await mostrarListaMapeos(ctx, chatId, `✅ "<b>${escapeHtml(mapeoActual.nombre)}</b>" actualizado con 1 página.\n\n`);
        }

        const nums = imagenes.map((i) => i.pagina).join(", ");
        setSesion(chatId, { fase: "mapeos_reemplazando_paginas", imagenes });
        return ctx.reply(
          `✅ ${imagenes.length} páginas listas: <b>${nums}</b>\n\n¿Cuáles van en "<b>${escapeHtml(mapeoActual.nombre)}</b>"?\nEscribí los números separados por coma, o <code>todas</code>.`,
          { parse_mode: "HTML" }
        );
      } catch (e) {
        resetSesion(chatId);
        return ctx.reply(`❌ Error renderizando: ${e.message}`);
      }
    }

    // Aprender: PDF nuevo como referencia para requerimiento conflictivo
    if (sesion.fase === "aprender_overwrite_nuevo_pdf") {
      const { pendingConflictosReqs } = sesion;
      await ctx.reply("📄 Renderizando páginas de referencia…");
      try {
        const buffer = await bajarPdf(ctx);
        const imagenes = await pdfAImagenes(buffer);

        for (const { pagina, base64 } of imagenes) {
          await ctx.replyWithPhoto(new InputFile(Buffer.from(base64, "base64"), `p${pagina}.jpg`), { caption: `Página ${pagina}` });
        }

        if (imagenes.length === 1) {
          for (const req of pendingConflictosReqs) {
            const bruto = await leerMapeoBruto(chatId, req.nombre);
            await guardarMapeo(chatId, req.nombre, { paginas: [{ num: 1, imagen: imagenes[0].base64, texto: "" }], href: bruto?.href || req.href || "", entidad: bruto?.entidad || req.entidad || "" });
          }
          return continuarAprendiendoDesdeConflicto(ctx, chatId);
        }

        const nums = imagenes.map((i) => i.pagina).join(", ");
        const nombres = pendingConflictosReqs.map((r) => `"${escapeHtml(r.nombre)}"`).join(", ");
        setSesion(chatId, { fase: "aprender_overwrite_nuevo_paginas", imagenes });
        return ctx.reply(
          `✅ ${imagenes.length} páginas listas: <b>${nums}</b>\n\n¿Cuáles van en ${nombres}?\nEscribí los números separados por coma, o <code>todas</code>.`,
          { parse_mode: "HTML" }
        );
      } catch (e) {
        return ctx.reply(`❌ Error renderizando: ${e.message}`);
      }
    }

    // Modo único: subir PDF sin procesar
    if (sesion.fase === "unico_esperando_pdf") {
      await ctx.reply("⏳ Cargando requerimientos de CD…");
      try {
        const buffer = await bajarPdf(ctx);
        const sesCD = await cdObtenerSesionActiva(chatId, cliente.cdUser, cliente.cdPass);
        if (!sesCD.ok) {
          resetSesion(chatId);
          if (sesCD.screenshot) {
            return ctx.replyWithPhoto(new InputFile(sesCD.screenshot, "login.jpg"), { caption: `❌ ${sesCD.motivo}` });
          }
          return ctx.reply(`❌ ${sesCD.motivo}`);
        }
        const reqs = await cdLeerRequerimientos(sesCD.page);
        if (!reqs.length) {
          resetSesion(chatId);
          return ctx.reply("No hay requerimientos pendientes en CD.");
        }
        setSesion(chatId, { fase: "unico_buscando_req", buffer, requerimientos: reqs, filtroActual: null, cdUser: cliente.cdUser, cdPass: cliente.cdPass });
        return ctx.reply(
          `📋 ${reqs.length} requerimiento${reqs.length !== 1 ? "s" : ""} pendiente${reqs.length !== 1 ? "s" : ""}.\n\n${formatearReqs(reqs)}\n\nEscribí el nombre o parte para buscar, o <code>lista</code> para verlos todos.`,
          { parse_mode: "HTML" }
        );
      } catch (e) {
        cdInvalidarSesion(chatId);
        resetSesion(chatId);
        return ctx.reply(`❌ Error: ${e.message}`);
      }
    }

    // Aprender: PDF de referencia (primera vez o tras guardar)
    if (sesion.fase === "aprender_esperando_pdf" || sesion.fase === "aprender_preguntando_mas") {
      await ctx.reply("📄 Renderizando páginas de referencia…");
      try {
        const buffer = await bajarPdf(ctx);
        const imagenes = await pdfAImagenes(buffer);

        for (const { pagina, base64 } of imagenes) {
          await ctx.replyWithPhoto(new InputFile(Buffer.from(base64, "base64"), `p${pagina}.jpg`), {
            caption: `Página ${pagina}`,
          });
        }

        const todasLasPaginas = new Set(imagenes.map((i) => i.pagina));

        if (imagenes.length === 1) {
          setSesion(chatId, { fase: "aprender_asignando", buffer, imagenes, grupos: [], paginasSinAsignar: todasLasPaginas, grupoActual: { paginas: [1] }, filtroActual: null });
          return ctx.reply(
            ` 1 página lista.\n\n¿A qué requerimiento corresponde?\n\nEscrib parte del nombre para buscar, o <code>lista</code> para verlos todos.\n\n/listo para finalizar.`,
            { parse_mode: "HTML" }
          );
        }

        setSesion(chatId, { fase: "aprender_agrupando", buffer, imagenes, grupos: [], paginasSinAsignar: todasLasPaginas });
        return ctx.reply(` ${imagenes.length} páginas listas.\n\n` + msgAgrupar(todasLasPaginas), { parse_mode: "HTML" });
        return ctx.reply(`✅ ${imagenes.length} páginas listas.\n\n` + msgAgrupar(todasLasPaginas), { parse_mode: "HTML" });
      } catch (e) {
        console.error("[PDF ERROR]", e.message);
        return ctx.reply(`❌ Error renderizando: ${e.message}`);
      }
    }

    // ── PDF sin fase específica → DESACTIVADO temporalmente (2026-05-31) ──
    // Antes el PDF se delegaba a Bunn (modo "inteligencia flexible"). Quedó
    // desactivado por decisión de loctime junto con el comando /bunn (ver
    // arriba bot.command("bunn", ...)). El código original quedó comentado
    // abajo para rehabilitar rápido.
    return ctx.reply(
      "📄 Recibí el PDF, pero el modo inteligente está desactivado temporalmente.\n\n" +
      "Por ahora podés subir un documento puntual con /unico (elegís el requerimiento y mandás el PDF)."
    );

    // --- Implementación original (re-habilitar reemplazando el return de arriba) ---
    // try {
    //   const activo = await findActiveDelegated(chatId);
    //   if (activo && activo.chatId !== chatId) {
    //     const minsAtendiendo = Math.round(activo.age_ms / 60000);
    //     const nombreOtro = activo.cliente_nombre || "otro cliente";
    //     console.log(`[PORTERO] Rechazo PDF de ${chatId} — Bunn atendiendo a ${activo.chatId} (${nombreOtro}) hace ${minsAtendiendo}min`);
    //     return ctx.reply(
    //       `⏳ Estoy con otro cliente justo ahora. Mandame el PDF de nuevo en un par de minutos y lo agarro.`
    //     );
    //   }
    //
    //   const buffer = await bajarPdf(ctx);
    //   const filename = ctx.message.document.file_name || "doc.pdf";
    //   const file = await saveUpload(chatId, buffer, filename);
    //   await enterDelegated(chatId, {
    //     trigger: "pdf",
    //     trigger_file: file,
    //     original_filename: filename,
    //     cliente_nombre: cliente.nombre || "",
    //     cd_user: cliente.cdUser || "",
    //     cd_pass: cliente.cdPass || "",
    //     nombre_empresa: cliente.nombreEmpresa || "",
    //   });
    //   await appendInbox(chatId, {
    //     kind: "pdf",
    //     file,
    //     original_filename: filename,
    //     text: ctx.message.caption || "",
    //     meta: {
    //       entry: "trigger",
    //       cliente_nombre: cliente.nombre || "",
    //       cd_user: cliente.cdUser || "",
    //       nombre_empresa: cliente.nombreEmpresa || "",
    //     },
    //   });
    //   return ctx.reply("📥 Recibí el PDF. Activando inteligencia flexible, dame un momento…");
    // } catch (e) {
    //   console.error("[DELEGADO TRIGGER]", e.message);
    //   return ctx.reply(`❌ No pude guardar el PDF: ${e.message}`);
    // }
  }

  // ── Config: esperando usuario de CD ──
  if (sesion.fase === "config_esperando_user" && texto && !texto.startsWith("/")) {
    setSesion(chatId, { fase: "config_esperando_pass", cdUserTemp: texto });
    return ctx.reply("Ahora mandame la <b>contraseña de control documentario</b>:", { parse_mode: "HTML" });
  }

  // ── Config: esperando contraseña de CD ──
  if (sesion.fase === "config_esperando_pass" && texto && !texto.startsWith("/")) {
    const cdUser = sesion.cdUserTemp;
    const cdPass = texto;
    await ctx.reply("⏳ Probando credenciales…");

    try {
      // Invalidar sesión cacheada — credenciales nuevas requieren login fresco
      cdInvalidarSesion(chatId);
      const sesion = await cdObtenerSesionActiva(chatId, cdUser, cdPass);

      if (!sesion.ok) {
        resetSesion(chatId);
        if (sesion.screenshot) {
          await ctx.replyWithPhoto(new InputFile(sesion.screenshot, "login.jpg"), {
            caption: `❌ ${sesion.motivo}\n\nUsá /config para intentar de nuevo.`,
          });
        } else {
          await ctx.reply(`❌ ${sesion.motivo}\n\nUsá /config para intentar de nuevo.`);
        }
        return;
      }

      await actualizarCliente(chatId, { cdUser, cdPass });

      // Intentar detectar el nombre de la empresa automáticamente
      const nombreDetectado = await cdDetectarNombreEmpresa(sesion.page);
      if (nombreDetectado) {
        await actualizarCliente(chatId, { nombreEmpresa: nombreDetectado });
        resetSesion(chatId);
        return ctx.reply(
          `✅ Credenciales guardadas.\n\nDetecté que tu empresa es: <b>${escapeHtml(nombreDetectado)}</b>\n\nEste nombre se usará para distinguir documentos de empresa de los personales. Si es incorrecto, mandá el nombre correcto ahora o escribí <code>ok</code> para continuar.`,
          { parse_mode: "HTML" }
        );
        // La sesión se resetea pero si el usuario responde con el nombre correcto no habrá fase activa
        // — se maneja en el bloque de texto libre abajo
      }

      setSesion(chatId, { fase: "config_esperando_empresa", cdUser, cdPass });
      return ctx.reply(
        `✅ Credenciales guardadas.\n\n¿Cuál es el <b>nombre de tu empresa</b> tal como aparece en los documentos? (ej: "MATESIN, CLAUDIO FABIAN")\n\nEscribí el nombre o <code>omitir</code> si no querés configurarlo ahora.`,
        { parse_mode: "HTML" }
      );
    } catch (e) {
      cdInvalidarSesion(chatId);
      resetSesion(chatId);
      return ctx.reply(`❌ Error probando credenciales: ${e.message}\n\nUsá /config para intentar de nuevo.`);
    }
  }

  // ── Config: esperando nombre de empresa ──
  if (sesion.fase === "config_esperando_empresa" && texto && !texto.startsWith("/")) {
    if (!/^omitir$/i.test(texto)) {
      await actualizarCliente(chatId, { nombreEmpresa: texto.trim() });
    }
    resetSesion(chatId);
    return ctx.reply("✅ Listo. Ya podés usar /aprender.");
  }

  // ── Aprender: agrupando páginas ──
  if (sesion.fase === "aprender_agrupando" && texto && !texto.startsWith("/")) {
    const nums = texto
      .split(",")
      .map((s) => parseInt(s.trim()))
      .filter((n) => !isNaN(n));

    if (!nums.length)
      return ctx.reply("Escribí los números de página separados por coma, ej: <code>1,2</code>", {
        parse_mode: "HTML",
      });

    const invalidas = nums.filter((n) => !sesion.paginasSinAsignar.has(n));
    if (invalidas.length)
      return ctx.reply(
        `❌ Página${invalidas.length > 1 ? "s" : ""} no disponible${invalidas.length > 1 ? "s" : ""}: ${invalidas.join(", ")}. Disponibles: ${[...sesion.paginasSinAsignar].join(", ")}`
      );

    setSesion(chatId, { grupoActual: { paginas: nums }, fase: "aprender_asignando", filtroActual: null });

    return ctx.reply(
      `✅ Grupo: páginas <b>${nums.join(", ")}</b>\n\n¿A qué requerimiento corresponde?\n\nEscribí algo para buscar en la lista, o <code>lista</code> para verla completa.\n\n/listo para finalizar el mapeo.`,
      { parse_mode: "HTML" }
    );
  }

  // ── Aprender: asignando requerimiento(s) ──
  if (sesion.fase === "aprender_asignando" && texto && !texto.startsWith("/")) {
    const listaActual = sesion.filtroActual || sesion.requerimientos;

    // "lista" → mostrar todo paginado
    if (texto.toLowerCase() === "lista") {
      setSesion(chatId, { filtroActual: sesion.requerimientos });
      return ctx.reply(
        `📋 ${sesion.requerimientos.length} requerimientos:\n\n${formatearReqs(sesion.requerimientos)}\n\nEscribí un número para seleccionar, o texto para seguir filtrando.\n\n/listo para finalizar el mapeo.`,
        { parse_mode: "HTML" }
      );
    }

    // Texto no numérico → buscar en la lista completa
    const esNumerico = /^[\d,\s]+$/.test(texto);
    if (!esNumerico) {
      const filtro = texto.toLowerCase();
      const filtrados = sesion.requerimientos.filter((r) => r.nombre.toLowerCase().includes(filtro));
      if (!filtrados.length)
        return ctx.reply(`No encontré nada con "<b>${escapeHtml(texto)}</b>". Probá con otra palabra, o escribí <code>lista</code> para verlos todos.\n\n/listo para finalizar el mapeo.`, { parse_mode: "HTML" });
      setSesion(chatId, { filtroActual: filtrados });
      return ctx.reply(
        `🔍 ${filtrados.length} resultado${filtrados.length !== 1 ? "s" : ""}:\n\n${formatearReqs(filtrados, { mostrarTodos: true })}\n\nEscribí el número para seleccionar.\n\n/listo para finalizar el mapeo.`,
        { parse_mode: "HTML" }
      );
    }

    const idxs = texto.split(",").map((s) => parseInt(s.trim()) - 1).filter((n) => !isNaN(n));
    const invalidos = idxs.filter((i) => i < 0 || i >= listaActual.length);
    if (!idxs.length || invalidos.length)
      return ctx.reply(`Escribí un número del 1 al ${listaActual.length}, o texto para buscar.`, { parse_mode: "HTML" });

    const reqsElegidos = idxs.map((i) => listaActual[i]);

    // Detectar si algún req seleccionado ya tiene mapeo guardado
    const mapeosExistentes = await leerTodosMapeosPorTipo(chatId);
    const conflictos = reqsElegidos
      .map((req) => ({ req, mapeo: mapeosExistentes.find((m) => baseNombreReq(m.nombre) === baseNombreReq(req.nombre)) }))
      .filter((c) => c.mapeo);

    if (conflictos.length) {
      const paginasSinAsignarPending = new Set(sesion.paginasSinAsignar);
      sesion.grupoActual.paginas.forEach((p) => paginasSinAsignarPending.delete(p));
      const gruposPending = [...(sesion.grupos || []), ...reqsElegidos.map((req) => ({ ...sesion.grupoActual, req }))];
      const nombresConflicto = conflictos.map((c) => `<b>${escapeHtml(c.req.nombre)}</b>`).join(", ");
      const nombresReqsPending = reqsElegidos.map((r) => `<b>${escapeHtml(r.nombre)}</b>${r.entidad ? ` (${escapeHtml(r.entidad)})` : ""}`).join(" y ");

      setSesion(chatId, {
        fase: "aprender_confirmando_overwrite",
        pendingGrupos: gruposPending,
        pendingPaginasSinAsignar: paginasSinAsignarPending,
        pendingNombresReqs: nombresReqsPending,
        pendingGrupoActual: sesion.grupoActual,
        pendingConflictosReqs: conflictos.map((c) => c.req),
      });

      for (const { req, mapeo } of conflictos) {
        if (mapeo.paginas?.[0]?.imagen) {
          await ctx.replyWithPhoto(
            new InputFile(Buffer.from(mapeo.paginas[0].imagen, "base64"), "referencia.jpg"),
            { caption: `📌 "${escapeHtml(req.nombre)}" — ejemplo guardado (${mapeo.paginas.length} pág.)` }
          );
        }
      }

      return ctx.reply(
        `⚠️ ${nombresConflicto} ya ${conflictos.length === 1 ? "tiene" : "tienen"} un ejemplo guardado (imagen arriba).\n\n¿Qué querés hacer?\n<b>sí</b> — reemplazar con las páginas que elegiste\n<b>no</b> — elegir otro requerimiento para estas páginas\n<b>otro</b> — subir un PDF diferente como referencia\n/mapeos — gestionar todos tus mapeos guardados\n\n/listo para finalizar el mapeo.`,
        { parse_mode: "HTML" }
      );
    }

    const nuevosGrupos = reqsElegidos.map((req) => ({ ...sesion.grupoActual, req }));
    const grupos = [...(sesion.grupos || []), ...nuevosGrupos];

    const paginasSinAsignar = new Set(sesion.paginasSinAsignar);
    sesion.grupoActual.paginas.forEach((p) => paginasSinAsignar.delete(p));

    setSesion(chatId, { grupos, paginasSinAsignar, grupoActual: null, fase: "aprender_agrupando" });

    const nombresReqs = reqsElegidos
      .map((r) => `<b>${escapeHtml(r.nombre)}</b>${r.entidad ? ` (${escapeHtml(r.entidad)})` : ""}`)
      .join(" y ");

    // Si se mapearon todas las páginas, guardar y preguntar si continúa
    if (!paginasSinAsignar.size) {
      const asignados = await guardarSesionMapeo(chatId);
      const resumen = asignados
        .map((g) => `• <b>${escapeHtml(g.req.nombre)}</b>${g.req.entidad ? ` (${escapeHtml(g.req.entidad)})` : ""} → ${g.paginas.length} pág.`)
        .join("\n");
      setSesion(chatId, { fase: "aprender_preguntando_mas", grupos: [], imagenes: [], paginasSinAsignar: new Set() });
      return ctx.reply(`✅ ${nombresReqs} = páginas ${sesion.grupoActual.paginas.join(", ")}\n\nTodas las páginas mapeadas. Mapeo guardado:\n\n${resumen}\n\n¿Querés mapear otro documento? Mandame el PDF o escribí <b>no</b> para terminar.`, {
        parse_mode: "HTML",
      });
    }

    const confirmacion = `✅ ${nombresReqs} = páginas ${sesion.grupoActual.paginas.join(", ")}\n\n`;

    if (paginasSinAsignar.size === 1) {
      const [solaUnica] = paginasSinAsignar;
      setSesion(chatId, { grupoActual: { paginas: [solaUnica] }, fase: "aprender_asignando", filtroActual: null });
      return ctx.reply(
        confirmacion + `Solo queda la página <b>${solaUnica}</b>. ¿A qué requerimiento corresponde?\n\nEscribí parte del nombre para buscar, o <code>lista</code> para verlos todos.\n\n/listo para finalizar el mapeo.`,
        { parse_mode: "HTML" }
      );
    }

    return ctx.reply(confirmacion + msgAgrupar(paginasSinAsignar), { parse_mode: "HTML" });
  }

  // ── Aprender: preguntando si mapear otro documento ──
  if (sesion.fase === "aprender_preguntando_mas" && texto && !texto.startsWith("/")) {
    resetSesion(chatId);
    return ctx.reply("¡Listo! Podés usar /aprender cuando quieras agregar más documentos.");
  }

  // ── Mapeos: seleccionando de la lista ──
  if (sesion.fase === "mapeos_lista" && texto && !texto.startsWith("/")) {
    const idx = parseInt(texto.trim()) - 1;
    if (isNaN(idx) || idx < 0 || idx >= sesion.mapeosList.length)
      return ctx.reply(`Escribí un número del 1 al ${sesion.mapeosList.length}.`);

    const mapeo = sesion.mapeosList[idx];
    setSesion(chatId, { fase: "mapeos_viendo", mapeoActual: mapeo });

    for (const pag of mapeo.paginas) {
      await ctx.replyWithPhoto(
        new InputFile(Buffer.from(pag.imagen, "base64"), `ref${pag.num}.jpg`),
        { caption: `Página ${pag.num} de referencia` }
      );
    }

    return ctx.reply(
      `📌 <b>${escapeHtml(mapeo.nombre)}</b> — ${mapeo.paginas.length} pág.\n\n¿Qué querés hacer?\n<code>reemplazar</code> — subir nuevo PDF de referencia\n<code>eliminar</code> — borrar este mapeo\n<code>cancelar</code> — volver a la lista`,
      { parse_mode: "HTML" }
    );
  }

  // ── Mapeos: acción sobre mapeo seleccionado ──
  if (sesion.fase === "mapeos_viendo" && texto && !texto.startsWith("/")) {
    const accion = texto.toLowerCase().trim();

    if (accion === "cancelar") {
      return mostrarListaMapeos(ctx, chatId);
    }

    if (accion === "eliminar") {
      setSesion(chatId, { fase: "mapeos_confirmando_eliminar" });
      return ctx.reply(
        `⚠️ ¿Seguro que querés eliminar "<b>${escapeHtml(sesion.mapeoActual.nombre)}</b>"? (sí / no)`,
        { parse_mode: "HTML" }
      );
    }

    if (accion === "reemplazar") {
      setSesion(chatId, { fase: "mapeos_reemplazando_pdf" });
      return ctx.reply(
        `📎 Mandame el nuevo PDF de referencia para "<b>${escapeHtml(sesion.mapeoActual.nombre)}</b>".`,
        { parse_mode: "HTML" }
      );
    }

    return ctx.reply(`Escribí <code>reemplazar</code>, <code>eliminar</code> o <code>cancelar</code>.`, { parse_mode: "HTML" });
  }

  // ── Mapeos: confirmando eliminación ──
  if (sesion.fase === "mapeos_confirmando_eliminar" && texto && !texto.startsWith("/")) {
    if (!/^s[ií]/i.test(texto) && texto.toLowerCase() !== "ok") {
      setSesion(chatId, { fase: "mapeos_viendo" });
      return ctx.reply(
        `Cancelado. ¿Qué querés hacer con "<b>${escapeHtml(sesion.mapeoActual.nombre)}</b>"?\n<code>reemplazar</code> / <code>eliminar</code> / <code>cancelar</code>`,
        { parse_mode: "HTML" }
      );
    }
    const nombre = sesion.mapeoActual.nombre;
    await eliminarMapeo(chatId, nombre);
    return await mostrarListaMapeos(ctx, chatId, `✅ "<b>${escapeHtml(nombre)}</b>" eliminado.\n\n`);
  }

  // ── Mapeos: eligiendo páginas para reemplazar ──
  if (sesion.fase === "mapeos_reemplazando_paginas" && texto && !texto.startsWith("/")) {
    const { imagenes, mapeoActual } = sesion;

    let paginasElegidas;
    if (texto.toLowerCase().trim() === "todas") {
      paginasElegidas = imagenes.map((i) => i.pagina);
    } else {
      const nums = texto.split(",").map((s) => parseInt(s.trim())).filter((n) => !isNaN(n));
      const invalidas = nums.filter((n) => !imagenes.find((i) => i.pagina === n));
      if (!nums.length || invalidas.length)
        return ctx.reply(`Páginas disponibles: ${imagenes.map((i) => i.pagina).join(", ")}. Escribí los números o <code>todas</code>.`, { parse_mode: "HTML" });
      paginasElegidas = nums;
    }

    const paginasRef = paginasElegidas.map((num) => {
      const img = imagenes.find((i) => i.pagina === num);
      return { num, imagen: img.base64, texto: "" };
    });

    const bruto = await leerMapeoBruto(chatId, mapeoActual.nombre);
    await guardarMapeo(chatId, mapeoActual.nombre, {
      paginas: paginasRef,
      href: bruto?.href || "",
      entidad: bruto?.entidad || "",
    });
    return await mostrarListaMapeos(ctx, chatId, `✅ "<b>${escapeHtml(mapeoActual.nombre)}</b>" actualizado con ${paginasRef.length} página${paginasRef.length !== 1 ? "s" : ""}.\n\n`);
  }

  // ── Aprender: confirmando sobreescritura de mapeo ──
  if (sesion.fase === "aprender_confirmando_overwrite" && texto && !texto.startsWith("/")) {
    const accion = texto.toLowerCase().trim();

    if (accion === "otro") {
      setSesion(chatId, { fase: "aprender_overwrite_nuevo_pdf" });
      const nombres = sesion.pendingConflictosReqs.map((r) => `"${escapeHtml(r.nombre)}"`).join(", ");
      return ctx.reply(`📎 Mandame el PDF de referencia para ${nombres}.`, { parse_mode: "HTML" });
    }

    if (!/^s[ií]/i.test(texto) && accion !== "ok") {
      setSesion(chatId, { fase: "aprender_asignando", grupoActual: sesion.pendingGrupoActual, filtroActual: null });
      return ctx.reply(
        `Ok, no se reemplaza. ¿A qué requerimiento querés asignar las páginas <b>${sesion.pendingGrupoActual.paginas.join(", ")}</b>?\n\nEscribí parte del nombre para buscar, o <code>lista</code> para verlos todos.\n💡 O usá /mapeos para gestionar los ejemplos guardados.\n\n/listo para finalizar el mapeo.`,
        { parse_mode: "HTML" }
      );
    }

    return continuarAprendiendoDesdeConflicto(ctx, chatId);
  }

  // ── Aprender: eligiendo páginas del PDF nuevo para overwrite ──
  if (sesion.fase === "aprender_overwrite_nuevo_paginas" && texto && !texto.startsWith("/")) {
    const { imagenes, pendingConflictosReqs } = sesion;

    let paginasElegidas;
    if (texto.toLowerCase().trim() === "todas") {
      paginasElegidas = imagenes.map((i) => i.pagina);
    } else {
      const nums = texto.split(",").map((s) => parseInt(s.trim())).filter((n) => !isNaN(n));
      const invalidas = nums.filter((n) => !imagenes.find((i) => i.pagina === n));
      if (!nums.length || invalidas.length)
        return ctx.reply(`Páginas disponibles: ${imagenes.map((i) => i.pagina).join(", ")}. Escribí los números o <code>todas</code>.`, { parse_mode: "HTML" });
      paginasElegidas = nums;
    }

    const paginasRef = paginasElegidas.map((num) => ({ num, imagen: imagenes.find((i) => i.pagina === num).base64, texto: "" }));
    for (const req of pendingConflictosReqs) {
      const bruto = await leerMapeoBruto(chatId, req.nombre);
      await guardarMapeo(chatId, req.nombre, { paginas: paginasRef, href: bruto?.href || req.href || "", entidad: bruto?.entidad || req.entidad || "" });
    }
    return continuarAprendiendoDesdeConflicto(ctx, chatId);
  }

  // ── Trabajar: confirmación de subida ──
  if (sesion.fase === "trabajar_confirmando" && texto && !texto.startsWith("/")) {
    const esNo = /^no$/i.test(texto.trim()) || /^cancel/i.test(texto.trim());
    if (esNo) {
      resetSesion(chatId);
      return ctx.reply("Cancelado.");
    }

    const { buffer, gruposSubir, sinRequerido = [], cdUser, cdPass } = sesion;

    // Detectar si el usuario escribió números: "2", "1 2", "1,2", etc.
    const numerosTexto = texto.trim().match(/^[\d\s,]+$/);
    if (numerosTexto && !/^s[ií]/i.test(texto) && texto.toLowerCase() !== "ok") {
      const indices = [...new Set(
        texto.split(/[\s,]+/).map(n => parseInt(n)).filter(n => !isNaN(n) && n >= 1 && n <= gruposSubir.length)
      )];
      if (!indices.length) {
        return ctx.reply(`Número inválido. Escribí sí, no, o un número del 1 al ${gruposSubir.length}.`);
      }
      // Reemplazar gruposSubir en sesión con solo los seleccionados
      const gruposSeleccionados = indices.map(i => gruposSubir[i - 1]);
      setSesion(chatId, { ...sesion, gruposSubir: gruposSeleccionados, fase: "trabajar_confirmando" });
      const nombresGrupos = gruposSeleccionados.map((g, i) => `${indices[i]}. ${g.entidad || "Sin entidad"}`).join(", ");
      await ctx.reply(`Subiendo solo: ${nombresGrupos}. ¿Confirmar? (sí / no)`);
      return;
    }

    if (!/^s[ií]/i.test(texto) && texto.toLowerCase() !== "ok") {
      return ctx.reply(`No entendí. Escribí sí, no, o un número del 1 al ${gruposSubir.length}.`);
    }

    if (!gruposSubir.length && sinRequerido.length) {
      // Nothing to upload now, go straight to generables
      setSesion(chatId, { fase: "trabajar_generables", sinRequerido, pendientes: sinRequerido, indiceActual: 0, buffer, cdUser, cdPass });
      return _mostrarGenerables(ctx, chatId);
    }

    await ctx.reply("⏳ Subiendo a controldocumentario.com…");

    try {
      const sesCD = await cdObtenerSesionActiva(chatId, cdUser, cdPass);
      if (!sesCD.ok) {
        resetSesion(chatId);
        return ctx.reply(`❌ Error conectando a CD: ${sesCD.motivo}`);
      }

      let ok = 0, fail = 0;
      for (const grupo of gruposSubir) {
        const paginasOrdenadas = grupo.paginas.slice().sort((a, b) => a - b);
        console.log(`[SUBIDA] Grupo "${grupo.entidad}": solicitando págs ${paginasOrdenadas.join(",")}`);
        const bufferGrupo = await cortarPaginas(buffer, paginasOrdenadas);
        for (const req of grupo.reqs) {
          const nombre = `${req.nombre.replace(/[^a-z0-9]/gi, "_")}.pdf`;
          try {
            await cdSubirArchivo(sesCD.page, req.href, bufferGrupo, nombre, req.nombre, req.entidad);
            const entidad = grupo.entidad ? ` — ${escapeHtml(grupo.entidad)}` : "";
            await ctx.reply(`✅ ${escapeHtml(req.nombre)}${entidad}`);
            ok++;
          } catch (e) {
            const entidad = grupo.entidad ? ` — ${escapeHtml(grupo.entidad)}` : "";
            const caption = `❌ ${escapeHtml(req.nombre)}${entidad}: ${e.message}`;
            if (e.screenshot) {
              await ctx.replyWithPhoto(new InputFile(e.screenshot, "debug.jpg"), { caption });
            } else {
              await ctx.reply(caption);
            }
            fail++;
          }
        }
      }

      if (ok > 0) invalidateCache(chatId, "pendientes");

      const todosOmitidos = gruposSubir.flatMap((g) => g.omitidos || []);
      let msgFinal = `Listo. ${ok} subido${ok !== 1 ? "s" : ""}${fail ? `, ${fail} con error` : ""}.`;
      if (todosOmitidos.length) {
        const omitStr = todosOmitidos
          .map((r) => `  • ${escapeHtml(r.nombre)}${r.entidad ? ` — <i>${escapeHtml(r.entidad)}</i>` : ""}`)
          .join("\n");
        msgFinal += `\n\n⚠️ Quedaron pendientes (período anterior, subir aparte):\n${omitStr}`;
      }

      if (!sinRequerido.length) {
        resetSesion(chatId);
        return ctx.reply(msgFinal, { parse_mode: "HTML" });
      }

      // Transition to generables flow
      await ctx.reply(msgFinal, { parse_mode: "HTML" });
      setSesion(chatId, { fase: "trabajar_generables", sinRequerido, pendientes: sinRequerido, indiceActual: 0, buffer, cdUser, cdPass });
      return _mostrarGenerables(ctx, chatId);
    } catch (e) {
      cdInvalidarSesion(chatId);
      resetSesion(chatId);
      return ctx.reply(`❌ Error durante la subida: ${e.message}`);
    }
  }

  // ── Trabajar: seleccionando cuáles generables procesar ──
  if (sesion.fase === "trabajar_generables" && texto && !texto.startsWith("/")) {
    if (/^(omitir|no)$/i.test(texto)) {
      resetSesion(chatId);
      return ctx.reply("Entendido, se omiten.");
    }

    const { sinRequerido, buffer, cdUser, cdPass } = sesion;

    let seleccionados;
    if (/^todo$/i.test(texto)) {
      seleccionados = sinRequerido;
    } else {
      const indices = texto.split(",").map((s) => parseInt(s.trim()) - 1).filter((n) => !isNaN(n) && n >= 0 && n < sinRequerido.length);
      if (!indices.length)
        return ctx.reply(`Escribí números del 1 al ${sinRequerido.length}, <code>todo</code> para todos, o <code>omitir</code>.`, { parse_mode: "HTML" });
      seleccionados = indices.map((i) => sinRequerido[i]);
    }

    setSesion(chatId, { fase: "trabajar_generando", pendientes: seleccionados, indiceActual: 0, buffer, cdUser, cdPass });
    return _procesarSiguienteGenerable(ctx, chatId);
  }

  // ── Trabajar: el usuario elige el tipo manualmente ──
  if (sesion.fase === "trabajar_generando_tipo" && texto && !texto.startsWith("/")) {
    const TIPOS = ["empresa", "personal", "maquinas"];
    const n = parseInt(texto.trim());
    let tipo = null;
    if (n >= 1 && n <= 3) tipo = TIPOS[n - 1];
    else {
      const t = texto.toLowerCase().trim();
      tipo = TIPOS.find((x) => t.includes(x)) || null;
    }
    if (!tipo) return ctx.reply("Escribí <code>1</code> (empresa), <code>2</code> (personal) o <code>3</code> (máquinas).", { parse_mode: "HTML" });

    const { itemActual } = sesion;
    await guardarTipoMapeo(chatId, itemActual.tipo, tipo);
    setSesion(chatId, { ...getSesion(chatId), fase: "trabajar_generando" });
    return _generarItem(ctx, chatId, itemActual, tipo);
  }

  // ── Trabajar: el usuario elige el sector manualmente ──
  if (sesion.fase === "trabajar_generando_sector" && texto && !texto.startsWith("/")) {
    const { sectores, itemActual, tipoActual } = sesion;
    const n = parseInt(texto.trim());
    let sectorElegido = null;
    if (n >= 1 && n <= sectores.length) sectorElegido = sectores[n - 1];
    else {
      const lower = texto.toLowerCase();
      sectorElegido = sectores.find(s => s.text.toLowerCase().includes(lower)) || null;
    }
    if (!sectorElegido) {
      const lineas = sectores.map((s, i) => `${i + 1}. ${escapeHtml(s.text)}`);
      return ctx.reply(`Escribí un número del 1 al ${sectores.length}:\n${lineas.join("\n")}`, { parse_mode: "HTML" });
    }
    setSesion(chatId, { ...getSesion(chatId), fase: "trabajar_generando" });
    return _generarItem(ctx, chatId, itemActual, tipoActual, sectorElegido.value);
  }

  // ── /generar: usuario busca y elige el tipo a generar ──
  if (sesion.fase === "generar_buscando" && texto && !texto.startsWith("/")) {
    if (/^(cancelar|no)$/i.test(texto)) {
      resetSesion(chatId);
      return ctx.reply("Cancelado.");
    }

    const { lista, cdUser, cdPass } = sesion;
    const listaActual = sesion.filtroActual || lista;
    const esNumerico = /^\d+$/.test(texto.trim());

    if (!esNumerico) {
      const filtro = texto.toLowerCase();
      const filtrados = lista.filter((r) => r.nombre.toLowerCase().includes(filtro));
      if (!filtrados.length)
        return ctx.reply(`No encontré nada con "<b>${escapeHtml(texto)}</b>". Probá con otra palabra.`, { parse_mode: "HTML" });
      setSesion(chatId, { filtroActual: filtrados });
      const lineas = filtrados.map((r, i) => `${i + 1}. ${escapeHtml(r.nombre)}`);
      return ctx.reply(
        `🔍 ${filtrados.length} resultado${filtrados.length !== 1 ? "s" : ""}:\n\n${lineas.join("\n")}\n\nEscribí el número para generar.`,
        { parse_mode: "HTML" }
      );
    }

    const idx = parseInt(texto.trim()) - 1;
    if (idx < 0 || idx >= listaActual.length)
      return ctx.reply(`Escribí un número del 1 al ${listaActual.length}.`);

    const elegido = listaActual[idx];
    setSesion(chatId, { fase: "generar_confirmando", elegido, cdUser, cdPass });
    return ctx.reply(
      `¿Generar requerimiento <b>${escapeHtml(elegido.nombre)}</b>? (sí / no)`,
      { parse_mode: "HTML" }
    );
  }

  // ── /generar: confirmación ──
  if (sesion.fase === "generar_confirmando" && texto && !texto.startsWith("/")) {
    if (!/^s[ií]/i.test(texto) && texto.toLowerCase() !== "ok") {
      resetSesion(chatId);
      return ctx.reply("Cancelado.");
    }

    const { elegido, cdUser, cdPass } = sesion;
    await ctx.reply(`⏳ Generando <b>${escapeHtml(elegido.nombre)}</b>…`, { parse_mode: "HTML" });

    let tipoGenerar = null;
    try {
      const sesCD = await cdObtenerSesionActiva(chatId, cdUser, cdPass);
      if (!sesCD.ok) throw new Error(sesCD.motivo);

      tipoGenerar = await leerTipoMapeo(chatId, elegido.nombre);

      if (!tipoGenerar) {
        await ctx.reply(`🔍 Buscando categoría de "<b>${escapeHtml(elegido.nombre)}</b>" en CD…`, { parse_mode: "HTML" });
        const resultado = await cdScrapearTipoRequerimiento(sesCD.page, elegido.nombre);
        if (resultado) {
          tipoGenerar = resultado.tipo;
          await guardarTipoMapeo(chatId, elegido.nombre, tipoGenerar);
        }
      }

      if (!tipoGenerar) {
        setSesion(chatId, { fase: "generar_tipo_manual", elegido, cdUser, cdPass });
        return ctx.reply(
          `No pude determinar la categoría de "<b>${escapeHtml(elegido.nombre)}</b>" automáticamente.\n\n¿A cuál pertenece?\n1. empresa\n2. personal\n3. máquinas`,
          { parse_mode: "HTML" }
        );
      }

      await cdGenerarRequerimiento(sesCD.page, tipoGenerar, elegido.nombre);
      resetSesion(chatId);
      return ctx.reply(`✅ <b>${escapeHtml(elegido.nombre)}</b> generado.`, { parse_mode: "HTML" });
    } catch (e) {
      if (e.sectores) {
        const lineas = e.sectores.map((s, i) => `${i + 1}. ${escapeHtml(s.text)}`);
        setSesion(chatId, { fase: "generar_sector", elegido, cdUser, cdPass, tipo: tipoGenerar, sectores: e.sectores });
        const msg = `🏭 ¿Cuál sector para "<b>${escapeHtml(elegido.nombre)}</b>"?\n\n${lineas.join("\n")}`;
        if (e.screenshot) return ctx.replyWithPhoto(new InputFile(e.screenshot, "debug.jpg"), { caption: msg, parse_mode: "HTML" });
        return ctx.reply(msg, { parse_mode: "HTML" });
      }
      cdInvalidarSesion(chatId);
      resetSesion(chatId);
      console.error("[GENERAR-CMD]", e.message);
      const caption = `❌ Error: ${e.message}`;
      if (e.screenshot)
        return ctx.replyWithPhoto(new InputFile(e.screenshot, "debug.jpg"), { caption, parse_mode: "HTML" });
      return ctx.reply(caption, { parse_mode: "HTML" });
    }
  }

  // ── /generar: tipo manual ──
  if (sesion.fase === "generar_tipo_manual" && texto && !texto.startsWith("/")) {
    const TIPOS = ["empresa", "personal", "maquinas"];
    const n = parseInt(texto.trim());
    let tipo = (n >= 1 && n <= 3) ? TIPOS[n - 1] : TIPOS.find((x) => texto.toLowerCase().includes(x)) || null;
    if (!tipo)
      return ctx.reply("Escribí <code>1</code> (empresa), <code>2</code> (personal) o <code>3</code> (máquinas).", { parse_mode: "HTML" });

    const { elegido, cdUser, cdPass } = sesion;
    await guardarTipoMapeo(chatId, elegido.nombre, tipo);
    await ctx.reply(`⏳ Generando <b>${escapeHtml(elegido.nombre)}</b>…`, { parse_mode: "HTML" });

    try {
      const sesCD = await cdObtenerSesionActiva(chatId, cdUser, cdPass);
      if (!sesCD.ok) throw new Error(sesCD.motivo);
      await cdGenerarRequerimiento(sesCD.page, tipo, elegido.nombre);
      resetSesion(chatId);
      return ctx.reply(`✅ <b>${escapeHtml(elegido.nombre)}</b> generado.`, { parse_mode: "HTML" });
    } catch (e) {
      if (e.sectores) {
        const lineas = e.sectores.map((s, i) => `${i + 1}. ${escapeHtml(s.text)}`);
        setSesion(chatId, { fase: "generar_sector", elegido, cdUser, cdPass, tipo, sectores: e.sectores });
        const msg = `🏭 ¿Cuál sector para "<b>${escapeHtml(elegido.nombre)}</b>"?\n\n${lineas.join("\n")}`;
        if (e.screenshot) return ctx.replyWithPhoto(new InputFile(e.screenshot, "debug.jpg"), { caption: msg, parse_mode: "HTML" });
        return ctx.reply(msg, { parse_mode: "HTML" });
      }
      cdInvalidarSesion(chatId);
      resetSesion(chatId);
      console.error("[GENERAR-CMD]", e.message);
      const caption = `❌ Error: ${e.message}`;
      if (e.screenshot)
        return ctx.replyWithPhoto(new InputFile(e.screenshot, "debug.jpg"), { caption, parse_mode: "HTML" });
      return ctx.reply(caption, { parse_mode: "HTML" });
    }
  }

  // ── /generar: sector manual ──
  if (sesion.fase === "generar_sector" && texto && !texto.startsWith("/")) {
    const { sectores, elegido, cdUser, cdPass, tipo } = sesion;
    const n = parseInt(texto.trim());
    let sectorElegido = null;
    if (n >= 1 && n <= sectores.length) sectorElegido = sectores[n - 1];
    else {
      const lower = texto.toLowerCase();
      sectorElegido = sectores.find(s => s.text.toLowerCase().includes(lower)) || null;
    }
    if (!sectorElegido) {
      const lineas = sectores.map((s, i) => `${i + 1}. ${escapeHtml(s.text)}`);
      return ctx.reply(`Escribí un número del 1 al ${sectores.length}:\n${lineas.join("\n")}`, { parse_mode: "HTML" });
    }
    await ctx.reply(`⏳ Generando <b>${escapeHtml(elegido.nombre)}</b>…`, { parse_mode: "HTML" });
    try {
      const sesCD = await cdObtenerSesionActiva(chatId, cdUser, cdPass);
      if (!sesCD.ok) throw new Error(sesCD.motivo);
      await cdGenerarRequerimiento(sesCD.page, tipo, elegido.nombre, sectorElegido.value);
      resetSesion(chatId);
      return ctx.reply(`✅ <b>${escapeHtml(elegido.nombre)}</b> generado.`, { parse_mode: "HTML" });
    } catch (e) {
      cdInvalidarSesion(chatId);
      resetSesion(chatId);
      const caption = `❌ Error: ${e.message}`;
      if (e.screenshot) return ctx.replyWithPhoto(new InputFile(e.screenshot, "debug.jpg"), { caption, parse_mode: "HTML" });
      return ctx.reply(caption, { parse_mode: "HTML" });
    }
  }

  // ── Único: buscando requerimiento ──
  if (sesion.fase === "unico_buscando_req" && texto && !texto.startsWith("/")) {
    const listaActual = sesion.filtroActual || sesion.requerimientos;

    if (texto.toLowerCase() === "lista") {
      setSesion(chatId, { filtroActual: sesion.requerimientos });
      return ctx.reply(
        `📋 ${sesion.requerimientos.length} requerimientos:\n\n${formatearReqs(sesion.requerimientos)}\n\nEscribí un número para seleccionar, o texto para filtrar.`,
        { parse_mode: "HTML" }
      );
    }

    const esNumerico = /^\d+$/.test(texto.trim());
    if (!esNumerico) {
      const filtro = texto.toLowerCase();
      const filtrados = sesion.requerimientos.filter((r) => r.nombre.toLowerCase().includes(filtro));
      if (!filtrados.length)
        return ctx.reply(`No encontré nada con "<b>${escapeHtml(texto)}</b>". Probá con otra palabra, o escribí <code>lista</code>.`, { parse_mode: "HTML" });
      setSesion(chatId, { filtroActual: filtrados });
      return ctx.reply(
        `🔍 ${filtrados.length} resultado${filtrados.length !== 1 ? "s" : ""}:\n\n${formatearReqs(filtrados, { mostrarTodos: true })}\n\nEscribí el número para seleccionar.`,
        { parse_mode: "HTML" }
      );
    }

    const idx = parseInt(texto.trim()) - 1;
    if (idx < 0 || idx >= listaActual.length)
      return ctx.reply(`Escribí un número del 1 al ${listaActual.length}.`);

    const req = listaActual[idx];
    setSesion(chatId, { fase: "unico_confirmando", reqElegido: req });
    const entidad = req.entidad ? ` — <i>${escapeHtml(req.entidad)}</i>` : "";
    return ctx.reply(
      `📄 Vas a subir el PDF a:\n<b>${escapeHtml(req.nombre)}</b>${entidad}\n\n¿Confirmar? (sí / no)`,
      { parse_mode: "HTML" }
    );
  }

  // ── Único: confirmando subida ──
  if (sesion.fase === "unico_confirmando" && texto && !texto.startsWith("/")) {
    if (!/^s[ií]/i.test(texto) && texto.toLowerCase() !== "ok") {
      resetSesion(chatId);
      return ctx.reply("Cancelado.");
    }

    const { buffer, reqElegido, cdUser, cdPass } = sesion;
    await ctx.reply("⏳ Subiendo a controldocumentario.com…");
    try {
      const sesCD = await cdObtenerSesionActiva(chatId, cdUser, cdPass);
      if (!sesCD.ok) {
        resetSesion(chatId);
        return ctx.reply(`❌ Error conectando a CD: ${sesCD.motivo}`);
      }
      const nombre = `${reqElegido.nombre.replace(/[^a-z0-9]/gi, "_")}.pdf`;
      await cdSubirArchivo(sesCD.page, reqElegido.href, buffer, nombre, reqElegido.nombre, reqElegido.entidad);
      invalidateCache(chatId, "pendientes");
      const entidad = reqElegido.entidad ? ` — ${escapeHtml(reqElegido.entidad)}` : "";
      resetSesion(chatId);
      return ctx.reply(`✅ ${escapeHtml(reqElegido.nombre)}${entidad}`);
    } catch (e) {
      cdInvalidarSesion(chatId);
      resetSesion(chatId);
      const caption = `❌ Error: ${e.message}`;
      if (e.screenshot) {
        return ctx.replyWithPhoto(new InputFile(e.screenshot, "debug.jpg"), { caption });
      }
      return ctx.reply(caption);
    }
  }

  // ── Admin: mensaje sin reconocer ──
  if (ADMIN_IDS.includes(chatId)) return ctx.reply(tonteria());

  // ── Registro con código ──
  const cliente = await cargarCliente(chatId);
  if (cliente) return ctx.reply("No conozco esas palabras... solo manejo comandos y PDF :)");

  if (esperandoCodigo.has(chatId)) {
    const pendiente = await consumirPendiente(texto);
    if (pendiente) {
      esperandoCodigo.delete(chatId);
      await registrarCliente(chatId, pendiente.nombre);
      return ctx.reply(`¡Bienvenido <b>${pendiente.nombre}</b>! Estoy listo para los PDF.`, {
        parse_mode: "HTML",
      });
    }
    return ctx.reply("Contraseña incorrecta.");
  }

  esperandoCodigo.add(chatId);
  return ctx.reply("No te conozco... ¿Contraseña?");
});

// ─── Generables: helpers de flujo ────────────────────────────────────────────

function _mostrarGenerables(ctx, chatId) {
  const { sinRequerido } = getSesion(chatId);
  const itemsStr = sinRequerido.map((item, i) => {
    const pags = item.paginas.slice().sort((a, b) => a - b).join(", ");
    const entidad = item.entidad ? ` (<i>${escapeHtml(item.entidad)}</i>)` : "";
    return `${i + 1}. Págs. ${pags} → "<b>${escapeHtml(item.tipo)}</b>"${entidad}`;
  }).join("\n");

  return ctx.reply(
    `⚡ <b>${sinRequerido.length} documento${sinRequerido.length !== 1 ? "s" : ""} identificado${sinRequerido.length !== 1 ? "s" : ""} sin requerido en CD:</b>\n\n${itemsStr}\n\n¿Generamos los requeridos faltantes?\nEscribí los números (ej: <code>1,2</code>), <code>todo</code> para todos, o <code>omitir</code> para saltear.`,
    { parse_mode: "HTML" }
  );
}

async function _procesarSiguienteGenerable(ctx, chatId) {
  const sesion = getSesion(chatId);
  const { pendientes, indiceActual, cdUser, cdPass } = sesion;

  if (indiceActual >= pendientes.length) {
    resetSesion(chatId);
    return ctx.reply("✅ Procesamiento de requeridos completado.");
  }

  const item = pendientes[indiceActual];
  const tipoGuardado = await leerTipoMapeo(chatId, item.tipo);

  if (tipoGuardado) {
    return _generarItem(ctx, chatId, item, tipoGuardado);
  }

  // Tipo no conocido → scrape
  await ctx.reply(`🔍 Buscando categoría de "<b>${escapeHtml(item.tipo)}</b>" en controldocumentario…`, { parse_mode: "HTML" });

  try {
    const sesCD = await cdObtenerSesionActiva(chatId, cdUser, cdPass);
    if (!sesCD.ok) {
      resetSesion(chatId);
      return ctx.reply(`❌ Error conectando a CD: ${sesCD.motivo}`);
    }

    const resultado = await cdScrapearTipoRequerimiento(sesCD.page, item.tipo);

    if (resultado) {
      await guardarTipoMapeo(chatId, item.tipo, resultado.tipo);
      return _generarItem(ctx, chatId, item, resultado.tipo);
    }

    // No encontrado → pedir al usuario
    setSesion(chatId, { ...sesion, fase: "trabajar_generando_tipo", itemActual: item });
    return ctx.reply(
      `No pude determinar la categoría de "<b>${escapeHtml(item.tipo)}</b>" automáticamente.\n\n¿A cuál pertenece?\n1. empresa\n2. personal\n3. máquinas`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    console.error("[SCRAPE-TIPO]", e.message);
    setSesion(chatId, { ...sesion, indiceActual: indiceActual + 1 });
    await ctx.reply(`⚠️ Error buscando categoría para "<b>${escapeHtml(item.tipo)}</b>": ${e.message}\nSalteando…`, { parse_mode: "HTML" });
    return _procesarSiguienteGenerable(ctx, chatId);
  }
}

async function _generarItem(ctx, chatId, item, tipo, sector = null) {
  const sesion = getSesion(chatId);
  const { buffer, cdUser, cdPass, pendientes, indiceActual } = sesion;
  const entidadLabel = item.entidad ? ` (${escapeHtml(item.entidad)})` : "";

  await ctx.reply(`⏳ Generando requerido "<b>${escapeHtml(item.tipo)}</b>"${entidadLabel}…`, { parse_mode: "HTML" });

  try {
    const sesCD = await cdObtenerSesionActiva(chatId, cdUser, cdPass);
    if (!sesCD.ok) throw new Error(sesCD.motivo);

    await cdGenerarRequerimiento(sesCD.page, tipo, item.tipo, sector);
    await ctx.reply(`✅ Requerido generado. Subiendo documento…`);

    // Re-read reqs and find the newly created one — retry once if CD is slow to reflect it
    const baseNorm = (s) => String(s || "").toLowerCase().replace(/-\d{4}-\d+$/i, "").trim();
    const normEnt = (s) => String(s || "").toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ").trim();
    const porNombreYEntidad = (lista) => lista.filter(
      (r) => baseNorm(r.nombre) === baseNorm(item.tipo) && normEnt(r.entidad) === normEnt(item.entidad)
    );
    const porNombreSolo = (lista) => lista.filter(
      (r) => baseNorm(r.nombre) === baseNorm(item.tipo)
    );

    let reqs = await cdLeerRequerimientos(sesCD.page);
    console.log(`[GENERAR-POST] buscando tipo="${item.tipo}" entidad="${item.entidad}"`);
    console.log(`[GENERAR-POST] reqs en bandeja: ${reqs.map(r => `"${r.nombre}"/"${r.entidad}"`).join(" | ")}`);
    let reqsNuevos = item.entidad ? porNombreYEntidad(reqs) : porNombreSolo(reqs);
    if (!reqsNuevos.length) {
      // La entidad en el doc (nombre de persona) puede no coincidir con la de CD (ej: patente).
      // Buscamos solo por nombre — esto aplica cuando generamos con "Todos" (múltiples entidades).
      reqsNuevos = porNombreSolo(reqs);
    }
    if (!reqsNuevos.length) {
      console.log(`[GENERAR-POST] no encontrado, esperando 5s y reintentando...`);
      await new Promise(r => setTimeout(r, 5000));
      reqs = await cdLeerRequerimientos(sesCD.page);
      console.log(`[GENERAR-POST] reqs (reintento): ${reqs.map(r => `"${r.nombre}"/"${r.entidad}"`).join(" | ")}`);
      reqsNuevos = porNombreSolo(reqs);
    }
    console.log(`[GENERAR-POST] reqsNuevos: ${reqsNuevos.map(r => `"${r.nombre}"/"${r.entidad}"`).join(" | ") || "ninguno"}`);

    if (!reqsNuevos.length) {
      await ctx.reply(`⚠️ Requerido generado pero no lo encontré en CD. Usá /unico para subirlo manualmente.`);
    } else {
      const paginasOrdenadas = item.paginas.slice().sort((a, b) => a - b);
      const bufferItem = await cortarPaginas(buffer, paginasOrdenadas);
      for (const reqNuevo of reqsNuevos) {
        const nombre = `${reqNuevo.nombre.replace(/[^a-z0-9]/gi, "_")}.pdf`;
        await cdSubirArchivo(sesCD.page, reqNuevo.href, bufferItem, nombre, reqNuevo.nombre, reqNuevo.entidad);
        await ctx.reply(`✅ ${escapeHtml(reqNuevo.nombre)}${reqNuevo.entidad ? ` (<i>${escapeHtml(reqNuevo.entidad)}</i>)` : ""}`, { parse_mode: "HTML" });
      }
      invalidateCache(chatId, "pendientes");
    }
  } catch (e) {
    if (e.sectores) {
      const lineas = e.sectores.map((s, i) => `${i + 1}. ${escapeHtml(s.text)}`);
      setSesion(chatId, { ...getSesion(chatId), fase: "trabajar_generando_sector", itemActual: item, tipoActual: tipo, sectores: e.sectores });
      const msg = `🏭 ¿Cuál sector para "<b>${escapeHtml(item.tipo)}</b>"?\n\n${lineas.join("\n")}`;
      if (e.screenshot) return ctx.replyWithPhoto(new InputFile(e.screenshot, "debug.jpg"), { caption: msg, parse_mode: "HTML" });
      return ctx.reply(msg, { parse_mode: "HTML" });
    }
    const caption = `❌ Error con "<b>${escapeHtml(item.tipo)}</b>"${entidadLabel}: ${e.message}`;
    if (e.screenshot) {
      await ctx.replyWithPhoto(new InputFile(e.screenshot, "debug.jpg"), { caption, parse_mode: "HTML" });
    } else {
      await ctx.reply(caption, { parse_mode: "HTML" });
    }
  }

  setSesion(chatId, { ...getSesion(chatId), indiceActual: indiceActual + 1 });
  return _procesarSiguienteGenerable(ctx, chatId);
}

// ─── Vencimientos: helpers de formato ────────────────────────────────────────

// `diasFaltantes` se persiste en cache pero depende del día actual. Si pedís
// /vencimientos al día siguiente sin que el cron de las 9 AM AR haya corrido,
// el cacheado tendría 1 día de desfase. fecha (DD/MM/YYYY) es invariante, así
// que recomputamos contra el día de hoy AR (anclado por Intl, no por TZ del VPS).
function _hoyAR_UTCms() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const [y, m, d] = fmt.format(new Date()).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function recomputarDiasFaltantes(items) {
  if (!Array.isArray(items)) return items;
  const hoy = _hoyAR_UTCms();
  return items.map(item => {
    const mm = String(item?.fecha || "").trim().match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
    if (!mm) return item;
    let y = parseInt(mm[3], 10);
    if (y < 100) y += 2000;
    const f = Date.UTC(y, parseInt(mm[2], 10) - 1, parseInt(mm[1], 10));
    const dias = Math.round((f - hoy) / 864e5);
    return { ...item, diasFaltantes: dias };
  });
}

function _buildMsgVencimientos(items, diasP, diasV, diasE = 10) {
  const fraseDias = (d) => {
    if (d < 0) { const n = Math.abs(d); return n === 1 ? "VENCIDO hace 1 día" : `VENCIDO hace ${n} días`; }
    if (d === 0) return "vence HOY";
    if (d === 1) return "vence MAÑANA";
    return `vence en ${d} días`;
  };
  const ico = (d) => d < 0 ? "🔴" : d <= 3 ? "🟠" : "🟡";

  const generales = items.filter(i => i.tipo === "general");
  const empresa   = items.filter(i => i.tipo === "empresa");
  const personal  = items.filter(i => i.tipo === "personal");
  const vehiculos = items.filter(i => i.tipo === "vehiculo");

  const partes = [
    `🔔 <b>Vencimientos próximos</b>`,
    `<i>🟠 hoy/1-3 días · 🟡 4+ días | empresa ${diasE}d · personal ${diasP}d · vehículos ${diasV}d</i>`,
  ];

  const bloque = (titulo, lista, sinNombre = false) => {
    partes.push(`\n${titulo}`);
    if (!lista.length) { partes.push("✅ sin vencimientos"); return; }
    const ordenada = [...lista].sort((a, b) => a.diasFaltantes - b.diasFaltantes);
    for (const it of ordenada.slice(0, 60)) {
      partes.push(sinNombre
        ? `${ico(it.diasFaltantes)} ${escapeHtml(it.columna)} — ${it.fecha} (${fraseDias(it.diasFaltantes)})`
        : `${ico(it.diasFaltantes)} ${escapeHtml(it.columna)} — ${escapeHtml(it.nombre)} — ${it.fecha} (${fraseDias(it.diasFaltantes)})`
      );
    }
    if (ordenada.length > 60) partes.push(`…y ${ordenada.length - 60} más.`);
  };

  bloque("📋 <b>GENERAL</b>", generales, true);
  bloque("🏢 <b>EMPRESA</b>", empresa, true);
  bloque("👷 <b>PERSONAL</b>", personal);
  bloque("🚗 <b>VEHÍCULOS</b>", vehiculos);
  return partes.join("\n");
}

function _buildMsgVencidos(items) {
  const fraseDias = (d) => {
    const n = Math.abs(d);
    return n === 1 ? "vencido hace 1 día" : `vencido hace ${n} días`;
  };

  const generales = items.filter(i => i.tipo === "general");
  const empresa   = items.filter(i => i.tipo === "empresa");
  const personal  = items.filter(i => i.tipo === "personal");
  const vehiculos = items.filter(i => i.tipo === "vehiculo");

  const partes = [`🔴 <b>Vencimientos atrasados</b>`];

  const bloque = (titulo, lista, sinNombre = false) => {
    if (!lista.length) return;
    partes.push(`\n${titulo}`);
    const ordenada = [...lista].sort((a, b) => a.diasFaltantes - b.diasFaltantes);
    for (const it of ordenada.slice(0, 60)) {
      partes.push(sinNombre
        ? `🔴 ${escapeHtml(it.columna)} — ${it.fecha} (${fraseDias(it.diasFaltantes)})`
        : `🔴 ${escapeHtml(it.columna)} — ${escapeHtml(it.nombre)} — ${it.fecha} (${fraseDias(it.diasFaltantes)})`
      );
    }
    if (ordenada.length > 60) partes.push(`…y ${ordenada.length - 60} más.`);
  };

  bloque("📋 <b>GENERAL</b>", generales, true);
  bloque("🏢 <b>EMPRESA</b>", empresa, true);
  bloque("👷 <b>PERSONAL</b>", personal);
  bloque("🚗 <b>VEHÍCULOS</b>", vehiculos);
  return partes.join("\n");
}

function* _chunksVenc(msg, max = 3800) {
  const lineas = msg.split("\n");
  let chunk = "";
  for (const ln of lineas) {
    if (chunk.length + ln.length + 1 > max) { yield chunk; chunk = ln; }
    else chunk = chunk ? chunk + "\n" + ln : ln;
  }
  if (chunk) yield chunk;
}

// ─── Parte mensual: helper de mensaje y cron ─────────────────────────────────

function _msgParteMensual(personal, maquinas) {
  const total = personal.actualizados + maquinas.actualizados;
  const lineas = [];
  const errores = [];
  if (personal.actualizados > 0) lineas.push(`👷 Personal: ${personal.actualizados} empleado${personal.actualizados !== 1 ? "s" : ""}`);
  if (maquinas.actualizados > 0) lineas.push(`🚗 Máquinas: ${maquinas.actualizados} vehículo${maquinas.actualizados !== 1 ? "s" : ""}`);
  if (personal?.ok === false && personal?.error) errores.push(`⚠️ Personal: ${personal.error}`);
  if (maquinas?.ok === false && maquinas?.error) errores.push(`⚠️ Máquinas: ${maquinas.error}`);
  if (!lineas.length && !errores.length) return "✅ Parte mensual: ya estaba todo al día (0 cambios).";
  const bloques = [];
  if (lineas.length) bloques.push(`✅ Parte mensual grabado:\n${lineas.join("\n")}`);
  else if (total === 0) bloques.push("✅ Parte mensual: sin cambios grabados.");
  if (errores.length) bloques.push(errores.join("\n"));
  return bloques.join("\n\n");
}

// Día 1 de cada mes a las 08:00
cron.schedule("0 8 1 * *", async () => {
  console.log("[CRON] Parte mensual automático iniciado");
  const clientes = await listarTodosClientes();
  for (const cliente of clientes) {
    if (!cliente.cdUser || !cliente.cdPass) continue;
    const chatId = cliente.chatId;
    try {
      await bot.api.sendMessage(chatId, "⏳ Grabando parte mensual automático…");
      const sesCD = await cdObtenerSesionActiva(chatId, cliente.cdUser, cliente.cdPass);
      if (!sesCD.ok) {
        await bot.api.sendMessage(chatId, `❌ Parte mensual automático — error de login: ${sesCD.motivo}`);
        continue;
      }
      const { personal, maquinas } = await cdGrabarParteMensual(sesCD.page);
      await bot.api.sendMessage(chatId, _msgParteMensual(personal, maquinas));
    } catch (e) {
      cdInvalidarSesion(chatId);
      console.error(`[CRON PARTE] ${chatId}: ${e.message}`);
      await bot.api.sendMessage(chatId, `❌ Parte mensual automático falló: ${e.message}`).catch(() => {});
    }
  }
  console.log("[CRON] Parte mensual automático finalizado");
});

// Todos los días a las 09:00 hora Argentina — notifica solo si hay vencimientos próximos
cron.schedule("0 9 * * *", async () => {
  const inicio = Date.now();
  console.log(`[CRON VENC] ▶ Iniciado — ${new Date().toLocaleString("es-AR")}`);
  const clientes = await listarTodosClientes();
  const total = clientes.length;
  let procesados = 0, sinCredenciales = 0, conAlertas = 0, errores = 0;
  console.log(`[CRON VENC] Clientes a evaluar: ${total}`);

  for (const cliente of clientes) {
    if (!cliente.cdUser || !cliente.cdPass) {
      sinCredenciales++;
      console.log(`[CRON VENC] ⏭ ${cliente.nombre || cliente.chatId} — sin credenciales CD`);
      continue;
    }
    const chatId = cliente.chatId;
    const diasP = cliente.diasPersonal ?? 10;
    const diasV = cliente.diasVehiculos ?? 10;
    const diasE = cliente.diasEmpresa ?? 10;
    procesados++;
    console.log(`[CRON VENC] 🔍 [${procesados}/${total - sinCredenciales}] ${cliente.nombre || chatId} — diasE=${diasE} diasP=${diasP} diasV=${diasV}`);
    try {
      const sesCD = await cdObtenerSesionActiva(chatId, cliente.cdUser, cliente.cdPass);
      if (!sesCD.ok) {
        console.log(`[CRON VENC] ❌ ${cliente.nombre || chatId} — login fallido: ${sesCD.motivo}`);
        errores++;
        continue;
      }
      console.log(`[CRON VENC] ✅ ${cliente.nombre || chatId} — sesión OK, consultando vencimientos…`);
      const { items, screenshots } = await cdLeerVencimientos(sesCD.page, diasP, diasV, diasE);
      console.log(`[CRON VENC] 📋 ${cliente.nombre || chatId} — ${items.length} item(s) total(es)`);

      // Refrescar cache compartido aunque no haya alerta (beneficia al /vencimientos manual del día).
      const screenshotPaths = saveScreenshots(chatId, "vencimientos", screenshots);
      writeCache(chatId, "vencimientos", { items, screenshots: screenshotPaths });

      // Solo alerta por vencimientos PRÓXIMOS (diasFaltantes >= 0). Los vencidos no son novedad.
      const proximos = items.filter(i => i.diasFaltantes >= 0);
      console.log(`[CRON VENC] ⏰ ${cliente.nombre || chatId} — ${proximos.length} próximo(s) a vencer`);
      if (!proximos.length) {
        console.log(`[CRON VENC] ✔ ${cliente.nombre || chatId} — sin vencimientos próximos, no se envía alerta`);
        continue;
      }
      conAlertas++;
      const chunks = [..._chunksVenc(_buildMsgVencimientos(proximos, diasP, diasV, diasE))];
      console.log(`[CRON VENC] 📨 ${cliente.nombre || chatId} — enviando ${chunks.length} mensaje(s) con alertas`);
      for (const chunk of chunks)
        await bot.api.sendMessage(chatId, chunk, { parse_mode: "HTML" });
      for (const ss of screenshots || []) {
        await bot.api.sendPhoto(chatId, new InputFile(ss.buffer, ss.nombre));
      }
      console.log(`[CRON VENC] ✅ ${cliente.nombre || chatId} — alerta enviada`);
    } catch (e) {
      cdInvalidarSesion(chatId);
      errores++;
      console.error(`[CRON VENC] 💥 ${cliente.nombre || chatId}: ${e.message}`);
    }
  }

  const duracion = ((Date.now() - inicio) / 1000).toFixed(1);
  console.log(`[CRON VENC] ■ Finalizado en ${duracion}s — procesados=${procesados} alertas=${conAlertas} errores=${errores} sinCreds=${sinCredenciales}`);
}, { timezone: "America/Argentina/Buenos_Aires" });

// ─── Setup y arranque ────────────────────────────────────────────────────────

bot.catch((err) => console.error("[BOT ERROR]", err.message));

async function setupCommands() {
  const base = [
    { command: "bunn", description: "Activar modo libre (charlar y pedir cosas en lenguaje natural)" },
    { command: "estado", description: "Ver tu cuenta conectada y mapeos" },
    { command: "miid", description: "Ver tu chat ID" },
    { command: "config", description: "Configurar credenciales de controldocumentario.com" },
    { command: "pendientes", description: "Ver requerimientos pendientes en CD" },
    { command: "vencimientos", description: "Ver vencimientos próximos de documentos" },
    { command: "vencidos", description: "Ver vencimientos atrasados (ya vencidos)" },
    { command: "partemes", description: "Grabar parte mensual (personal y máquinas)" },
    { command: "aprender", description: "Configurar mapeo de documentos" },
    { command: "listo", description: "Finalizar modo libre o mapeo actual" },
    { command: "unico", description: "Subir un PDF directo a un requerimiento (sin IA)" },
    { command: "mapeos", description: "Ver, reemplazar o eliminar mapeos guardados" },
    { command: "web", description: "Abrir el panel de mapeos en la web" },
  ];
  await bot.api.setMyCommands(base, { scope: { type: "default" } });
  for (const id of ADMIN_IDS) {
    await bot.api.setMyCommands(
      [...base, { command: "nuevocliente", description: "Registrar cliente: NombreApellido CODIGO" }, { command: "modelo", description: "Ver/cambiar IA: claude o gemini" }],
      { scope: { type: "chat", chat_id: Number(id) } }
    );
  }
}

setupCommands().catch((e) => console.error("[SETUP ERROR]", e.message));
inicializarPdf().catch(() => {});
startWebServer();
startTunnel();
bot.start();
console.log(`ControlBun corriendo… Admins: ${ADMIN_IDS.join(", ") || "⚠️ NO CONFIGURADO"}`);
