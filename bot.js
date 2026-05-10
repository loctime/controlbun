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

const bot = new Bot(process.env.TG_TOKEN);
const ADMIN_IDS = (process.env.ADMIN_CHAT_ID || "").split(",").map(s => s.trim()).filter(Boolean);

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Estado de sesiÃƒÂ³n por usuario (en memoria) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

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

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Helpers Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

const MAX_REQS_VISIBLE = 20;

function formatearReqs(reqs, { mostrarTodos = false } = {}) {
  const visibles = mostrarTodos ? reqs : reqs.slice(0, MAX_REQS_VISIBLE);
  const resto = reqs.length - visibles.length;
  const lineas = visibles.map((r, i) => {
    const entidad = r.entidad ? ` Ã¢â‚¬â€ <i>${escapeHtml(r.entidad)}</i>` : "";
    return `${i + 1}. ${escapeHtml(r.nombre)}${entidad}`;
  });
  if (resto > 0) lineas.push(`\n<i>... y ${resto} mÃƒÂ¡s. EscribÃƒÂ­ parte del nombre para filtrar.</i>`);
  return lineas.join("\n");
}

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Quita el sufijo de perÃƒÂ­odo "-2026-4" para comparar tipos de documentos
const baseNombreReq = (s) => String(s || "").replace(/-\d{4}-\d+$/i, "").trim().toLowerCase();

async function continuarAprendiendoDesdeConflicto(ctx, chatId) {
  const sesion = getSesion(chatId);
  const { pendingGrupos, pendingPaginasSinAsignar, pendingNombresReqs, pendingGrupoActual } = sesion;
  setSesion(chatId, { grupos: pendingGrupos, paginasSinAsignar: pendingPaginasSinAsignar, grupoActual: null, fase: "aprender_agrupando" });
  const confirmacion = `Ã¢Å“â€¦ ${pendingNombresReqs} = pÃƒÂ¡ginas ${pendingGrupoActual.paginas.join(", ")}\n\n`;

  if (!pendingPaginasSinAsignar.size) {
    const asignados = await guardarSesionMapeo(chatId);
    const resumen = asignados.map((g) => `Ã¢â‚¬Â¢ <b>${escapeHtml(g.req.nombre)}</b>${g.req.entidad ? ` (${escapeHtml(g.req.entidad)})` : ""} Ã¢â€ â€™ ${g.paginas.length} pÃƒÂ¡g.`).join("\n");
    setSesion(chatId, { fase: "aprender_preguntando_mas", grupos: [], imagenes: [], paginasSinAsignar: new Set() });
    return ctx.reply(confirmacion + `Todas las pÃƒÂ¡ginas mapeadas. Mapeo guardado:\n\n${resumen}\n\nÃ‚Â¿QuerÃƒÂ©s mapear otro documento? Mandame el PDF o escribÃƒÂ­ <b>no</b> para terminar.`, { parse_mode: "HTML" });
  }

  if (pendingPaginasSinAsignar.size === 1) {
    const [solaUnica] = pendingPaginasSinAsignar;
    setSesion(chatId, { grupoActual: { paginas: [solaUnica] }, fase: "aprender_asignando", filtroActual: null });
    return ctx.reply(
      confirmacion + `Solo queda la pÃƒÂ¡gina <b>${solaUnica}</b>. Ã‚Â¿A quÃƒÂ© requerimiento corresponde?\n\nEscribÃƒÂ­ parte del nombre para buscar, o <code>lista</code> para verlos todos.\n\n/listo para finalizar el mapeo.`,
      { parse_mode: "HTML" }
    );
  }

  return ctx.reply(confirmacion + msgAgrupar(pendingPaginasSinAsignar), { parse_mode: "HTML" });
}

async function mostrarListaMapeos(ctx, chatId, prefijo = "") {
  const lista = await leerTodosMapeosPorTipo(chatId);
  if (!lista.length) {
    resetSesion(chatId);
    return ctx.reply(prefijo + "No quedan mapeos guardados. UsÃƒÂ¡ /aprender para crear nuevos.", { parse_mode: "HTML" });
  }
  setSesion(chatId, { fase: "mapeos_lista", mapeosList: lista });
  const items = lista.map((m, i) => `${i + 1}. ${escapeHtml(m.nombre)} Ã¢â‚¬â€ ${m.paginas.length} pÃƒÂ¡g.`).join("\n");
  return ctx.reply(
    prefijo + `Ã°Å¸â€œÅ¡ <b>${lista.length} tipo${lista.length !== 1 ? "s" : ""} aprendido${lista.length !== 1 ? "s" : ""}:</b>\n\n${items}\n\nEscribÃƒÂ­ el nÃƒÂºmero del que querÃƒÂ©s revisar, o cualquier comando para salir.`,
    { parse_mode: "HTML" }
  );
}

function msgAgrupar(paginasDisponibles) {
  const lista = [...paginasDisponibles];
  const disponibles = lista.join(", ");
  const ejAgrupar = lista.length >= 2 ? `<code>${lista.slice(0, 2).join(",")}</code> para agrupar Ã‚Â· ` : "";
  return (
    `PÃƒÂ¡ginas disponibles: <b>${disponibles}</b>\n\n` +
    `AgrupÃƒÂ¡ pÃƒÂ¡ginas para asignarle un requerimiento, o elegÃƒÂ­ una sola.\n` +
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

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Comandos Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

bot.command("miid", (ctx) =>
  ctx.reply(`Tu chat ID es: <code>${ctx.chat.id}</code>`, { parse_mode: "HTML" })
);

bot.command("web", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const cliente = await cargarCliente(chatId);
  if (!cliente) return ctx.reply("No tengo tu cuenta registrada.");
  const token = generarTokenWeb(chatId);
  const webUrl = process.env.WEB_URL || "https://mapeos.controldoc.app";
  return ctx.reply(
    `Ã°Å¸Å’Â <b>Panel de mapeos</b>\n\nHacÃƒÂ© click en el link para acceder desde tu computadora:\n<a href="${webUrl}/auth?t=${token}">${webUrl}</a>\n\nÃ¢ÂÂ± El link expira en 10 minutos.`,
    { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
  );
});

bot.command("modelo", async (ctx) => {
  if (!ADMIN_IDS.includes(String(ctx.chat.id))) return;
  const arg = ctx.match?.trim().toLowerCase();
  if (!arg) {
    return ctx.reply(`Ã°Å¸Â¤â€“ Modelo actual: <b>${getCurrentProviderLabel()}</b>`, { parse_mode: "HTML" });
  }
  if (arg === "gemini") {
    setAiProvider("gemini");
    return ctx.reply(`Ã¢Å“â€¦ Cambiado a <b>${getCurrentProviderLabel()}</b>`, { parse_mode: "HTML" });
  }
  if (arg === "claude" || arg === "haiku") {
    setAiProvider("claude");
    return ctx.reply(`Ã¢Å“â€¦ Cambiado a <b>${getCurrentProviderLabel()}</b>`, { parse_mode: "HTML" });
  }
  return ctx.reply("Ã¢ÂÅ’ Opciones: <code>/modelo claude</code> o <code>/modelo gemini</code>", { parse_mode: "HTML" });
});

bot.command("nuevocliente", async (ctx) => {
  if (!ADMIN_IDS.includes(String(ctx.chat.id))) return;
  const match = ctx.match?.trim().match(/^(\S+)\s+(\S+)$/);
  if (!match) return ctx.reply("Uso: /nuevocliente NombreApellido CODIGO");
  const nombre = match[1].replace(/([A-Z])/g, " $1").trim().replace(/\b\w/g, (c) => c.toUpperCase());
  await guardarPendiente(match[2].trim(), nombre);
  return ctx.reply(`Ã¢Å“â€¦ CÃƒÂ³digo <code>${match[2]}</code> listo para <b>${nombre}</b>.`, { parse_mode: "HTML" });
});

bot.command("config", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const cliente = await cargarCliente(chatId);
  if (!cliente) return ctx.reply("No tengo tu cuenta registrada.");
  setSesion(chatId, { fase: "config_esperando_user" });
  return ctx.reply(
    "Ã¢Å¡â„¢Ã¯Â¸Â ConfiguraciÃƒÂ³n de cuenta de controldocumentario.com\n\nMandame tu <b>usuario de control documentario</b> (email):",
    { parse_mode: "HTML" }
  );
});

bot.command("pendientes", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const cliente = await cargarCliente(chatId);
  if (!cliente) return ctx.reply("No tengo tu cuenta registrada.");
  if (!cliente.cdUser || !cliente.cdPass)
    return ctx.reply("Ã¢ÂÅ’ No tenÃƒÂ©s cuenta configuradas. UsÃƒÂ¡ /config primero.");

  await ctx.reply("Ã¢ÂÂ³ Consultando requerimientos pendientesÃ¢â‚¬Â¦");
  try {
    const sesCD = await cdObtenerSesionActiva(chatId, cliente.cdUser, cliente.cdPass);
    if (!sesCD.ok) {
      if (sesCD.screenshot) {
        return ctx.replyWithPhoto(new InputFile(sesCD.screenshot, "login.jpg"), { caption: `Ã¢ÂÅ’ ${sesCD.motivo}` });
      }
      return ctx.reply(`Ã¢ÂÅ’ ${sesCD.motivo}`);
    }

    const reqs = await cdLeerRequerimientos(sesCD.page);
    if (!reqs.length)
      return ctx.reply("Ã¢Å“â€¦ No hay requerimientos pendientes en CD.");

    const lineas = reqs.map((r, i) => {
      const entidad = r.entidad ? ` Ã¢â‚¬â€ <i>${escapeHtml(r.entidad)}</i>` : "";
      return `${i + 1}. ${escapeHtml(r.nombre)}${entidad}`;
    });

    return ctx.reply(
      `Ã°Å¸â€œâ€¹ <b>${reqs.length} requerimiento${reqs.length !== 1 ? "s" : ""} pendiente${reqs.length !== 1 ? "s" : ""}:</b>\n\n${lineas.join("\n")}`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    cdInvalidarSesion(chatId);
    console.error("[PENDIENTES]", e.message);
    return ctx.reply(`Ã¢ÂÅ’ Error: ${e.message}`);
  }
});

bot.command("vencimientos", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const cliente = await cargarCliente(chatId);
  if (!cliente) return ctx.reply("No tengo tu cuenta registrada.");
  if (!cliente.cdUser || !cliente.cdPass)
    return ctx.reply("Ã¢ÂÅ’ No tenÃƒÂ©s credenciales configuradas. UsÃƒÂ¡ /config primero.");

  const diasP = cliente.diasPersonal ?? 10;
  const diasV = cliente.diasVehiculos ?? 10;
  const diasE = cliente.diasEmpresa ?? 10;
  await ctx.reply(`Ã°Å¸â€Å½ Consultando vencimientos (empresa: ${diasE}d Ã‚Â· personal: ${diasP}d Ã‚Â· vehÃƒÂ­culos: ${diasV}d)Ã¢â‚¬Â¦`);

  try {
    const sesCD = await cdObtenerSesionActiva(chatId, cliente.cdUser, cliente.cdPass);
    if (!sesCD.ok) {
      if (sesCD.screenshot)
        return ctx.replyWithPhoto(new InputFile(sesCD.screenshot, "login.jpg"), { caption: `Ã¢ÂÅ’ ${sesCD.motivo}` });
      return ctx.reply(`Ã¢ÂÅ’ ${sesCD.motivo}`);
    }

    const { items, screenshots, debugPorTipo } = await cdLeerVencimientos(sesCD.page, diasP, diasV, diasE);
    const debugLines = [];
    for (const tipo of ["general", "empresa", "personal", "vehiculo"]) {
      const lista = Array.isArray(debugPorTipo?.[tipo]) ? debugPorTipo[tipo] : [];
      if (!lista.length) {
        debugLines.push(`${tipo}: sin fecha detectada`);
        continue;
      }
      debugLines.push(`${tipo}:`);
      for (const item of lista) {
        debugLines.push(`- ${item.columna} | ${item.nombre} | ${item.fecha} | ${item.diasFaltantes}d`);
      }
    }
    const debugTxt = `\n\n<code>Debug por tipo:\n${escapeHtml(debugLines.join("\n"))}</code>`;

    if (!items.length) {
      await ctx.reply(
        `✅ <b>Todo OK</b> — sin vencimientos próximos.\n\n<i>Empresa: ${diasE}d · Personal: ${diasP}d · Vehículos: ${diasV}d</i>${debugTxt}`,
        { parse_mode: "HTML" }
      );
      for (const ss of screenshots) await ctx.replyWithPhoto(new InputFile(ss.buffer, ss.nombre));
      return;
    }

    await ctx.reply(debugTxt, { parse_mode: "HTML" });

    for (const chunk of _chunksVenc(_buildMsgVencimientos(items, diasP, diasV, diasE)))
      await ctx.reply(chunk, { parse_mode: "HTML" });
    for (const ss of screenshots) await ctx.replyWithPhoto(new InputFile(ss.buffer, ss.nombre));
  } catch (e) {
    cdInvalidarSesion(chatId);
    console.error("[VENCIMIENTOS]", e.message);
    return ctx.reply(`Ã¢ÂÅ’ Error: ${e.message}`);
  }
});

bot.command("aprender", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const cliente = await cargarCliente(chatId);
  if (!cliente) return ctx.reply("No tengo tu cuenta registrada.");
  if (!cliente.cdUser || !cliente.cdPass)
    return ctx.reply("Ã¢ÂÅ’ No tenÃƒÂ©s credenciales de CD configuradas. ContactÃƒÂ¡ al administrador.");

  await ctx.reply("Ã¢ÂÂ³ Conectando a controldocumentario.comÃ¢â‚¬Â¦");

  try {
    const sesion = await cdObtenerSesionActiva(chatId, cliente.cdUser, cliente.cdPass);
    if (!sesion.ok) {
      if (sesion.screenshot) {
        await ctx.replyWithPhoto(new InputFile(sesion.screenshot, "login.jpg"), { caption: `Ã¢ÂÅ’ ${sesion.motivo}` });
      } else {
        await ctx.reply(`Ã¢ÂÅ’ ${sesion.motivo}`);
      }
      return;
    }

    const nombres = await cdLeerTiposRequerimientos(sesion.page);

    if (!nombres.length)
      return ctx.reply("No encontrÃƒÂ© tipos de requerimientos en tu cuenta de CD.");

    const tiposUnicos = nombres.map((nombre) => ({ nombre, entidad: "", href: "" }));
    setSesion(chatId, { fase: "aprender_esperando_pdf", requerimientos: tiposUnicos });

    const mapeosYa = await leerTodosMapeosPorTipo(chatId);
    if (mapeosYa.length > 0) {
      const lista = mapeosYa.map((m) => `Ã¢â‚¬Â¢ ${escapeHtml(m.nombre)} (${m.paginas.length} pÃƒÂ¡g.)`).join("\n");
      await ctx.reply(
        `Ã°Å¸â€œÅ¡ Ya tenÃƒÂ©s <b>${mapeosYa.length}</b> tipo${mapeosYa.length !== 1 ? "s" : ""} aprendido${mapeosYa.length !== 1 ? "s" : ""}:\n\n${lista}\n\nÃ°Å¸â€™Â¡ Si querÃƒÂ©s revisar, editar o eliminar alguno, usÃƒÂ¡ /mapeos antes de continuar.`,
        { parse_mode: "HTML" }
      );
    }

    return ctx.reply(
      `Ã¢Å“â€¦ ${tiposUnicos.length} tipo${tiposUnicos.length !== 1 ? "s" : ""} de requerimiento encontrado${tiposUnicos.length !== 1 ? "s" : ""}.\n\nMandame el PDF de referencia para agregar o actualizar un tipo de documento.`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    cdInvalidarSesion(chatId);
    console.error("[APRENDER]", e.message);
    return ctx.reply(`Ã¢ÂÅ’ Error conectando a CD: ${e.message}`);
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
    return ctx.reply("Ã¢ÂÅ’ No tenÃƒÂ©s credenciales configuradas. UsÃƒÂ¡ /config primero.");

  await ctx.reply("Ã¢ÂÂ³ Consultando tipos de requerimientosÃ¢â‚¬Â¦");
  try {
    const sesCD = await cdObtenerSesionActiva(chatId, cliente.cdUser, cliente.cdPass);
    if (!sesCD.ok) {
      if (sesCD.screenshot)
        return ctx.replyWithPhoto(new InputFile(sesCD.screenshot, "login.jpg"), { caption: `Ã¢ÂÅ’ ${sesCD.motivo}` });
      return ctx.reply(`Ã¢ÂÅ’ ${sesCD.motivo}`);
    }

    const tipos = await cdLeerTiposRequerimientos(sesCD.page);
    if (!tipos.length)
      return ctx.reply("No encontrÃƒÂ© tipos de requerimientos en CD.");

    // tipos is a flat array of strings (req names)
    const lista = tipos.map((nombre) => ({ nombre }));
    setSesion(chatId, { fase: "generar_buscando", lista, filtroActual: null, cdUser: cliente.cdUser, cdPass: cliente.cdPass });

    const lineas = lista.slice(0, 20).map((r, i) => `${i + 1}. ${escapeHtml(r.nombre)}`);
    if (lista.length > 20) lineas.push(`\n<i>... y ${lista.length - 20} mÃƒÂ¡s. EscribÃƒÂ­ parte del nombre para filtrar.</i>`);
    return ctx.reply(
      `Ã°Å¸â€œâ€¹ <b>${lista.length} tipo${lista.length !== 1 ? "s" : ""} de requerimiento${lista.length !== 1 ? "s" : ""}:</b>\n\n${lineas.join("\n")}\n\nEscribÃƒÂ­ el nÃƒÂºmero o parte del nombre para buscar.`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    cdInvalidarSesion(chatId);
    console.error("[GENERAR-CMD]", e.message);
    return ctx.reply(`Ã¢ÂÅ’ Error: ${e.message}`);
  }
});

bot.command("unico", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const cliente = await cargarCliente(chatId);
  if (!cliente) return ctx.reply("No tengo tu cuenta registrada.");
  if (!cliente.cdUser || !cliente.cdPass)
    return ctx.reply("Ã¢ÂÅ’ No tenÃƒÂ©s credenciales configuradas. UsÃƒÂ¡ /config primero.");
  setSesion(chatId, { fase: "unico_esperando_pdf" });
  return ctx.reply("Ã°Å¸â€œÅ½ Modo ÃƒÂºnico activado. Mandame el PDF a subir.");
});

bot.command("partemes", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const cliente = await cargarCliente(chatId);
  if (!cliente) return ctx.reply("No tengo tu cuenta registrada.");
  if (!cliente.cdUser || !cliente.cdPass)
    return ctx.reply("Ã¢ÂÅ’ No tenÃƒÂ©s credenciales configuradas. UsÃƒÂ¡ /config primero.");

  await ctx.reply("Ã¢ÂÂ³ Grabando parte mensualÃ¢â‚¬Â¦");
  try {
    const sesCD = await cdObtenerSesionActiva(chatId, cliente.cdUser, cliente.cdPass);
    if (!sesCD.ok) {
      if (sesCD.screenshot)
        return ctx.replyWithPhoto(new InputFile(sesCD.screenshot, "login.jpg"), { caption: `Ã¢ÂÅ’ ${sesCD.motivo}` });
      return ctx.reply(`Ã¢ÂÅ’ ${sesCD.motivo}`);
    }
    const { personal, maquinas } = await cdGrabarParteMensual(sesCD.page);
    return ctx.reply(_msgParteMensual(personal, maquinas), { parse_mode: "HTML" });
  } catch (e) {
    cdInvalidarSesion(chatId);
    console.error("[PARTEMES]", e.message);
    return ctx.reply(`Ã¢ÂÅ’ Error grabando parte mensual: ${e.message}`);
  }
});

bot.command("estado", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const cliente = await cargarCliente(chatId);
  if (!cliente) return ctx.reply("No tengo tu cuenta registrada.");

  const mapeos = await leerTodosMapeosPorTipo(chatId);
  const cuentaCD = cliente.cdUser
    ? `Ã¢Å“â€¦ <code>${escapeHtml(cliente.cdUser)}</code>`
    : "Ã¢ÂÅ’ No configurada Ã¢â‚¬â€ usÃƒÂ¡ /config";

  return ctx.reply(
    `Ã°Å¸â€˜Â¤ <b>${escapeHtml(cliente.nombre)}</b>\n\nCuenta CD: ${cuentaCD}\nMapeos aprendidos: <b>${mapeos.length}</b>`,
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
    return ctx.reply("No quedÃƒÂ³ ningÃƒÂºn grupo asignado. EmpezÃƒÂ¡ de nuevo con /aprender.");
  }

  const resumen = asignados
    .map(
      (g) =>
        `Ã¢â‚¬Â¢ <b>${escapeHtml(g.req.nombre)}</b>${g.req.entidad ? ` (${escapeHtml(g.req.entidad)})` : ""} Ã¢â€ â€™ ${g.paginas.length} pÃƒÂ¡g.`
    )
    .join("\n");

  const sinAsignar = sesion.paginasSinAsignar?.size || 0;
  const nota = sinAsignar > 0 ? `\n\nÃ¢Å¡Â Ã¯Â¸Â ${sinAsignar} pÃƒÂ¡gina${sinAsignar !== 1 ? "s" : ""} sin mappear.` : "";

  setSesion(chatId, { fase: "aprender_preguntando_mas", grupos: [], imagenes: [], paginasSinAsignar: new Set() });
  return ctx.reply(`Ã¢Å“â€¦ Mapeo guardado:\n\n${resumen}${nota}\n\nÃ‚Â¿QuerÃƒÂ©s mapear otro documento? Mandame el PDF o escribÃƒÂ­ <b>no</b> para terminar.`, { parse_mode: "HTML" });
});

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Manejador principal Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

bot.on("message", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const texto = (ctx.message.text || "").trim();
  const sesion = getSesion(chatId);

  // Ã¢â€â‚¬Ã¢â€â‚¬ PDF recibido Ã¢â€â‚¬Ã¢â€â‚¬
  if (ctx.message.document?.mime_type === "application/pdf") {
    const cliente = await cargarCliente(chatId);
    if (!cliente) return ctx.reply("No te conozco. Ã‚Â¿ContraseÃƒÂ±a?");

    // Mapeos: reemplazar referencia de un mapeo existente
    if (sesion.fase === "mapeos_reemplazando_pdf") {
      const { mapeoActual } = sesion;
      await ctx.reply("Ã°Å¸â€œâ€ž Renderizando pÃƒÂ¡ginas de referenciaÃ¢â‚¬Â¦");
      try {
        const buffer = await bajarPdf(ctx);
        const imagenes = await pdfAImagenes(buffer);

        for (const { pagina, base64 } of imagenes) {
          await ctx.replyWithPhoto(new InputFile(Buffer.from(base64, "base64"), `p${pagina}.jpg`), {
            caption: `PÃƒÂ¡gina ${pagina}`,
          });
        }

        if (imagenes.length === 1) {
          const bruto = await leerMapeoBruto(chatId, mapeoActual.nombre);
          await guardarMapeo(chatId, mapeoActual.nombre, {
            paginas: [{ num: 1, imagen: imagenes[0].base64, texto: "" }],
            href: bruto?.href || "",
            entidad: bruto?.entidad || "",
          });
          return await mostrarListaMapeos(ctx, chatId, `Ã¢Å“â€¦ "<b>${escapeHtml(mapeoActual.nombre)}</b>" actualizado con 1 pÃƒÂ¡gina.\n\n`);
        }

        const nums = imagenes.map((i) => i.pagina).join(", ");
        setSesion(chatId, { fase: "mapeos_reemplazando_paginas", imagenes });
        return ctx.reply(
          `Ã¢Å“â€¦ ${imagenes.length} pÃƒÂ¡ginas listas: <b>${nums}</b>\n\nÃ‚Â¿CuÃƒÂ¡les van en "<b>${escapeHtml(mapeoActual.nombre)}</b>"?\nEscribÃƒÂ­ los nÃƒÂºmeros separados por coma, o <code>todas</code>.`,
          { parse_mode: "HTML" }
        );
      } catch (e) {
        resetSesion(chatId);
        return ctx.reply(`Ã¢ÂÅ’ Error renderizando: ${e.message}`);
      }
    }

    // Aprender: PDF nuevo como referencia para requerimiento conflictivo
    if (sesion.fase === "aprender_overwrite_nuevo_pdf") {
      const { pendingConflictosReqs } = sesion;
      await ctx.reply("Ã°Å¸â€œâ€ž Renderizando pÃƒÂ¡ginas de referenciaÃ¢â‚¬Â¦");
      try {
        const buffer = await bajarPdf(ctx);
        const imagenes = await pdfAImagenes(buffer);

        for (const { pagina, base64 } of imagenes) {
          await ctx.replyWithPhoto(new InputFile(Buffer.from(base64, "base64"), `p${pagina}.jpg`), { caption: `PÃƒÂ¡gina ${pagina}` });
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
          `Ã¢Å“â€¦ ${imagenes.length} pÃƒÂ¡ginas listas: <b>${nums}</b>\n\nÃ‚Â¿CuÃƒÂ¡les van en ${nombres}?\nEscribÃƒÂ­ los nÃƒÂºmeros separados por coma, o <code>todas</code>.`,
          { parse_mode: "HTML" }
        );
      } catch (e) {
        return ctx.reply(`Ã¢ÂÅ’ Error renderizando: ${e.message}`);
      }
    }

    // Modo ÃƒÂºnico: subir PDF sin procesar
    if (sesion.fase === "unico_esperando_pdf") {
      await ctx.reply("Ã¢ÂÂ³ Cargando requerimientos de CDÃ¢â‚¬Â¦");
      try {
        const buffer = await bajarPdf(ctx);
        const sesCD = await cdObtenerSesionActiva(chatId, cliente.cdUser, cliente.cdPass);
        if (!sesCD.ok) {
          resetSesion(chatId);
          if (sesCD.screenshot) {
            return ctx.replyWithPhoto(new InputFile(sesCD.screenshot, "login.jpg"), { caption: `Ã¢ÂÅ’ ${sesCD.motivo}` });
          }
          return ctx.reply(`Ã¢ÂÅ’ ${sesCD.motivo}`);
        }
        const reqs = await cdLeerRequerimientos(sesCD.page);
        if (!reqs.length) {
          resetSesion(chatId);
          return ctx.reply("No hay requerimientos pendientes en CD.");
        }
        setSesion(chatId, { fase: "unico_buscando_req", buffer, requerimientos: reqs, filtroActual: null, cdUser: cliente.cdUser, cdPass: cliente.cdPass });
        return ctx.reply(
          `Ã°Å¸â€œâ€¹ ${reqs.length} requerimiento${reqs.length !== 1 ? "s" : ""} pendiente${reqs.length !== 1 ? "s" : ""}.\n\n${formatearReqs(reqs)}\n\nEscribÃƒÂ­ el nombre o parte para buscar, o <code>lista</code> para verlos todos.`,
          { parse_mode: "HTML" }
        );
      } catch (e) {
        cdInvalidarSesion(chatId);
        resetSesion(chatId);
        return ctx.reply(`Ã¢ÂÅ’ Error: ${e.message}`);
      }
    }

    // Aprender: PDF de referencia (primera vez o tras guardar)
    if (sesion.fase === "aprender_esperando_pdf" || sesion.fase === "aprender_preguntando_mas") {
      await ctx.reply("Ã°Å¸â€œâ€ž Renderizando pÃƒÂ¡ginas de referenciaÃ¢â‚¬Â¦");
      try {
        const buffer = await bajarPdf(ctx);
        const imagenes = await pdfAImagenes(buffer);

        for (const { pagina, base64 } of imagenes) {
          await ctx.replyWithPhoto(new InputFile(Buffer.from(base64, "base64"), `p${pagina}.jpg`), {
            caption: `PÃƒÂ¡gina ${pagina}`,
          });
        }

        const todasLasPaginas = new Set(imagenes.map((i) => i.pagina));

        if (imagenes.length === 1) {
          setSesion(chatId, { fase: "aprender_asignando", buffer, imagenes, grupos: [], paginasSinAsignar: todasLasPaginas, grupoActual: { paginas: [1] }, filtroActual: null });
          return ctx.reply(
            `Ã¢Å“â€¦ 1 pÃƒÂ¡gina lista.\n\nÃ‚Â¿A quÃƒÂ© requerimiento corresponde?\n\nEscribÃƒÂ­ parte del nombre para buscar, o <code>lista</code> para verlos todos.\n\n/listo para finalizar.`,
            { parse_mode: "HTML" }
          );
        }

        setSesion(chatId, { fase: "aprender_agrupando", buffer, imagenes, grupos: [], paginasSinAsignar: todasLasPaginas });
        return ctx.reply(`Ã¢Å“â€¦ ${imagenes.length} pÃƒÂ¡ginas listas.\n\n` + msgAgrupar(todasLasPaginas), { parse_mode: "HTML" });
      } catch (e) {
        console.error("[PDF ERROR]", e.message);
        return ctx.reply(`Ã¢ÂÅ’ Error renderizando: ${e.message}`);
      }
    }

    // Modo trabajar: analizar y subir
    await ctx.reply("Ã¢ÂÂ³ Analizando documentosÃ¢â‚¬Â¦");
    try {
      const buffer = await bajarPdf(ctx);
      const imagenes = await pdfAImagenes(buffer);

      const mapeos = await leerTodosMapeosPorTipo(chatId);
      if (!mapeos.length)
        return ctx.reply("Ã¢ÂÅ’ No tenÃƒÂ©s mapeos configurados. UsÃƒÂ¡ /aprender primero para enseÃƒÂ±arme los tipos de documentos.");

      await ctx.reply(`Ã°Å¸â€â€” ${imagenes.length} pÃƒÂ¡ginas listas. Leyendo requerimientos de CDÃ¢â‚¬Â¦`);
      const sesCD = await cdObtenerSesionActiva(chatId, cliente.cdUser, cliente.cdPass);
      if (!sesCD.ok) {
        if (sesCD.screenshot) {
          return ctx.replyWithPhoto(new InputFile(sesCD.screenshot, "login.jpg"), { caption: `Ã¢ÂÅ’ ${sesCD.motivo}` });
        }
        return ctx.reply(`Ã¢ÂÅ’ Error conectando a CD: ${sesCD.motivo}`);
      }

      const reqs = await cdLeerRequerimientos(sesCD.page);
      if (!reqs.length)
        return ctx.reply("No hay requerimientos pendientes en CD por el momento.");

      await ctx.reply(`Ã°Å¸Â¤â€“ Clasificando ${imagenes.length} pÃƒÂ¡ginas contra ${reqs.length} requerimientos pendientesÃ¢â‚¬Â¦`);
      const resultado = await matchearPaginasConReqs(imagenes, mapeos, reqs, cliente.nombreEmpresa || "");

      if (!resultado || (!resultado.grupos.length && !resultado.sinRequerido?.length))
        return ctx.reply("Ã¢ÂÅ’ No pude identificar los documentos. VerificÃƒÂ¡ que el PDF coincide con los mapeos configurados.");

      const totalSubidas = resultado.grupos.reduce((s, g) => s + g.reqs.length, 0);

      // Debug: clasificaciÃƒÂ³n por pÃƒÂ¡gina
      if (resultado.paginasClasificadas?.length) {
        const debugLineas = resultado.paginasClasificadas.map(
          (p) => `  pÃƒÂ¡g ${p.pagina}: <i>${escapeHtml(p.tipo_detectado || "?")}</i>${p.entidad_detectada ? ` Ã¢â‚¬â€ <b>${escapeHtml(p.entidad_detectada)}</b>` : " (sin entidad)"}`
        ).join("\n");
        await ctx.reply(`Ã°Å¸â€Â <b>ClasificaciÃƒÂ³n detectada:</b>\n${debugLineas}`, { parse_mode: "HTML" });
      }

      const _parseTotalMeses = (nombre) => {
        const m = String(nombre || "").match(/-(\d{4})-(\d+)$/i);
        return m ? parseInt(m[1]) * 12 + parseInt(m[2]) : null;
      };
      const _now = new Date();
      const _totalMesesActual = _now.getFullYear() * 12 + (_now.getMonth() + 1);

      const lineas = resultado.grupos.map((g, i) => {
        const pags = g.paginas.slice().sort((a, b) => a - b).join(", ");
        const reqsStr = g.reqs.map((r) => `  Ã¢â‚¬Â¢ <i>${escapeHtml(r.nombre)}</i>`).join("\n");
        let linea = `${i + 1}. <b>${escapeHtml(g.entidad || "Sin entidad")}</b> Ã¢â€ â€™ pÃƒÂ¡gs. ${pags}\n${reqsStr}`;
        if (g.omitidos?.length) {
          const omitStr = g.omitidos.map((r) => `  Ã¢ÂÂ© <i>${escapeHtml(r.nombre)}</i>`).join("\n");
          linea += `\n${omitStr} (perÃƒÂ­odo anterior, no se sube)`;
        }
        const maxTotalMeses = Math.max(...g.reqs.map((r) => _parseTotalMeses(r.nombre) ?? 0));
        const mesesAtras = _totalMesesActual - maxTotalMeses;
        if (maxTotalMeses > 0 && mesesAtras >= 2) {
          linea += `\n  Ã¢Å¡Â Ã¯Â¸Â El req mÃƒÂ¡s reciente estÃƒÂ¡ ${mesesAtras} mes${mesesAtras !== 1 ? "es" : ""} atrÃƒÂ¡s del mes actual`;
        }
        return linea;
      });
      if (resultado.sinAsignar.length)
        lineas.push(`\nÃ¢Å¡Â Ã¯Â¸Â Sin identificar: pÃƒÂ¡ginas ${resultado.sinAsignar.join(", ")}`);

      const sinRequerido = resultado.sinRequerido || [];
      if (sinRequerido.length) {
        const srStr = sinRequerido.map((item) => {
          const pags = item.paginas.slice().sort((a, b) => a - b).join(", ");
          const entidad = item.entidad ? ` (<i>${escapeHtml(item.entidad)}</i>)` : "";
          return `  Ã¢Å¡Â¡ PÃƒÂ¡gs. ${pags} Ã¢â€ â€™ <i>${escapeHtml(item.tipo)}</i>${entidad} Ã¢â‚¬â€ sin requerido en CD`;
        }).join("\n");
        lineas.push(`\n${srStr}`);
      }

      setSesion(chatId, {
        fase: "trabajar_confirmando",
        buffer,
        gruposSubir: resultado.grupos,
        sinRequerido,
        cdUser: cliente.cdUser,
        cdPass: cliente.cdPass,
      });

      const encabezado = resultado.grupos.length
        ? `Ã°Å¸â€œâ€¹ <b>${resultado.grupos.length} grupo${resultado.grupos.length !== 1 ? "s" : ""}, ${totalSubidas} subida${totalSubidas !== 1 ? "s" : ""}:</b>`
        : `Ã°Å¸â€œâ€¹ <b>Sin coincidencias directas con requeridos pendientes.</b>`;

      const pregunta = resultado.grupos.length
        ? `Ã‚Â¿Confirmar y subir todo? (sÃƒÂ­ / no)`
        : `Ã‚Â¿Procedemos a generar los requeridos faltantes? (sÃƒÂ­ / no)`;

      return ctx.reply(
        `${encabezado}\n\n${lineas.join("\n\n")}\n\n${pregunta}`,
        { parse_mode: "HTML" }
      );
    } catch (e) {
      console.error("[TRABAJAR]", e.message);
      return ctx.reply(`Ã¢ÂÅ’ Error: ${e.message}`);
    }
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Config: esperando usuario de CD Ã¢â€â‚¬Ã¢â€â‚¬
  if (sesion.fase === "config_esperando_user" && texto && !texto.startsWith("/")) {
    setSesion(chatId, { fase: "config_esperando_pass", cdUserTemp: texto });
    return ctx.reply("Ahora mandame la <b>contraseÃƒÂ±a de control documentario</b>:", { parse_mode: "HTML" });
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Config: esperando contraseÃƒÂ±a de CD Ã¢â€â‚¬Ã¢â€â‚¬
  if (sesion.fase === "config_esperando_pass" && texto && !texto.startsWith("/")) {
    const cdUser = sesion.cdUserTemp;
    const cdPass = texto;
    await ctx.reply("Ã¢ÂÂ³ Probando credencialesÃ¢â‚¬Â¦");

    try {
      // Invalidar sesiÃƒÂ³n cacheada Ã¢â‚¬â€ credenciales nuevas requieren login fresco
      cdInvalidarSesion(chatId);
      const sesion = await cdObtenerSesionActiva(chatId, cdUser, cdPass);

      if (!sesion.ok) {
        resetSesion(chatId);
        if (sesion.screenshot) {
          await ctx.replyWithPhoto(new InputFile(sesion.screenshot, "login.jpg"), {
            caption: `Ã¢ÂÅ’ ${sesion.motivo}\n\nUsÃƒÂ¡ /config para intentar de nuevo.`,
          });
        } else {
          await ctx.reply(`Ã¢ÂÅ’ ${sesion.motivo}\n\nUsÃƒÂ¡ /config para intentar de nuevo.`);
        }
        return;
      }

      await actualizarCliente(chatId, { cdUser, cdPass });

      // Intentar detectar el nombre de la empresa automÃƒÂ¡ticamente
      const nombreDetectado = await cdDetectarNombreEmpresa(sesion.page);
      if (nombreDetectado) {
        await actualizarCliente(chatId, { nombreEmpresa: nombreDetectado });
        resetSesion(chatId);
        return ctx.reply(
          `Ã¢Å“â€¦ Credenciales guardadas.\n\nDetectÃƒÂ© que tu empresa es: <b>${escapeHtml(nombreDetectado)}</b>\n\nEste nombre se usarÃƒÂ¡ para distinguir documentos de empresa de los personales. Si es incorrecto, mandÃƒÂ¡ el nombre correcto ahora o escribÃƒÂ­ <code>ok</code> para continuar.`,
          { parse_mode: "HTML" }
        );
        // La sesiÃƒÂ³n se resetea pero si el usuario responde con el nombre correcto no habrÃƒÂ¡ fase activa
        // Ã¢â‚¬â€ se maneja en el bloque de texto libre abajo
      }

      setSesion(chatId, { fase: "config_esperando_empresa", cdUser, cdPass });
      return ctx.reply(
        `Ã¢Å“â€¦ Credenciales guardadas.\n\nÃ‚Â¿CuÃƒÂ¡l es el <b>nombre de tu empresa</b> tal como aparece en los documentos? (ej: "MATESIN, CLAUDIO FABIAN")\n\nEscribÃƒÂ­ el nombre o <code>omitir</code> si no querÃƒÂ©s configurarlo ahora.`,
        { parse_mode: "HTML" }
      );
    } catch (e) {
      cdInvalidarSesion(chatId);
      resetSesion(chatId);
      return ctx.reply(`Ã¢ÂÅ’ Error probando credenciales: ${e.message}\n\nUsÃƒÂ¡ /config para intentar de nuevo.`);
    }
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Config: esperando nombre de empresa Ã¢â€â‚¬Ã¢â€â‚¬
  if (sesion.fase === "config_esperando_empresa" && texto && !texto.startsWith("/")) {
    if (!/^omitir$/i.test(texto)) {
      await actualizarCliente(chatId, { nombreEmpresa: texto.trim() });
    }
    resetSesion(chatId);
    return ctx.reply("Ã¢Å“â€¦ Listo. Ya podÃƒÂ©s usar /aprender.");
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Aprender: agrupando pÃƒÂ¡ginas Ã¢â€â‚¬Ã¢â€â‚¬
  if (sesion.fase === "aprender_agrupando" && texto && !texto.startsWith("/")) {
    const nums = texto
      .split(",")
      .map((s) => parseInt(s.trim()))
      .filter((n) => !isNaN(n));

    if (!nums.length)
      return ctx.reply("EscribÃƒÂ­ los nÃƒÂºmeros de pÃƒÂ¡gina separados por coma, ej: <code>1,2</code>", {
        parse_mode: "HTML",
      });

    const invalidas = nums.filter((n) => !sesion.paginasSinAsignar.has(n));
    if (invalidas.length)
      return ctx.reply(
        `Ã¢ÂÅ’ PÃƒÂ¡gina${invalidas.length > 1 ? "s" : ""} no disponible${invalidas.length > 1 ? "s" : ""}: ${invalidas.join(", ")}. Disponibles: ${[...sesion.paginasSinAsignar].join(", ")}`
      );

    setSesion(chatId, { grupoActual: { paginas: nums }, fase: "aprender_asignando", filtroActual: null });

    return ctx.reply(
      `Ã¢Å“â€¦ Grupo: pÃƒÂ¡ginas <b>${nums.join(", ")}</b>\n\nÃ‚Â¿A quÃƒÂ© requerimiento corresponde?\n\nEscribÃƒÂ­ algo para buscar en la lista, o <code>lista</code> para verla completa.\n\n/listo para finalizar el mapeo.`,
      { parse_mode: "HTML" }
    );
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Aprender: asignando requerimiento(s) Ã¢â€â‚¬Ã¢â€â‚¬
  if (sesion.fase === "aprender_asignando" && texto && !texto.startsWith("/")) {
    const listaActual = sesion.filtroActual || sesion.requerimientos;

    // "lista" Ã¢â€ â€™ mostrar todo paginado
    if (texto.toLowerCase() === "lista") {
      setSesion(chatId, { filtroActual: sesion.requerimientos });
      return ctx.reply(
        `Ã°Å¸â€œâ€¹ ${sesion.requerimientos.length} requerimientos:\n\n${formatearReqs(sesion.requerimientos)}\n\nEscribÃƒÂ­ un nÃƒÂºmero para seleccionar, o texto para seguir filtrando.\n\n/listo para finalizar el mapeo.`,
        { parse_mode: "HTML" }
      );
    }

    // Texto no numÃƒÂ©rico Ã¢â€ â€™ buscar en la lista completa
    const esNumerico = /^[\d,\s]+$/.test(texto);
    if (!esNumerico) {
      const filtro = texto.toLowerCase();
      const filtrados = sesion.requerimientos.filter((r) => r.nombre.toLowerCase().includes(filtro));
      if (!filtrados.length)
        return ctx.reply(`No encontrÃƒÂ© nada con "<b>${escapeHtml(texto)}</b>". ProbÃƒÂ¡ con otra palabra, o escribÃƒÂ­ <code>lista</code> para verlos todos.\n\n/listo para finalizar el mapeo.`, { parse_mode: "HTML" });
      setSesion(chatId, { filtroActual: filtrados });
      return ctx.reply(
        `Ã°Å¸â€Â ${filtrados.length} resultado${filtrados.length !== 1 ? "s" : ""}:\n\n${formatearReqs(filtrados, { mostrarTodos: true })}\n\nEscribÃƒÂ­ el nÃƒÂºmero para seleccionar.\n\n/listo para finalizar el mapeo.`,
        { parse_mode: "HTML" }
      );
    }

    const idxs = texto.split(",").map((s) => parseInt(s.trim()) - 1).filter((n) => !isNaN(n));
    const invalidos = idxs.filter((i) => i < 0 || i >= listaActual.length);
    if (!idxs.length || invalidos.length)
      return ctx.reply(`EscribÃƒÂ­ un nÃƒÂºmero del 1 al ${listaActual.length}, o texto para buscar.`, { parse_mode: "HTML" });

    const reqsElegidos = idxs.map((i) => listaActual[i]);

    // Detectar si algÃƒÂºn req seleccionado ya tiene mapeo guardado
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
            { caption: `Ã°Å¸â€œÅ’ "${escapeHtml(req.nombre)}" Ã¢â‚¬â€ ejemplo guardado (${mapeo.paginas.length} pÃƒÂ¡g.)` }
          );
        }
      }

      return ctx.reply(
        `Ã¢Å¡Â Ã¯Â¸Â ${nombresConflicto} ya ${conflictos.length === 1 ? "tiene" : "tienen"} un ejemplo guardado (imagen arriba).\n\nÃ‚Â¿QuÃƒÂ© querÃƒÂ©s hacer?\n<b>sÃƒÂ­</b> Ã¢â‚¬â€ reemplazar con las pÃƒÂ¡ginas que elegiste\n<b>no</b> Ã¢â‚¬â€ elegir otro requerimiento para estas pÃƒÂ¡ginas\n<b>otro</b> Ã¢â‚¬â€ subir un PDF diferente como referencia\n/mapeos Ã¢â‚¬â€ gestionar todos tus mapeos guardados\n\n/listo para finalizar el mapeo.`,
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

    // Si se mapearon todas las pÃƒÂ¡ginas, guardar y preguntar si continÃƒÂºa
    if (!paginasSinAsignar.size) {
      const asignados = await guardarSesionMapeo(chatId);
      const resumen = asignados
        .map((g) => `Ã¢â‚¬Â¢ <b>${escapeHtml(g.req.nombre)}</b>${g.req.entidad ? ` (${escapeHtml(g.req.entidad)})` : ""} Ã¢â€ â€™ ${g.paginas.length} pÃƒÂ¡g.`)
        .join("\n");
      setSesion(chatId, { fase: "aprender_preguntando_mas", grupos: [], imagenes: [], paginasSinAsignar: new Set() });
      return ctx.reply(`Ã¢Å“â€¦ ${nombresReqs} = pÃƒÂ¡ginas ${sesion.grupoActual.paginas.join(", ")}\n\nTodas las pÃƒÂ¡ginas mapeadas. Mapeo guardado:\n\n${resumen}\n\nÃ‚Â¿QuerÃƒÂ©s mapear otro documento? Mandame el PDF o escribÃƒÂ­ <b>no</b> para terminar.`, {
        parse_mode: "HTML",
      });
    }

    const confirmacion = `Ã¢Å“â€¦ ${nombresReqs} = pÃƒÂ¡ginas ${sesion.grupoActual.paginas.join(", ")}\n\n`;

    if (paginasSinAsignar.size === 1) {
      const [solaUnica] = paginasSinAsignar;
      setSesion(chatId, { grupoActual: { paginas: [solaUnica] }, fase: "aprender_asignando", filtroActual: null });
      return ctx.reply(
        confirmacion + `Solo queda la pÃƒÂ¡gina <b>${solaUnica}</b>. Ã‚Â¿A quÃƒÂ© requerimiento corresponde?\n\nEscribÃƒÂ­ parte del nombre para buscar, o <code>lista</code> para verlos todos.\n\n/listo para finalizar el mapeo.`,
        { parse_mode: "HTML" }
      );
    }

    return ctx.reply(confirmacion + msgAgrupar(paginasSinAsignar), { parse_mode: "HTML" });
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Aprender: preguntando si mapear otro documento Ã¢â€â‚¬Ã¢â€â‚¬
  if (sesion.fase === "aprender_preguntando_mas" && texto && !texto.startsWith("/")) {
    resetSesion(chatId);
    return ctx.reply("Ã‚Â¡Listo! PodÃƒÂ©s usar /aprender cuando quieras agregar mÃƒÂ¡s documentos.");
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Mapeos: seleccionando de la lista Ã¢â€â‚¬Ã¢â€â‚¬
  if (sesion.fase === "mapeos_lista" && texto && !texto.startsWith("/")) {
    const idx = parseInt(texto.trim()) - 1;
    if (isNaN(idx) || idx < 0 || idx >= sesion.mapeosList.length)
      return ctx.reply(`EscribÃƒÂ­ un nÃƒÂºmero del 1 al ${sesion.mapeosList.length}.`);

    const mapeo = sesion.mapeosList[idx];
    setSesion(chatId, { fase: "mapeos_viendo", mapeoActual: mapeo });

    for (const pag of mapeo.paginas) {
      await ctx.replyWithPhoto(
        new InputFile(Buffer.from(pag.imagen, "base64"), `ref${pag.num}.jpg`),
        { caption: `PÃƒÂ¡gina ${pag.num} de referencia` }
      );
    }

    return ctx.reply(
      `Ã°Å¸â€œÅ’ <b>${escapeHtml(mapeo.nombre)}</b> Ã¢â‚¬â€ ${mapeo.paginas.length} pÃƒÂ¡g.\n\nÃ‚Â¿QuÃƒÂ© querÃƒÂ©s hacer?\n<code>reemplazar</code> Ã¢â‚¬â€ subir nuevo PDF de referencia\n<code>eliminar</code> Ã¢â‚¬â€ borrar este mapeo\n<code>cancelar</code> Ã¢â‚¬â€ volver a la lista`,
      { parse_mode: "HTML" }
    );
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Mapeos: acciÃƒÂ³n sobre mapeo seleccionado Ã¢â€â‚¬Ã¢â€â‚¬
  if (sesion.fase === "mapeos_viendo" && texto && !texto.startsWith("/")) {
    const accion = texto.toLowerCase().trim();

    if (accion === "cancelar") {
      return mostrarListaMapeos(ctx, chatId);
    }

    if (accion === "eliminar") {
      setSesion(chatId, { fase: "mapeos_confirmando_eliminar" });
      return ctx.reply(
        `Ã¢Å¡Â Ã¯Â¸Â Ã‚Â¿Seguro que querÃƒÂ©s eliminar "<b>${escapeHtml(sesion.mapeoActual.nombre)}</b>"? (sÃƒÂ­ / no)`,
        { parse_mode: "HTML" }
      );
    }

    if (accion === "reemplazar") {
      setSesion(chatId, { fase: "mapeos_reemplazando_pdf" });
      return ctx.reply(
        `Ã°Å¸â€œÅ½ Mandame el nuevo PDF de referencia para "<b>${escapeHtml(sesion.mapeoActual.nombre)}</b>".`,
        { parse_mode: "HTML" }
      );
    }

    return ctx.reply(`EscribÃƒÂ­ <code>reemplazar</code>, <code>eliminar</code> o <code>cancelar</code>.`, { parse_mode: "HTML" });
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Mapeos: confirmando eliminaciÃƒÂ³n Ã¢â€â‚¬Ã¢â€â‚¬
  if (sesion.fase === "mapeos_confirmando_eliminar" && texto && !texto.startsWith("/")) {
    if (!/^s[iÃƒÂ­]/i.test(texto) && texto.toLowerCase() !== "ok") {
      setSesion(chatId, { fase: "mapeos_viendo" });
      return ctx.reply(
        `Cancelado. Ã‚Â¿QuÃƒÂ© querÃƒÂ©s hacer con "<b>${escapeHtml(sesion.mapeoActual.nombre)}</b>"?\n<code>reemplazar</code> / <code>eliminar</code> / <code>cancelar</code>`,
        { parse_mode: "HTML" }
      );
    }
    const nombre = sesion.mapeoActual.nombre;
    await eliminarMapeo(chatId, nombre);
    return await mostrarListaMapeos(ctx, chatId, `Ã¢Å“â€¦ "<b>${escapeHtml(nombre)}</b>" eliminado.\n\n`);
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Mapeos: eligiendo pÃƒÂ¡ginas para reemplazar Ã¢â€â‚¬Ã¢â€â‚¬
  if (sesion.fase === "mapeos_reemplazando_paginas" && texto && !texto.startsWith("/")) {
    const { imagenes, mapeoActual } = sesion;

    let paginasElegidas;
    if (texto.toLowerCase().trim() === "todas") {
      paginasElegidas = imagenes.map((i) => i.pagina);
    } else {
      const nums = texto.split(",").map((s) => parseInt(s.trim())).filter((n) => !isNaN(n));
      const invalidas = nums.filter((n) => !imagenes.find((i) => i.pagina === n));
      if (!nums.length || invalidas.length)
        return ctx.reply(`PÃƒÂ¡ginas disponibles: ${imagenes.map((i) => i.pagina).join(", ")}. EscribÃƒÂ­ los nÃƒÂºmeros o <code>todas</code>.`, { parse_mode: "HTML" });
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
    return await mostrarListaMapeos(ctx, chatId, `Ã¢Å“â€¦ "<b>${escapeHtml(mapeoActual.nombre)}</b>" actualizado con ${paginasRef.length} pÃƒÂ¡gina${paginasRef.length !== 1 ? "s" : ""}.\n\n`);
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Aprender: confirmando sobreescritura de mapeo Ã¢â€â‚¬Ã¢â€â‚¬
  if (sesion.fase === "aprender_confirmando_overwrite" && texto && !texto.startsWith("/")) {
    const accion = texto.toLowerCase().trim();

    if (accion === "otro") {
      setSesion(chatId, { fase: "aprender_overwrite_nuevo_pdf" });
      const nombres = sesion.pendingConflictosReqs.map((r) => `"${escapeHtml(r.nombre)}"`).join(", ");
      return ctx.reply(`Ã°Å¸â€œÅ½ Mandame el PDF de referencia para ${nombres}.`, { parse_mode: "HTML" });
    }

    if (!/^s[iÃƒÂ­]/i.test(texto) && accion !== "ok") {
      setSesion(chatId, { fase: "aprender_asignando", grupoActual: sesion.pendingGrupoActual, filtroActual: null });
      return ctx.reply(
        `Ok, no se reemplaza. Ã‚Â¿A quÃƒÂ© requerimiento querÃƒÂ©s asignar las pÃƒÂ¡ginas <b>${sesion.pendingGrupoActual.paginas.join(", ")}</b>?\n\nEscribÃƒÂ­ parte del nombre para buscar, o <code>lista</code> para verlos todos.\nÃ°Å¸â€™Â¡ O usÃƒÂ¡ /mapeos para gestionar los ejemplos guardados.\n\n/listo para finalizar el mapeo.`,
        { parse_mode: "HTML" }
      );
    }

    return continuarAprendiendoDesdeConflicto(ctx, chatId);
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Aprender: eligiendo pÃƒÂ¡ginas del PDF nuevo para overwrite Ã¢â€â‚¬Ã¢â€â‚¬
  if (sesion.fase === "aprender_overwrite_nuevo_paginas" && texto && !texto.startsWith("/")) {
    const { imagenes, pendingConflictosReqs } = sesion;

    let paginasElegidas;
    if (texto.toLowerCase().trim() === "todas") {
      paginasElegidas = imagenes.map((i) => i.pagina);
    } else {
      const nums = texto.split(",").map((s) => parseInt(s.trim())).filter((n) => !isNaN(n));
      const invalidas = nums.filter((n) => !imagenes.find((i) => i.pagina === n));
      if (!nums.length || invalidas.length)
        return ctx.reply(`PÃƒÂ¡ginas disponibles: ${imagenes.map((i) => i.pagina).join(", ")}. EscribÃƒÂ­ los nÃƒÂºmeros o <code>todas</code>.`, { parse_mode: "HTML" });
      paginasElegidas = nums;
    }

    const paginasRef = paginasElegidas.map((num) => ({ num, imagen: imagenes.find((i) => i.pagina === num).base64, texto: "" }));
    for (const req of pendingConflictosReqs) {
      const bruto = await leerMapeoBruto(chatId, req.nombre);
      await guardarMapeo(chatId, req.nombre, { paginas: paginasRef, href: bruto?.href || req.href || "", entidad: bruto?.entidad || req.entidad || "" });
    }
    return continuarAprendiendoDesdeConflicto(ctx, chatId);
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Trabajar: confirmaciÃƒÂ³n de subida Ã¢â€â‚¬Ã¢â€â‚¬
  if (sesion.fase === "trabajar_confirmando" && texto && !texto.startsWith("/")) {
    if (!/^s[iÃƒÂ­]/i.test(texto) && texto.toLowerCase() !== "ok") {
      resetSesion(chatId);
      return ctx.reply("Cancelado.");
    }

    const { buffer, gruposSubir, sinRequerido = [], cdUser, cdPass } = sesion;

    if (!gruposSubir.length && sinRequerido.length) {
      // Nothing to upload now, go straight to generables
      setSesion(chatId, { fase: "trabajar_generables", sinRequerido, pendientes: sinRequerido, indiceActual: 0, buffer, cdUser, cdPass });
      return _mostrarGenerables(ctx, chatId);
    }

    await ctx.reply("Ã¢ÂÂ³ Subiendo a controldocumentario.comÃ¢â‚¬Â¦");

    try {
      const sesCD = await cdObtenerSesionActiva(chatId, cdUser, cdPass);
      if (!sesCD.ok) {
        resetSesion(chatId);
        return ctx.reply(`Ã¢ÂÅ’ Error conectando a CD: ${sesCD.motivo}`);
      }

      let ok = 0, fail = 0;
      for (const grupo of gruposSubir) {
        const paginasOrdenadas = grupo.paginas.slice().sort((a, b) => a - b);
        console.log(`[SUBIDA] Grupo "${grupo.entidad}": solicitando pÃƒÂ¡gs ${paginasOrdenadas.join(",")}`);
        const bufferGrupo = await cortarPaginas(buffer, paginasOrdenadas);
        for (const req of grupo.reqs) {
          const nombre = `${req.nombre.replace(/[^a-z0-9]/gi, "_")}.pdf`;
          try {
            await cdSubirArchivo(sesCD.page, req.href, bufferGrupo, nombre, req.nombre, req.entidad);
            const entidad = grupo.entidad ? ` Ã¢â‚¬â€ ${escapeHtml(grupo.entidad)}` : "";
            await ctx.reply(`Ã¢Å“â€¦ ${escapeHtml(req.nombre)}${entidad}`);
            ok++;
          } catch (e) {
            const entidad = grupo.entidad ? ` Ã¢â‚¬â€ ${escapeHtml(grupo.entidad)}` : "";
            const caption = `Ã¢ÂÅ’ ${escapeHtml(req.nombre)}${entidad}: ${e.message}`;
            if (e.screenshot) {
              await ctx.replyWithPhoto(new InputFile(e.screenshot, "debug.jpg"), { caption });
            } else {
              await ctx.reply(caption);
            }
            fail++;
          }
        }
      }

      const todosOmitidos = gruposSubir.flatMap((g) => g.omitidos || []);
      let msgFinal = `Listo. ${ok} subido${ok !== 1 ? "s" : ""}${fail ? `, ${fail} con error` : ""}.`;
      if (todosOmitidos.length) {
        const omitStr = todosOmitidos
          .map((r) => `  Ã¢â‚¬Â¢ ${escapeHtml(r.nombre)}${r.entidad ? ` Ã¢â‚¬â€ <i>${escapeHtml(r.entidad)}</i>` : ""}`)
          .join("\n");
        msgFinal += `\n\nÃ¢Å¡Â Ã¯Â¸Â Quedaron pendientes (perÃƒÂ­odo anterior, subir aparte):\n${omitStr}`;
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
      return ctx.reply(`Ã¢ÂÅ’ Error durante la subida: ${e.message}`);
    }
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Trabajar: seleccionando cuÃƒÂ¡les generables procesar Ã¢â€â‚¬Ã¢â€â‚¬
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
        return ctx.reply(`EscribÃƒÂ­ nÃƒÂºmeros del 1 al ${sinRequerido.length}, <code>todo</code> para todos, o <code>omitir</code>.`, { parse_mode: "HTML" });
      seleccionados = indices.map((i) => sinRequerido[i]);
    }

    setSesion(chatId, { fase: "trabajar_generando", pendientes: seleccionados, indiceActual: 0, buffer, cdUser, cdPass });
    return _procesarSiguienteGenerable(ctx, chatId);
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Trabajar: el usuario elige el tipo manualmente Ã¢â€â‚¬Ã¢â€â‚¬
  if (sesion.fase === "trabajar_generando_tipo" && texto && !texto.startsWith("/")) {
    const TIPOS = ["empresa", "personal", "maquinas"];
    const n = parseInt(texto.trim());
    let tipo = null;
    if (n >= 1 && n <= 3) tipo = TIPOS[n - 1];
    else {
      const t = texto.toLowerCase().trim();
      tipo = TIPOS.find((x) => t.includes(x)) || null;
    }
    if (!tipo) return ctx.reply("EscribÃƒÂ­ <code>1</code> (empresa), <code>2</code> (personal) o <code>3</code> (mÃƒÂ¡quinas).", { parse_mode: "HTML" });

    const { itemActual } = sesion;
    await guardarTipoMapeo(chatId, itemActual.tipo, tipo);
    setSesion(chatId, { ...getSesion(chatId), fase: "trabajar_generando" });
    return _generarItem(ctx, chatId, itemActual, tipo);
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Trabajar: el usuario elige el sector manualmente Ã¢â€â‚¬Ã¢â€â‚¬
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
      return ctx.reply(`EscribÃƒÂ­ un nÃƒÂºmero del 1 al ${sectores.length}:\n${lineas.join("\n")}`, { parse_mode: "HTML" });
    }
    setSesion(chatId, { ...getSesion(chatId), fase: "trabajar_generando" });
    return _generarItem(ctx, chatId, itemActual, tipoActual, sectorElegido.value);
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ /generar: usuario busca y elige el tipo a generar Ã¢â€â‚¬Ã¢â€â‚¬
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
        return ctx.reply(`No encontrÃƒÂ© nada con "<b>${escapeHtml(texto)}</b>". ProbÃƒÂ¡ con otra palabra.`, { parse_mode: "HTML" });
      setSesion(chatId, { filtroActual: filtrados });
      const lineas = filtrados.map((r, i) => `${i + 1}. ${escapeHtml(r.nombre)}`);
      return ctx.reply(
        `Ã°Å¸â€Â ${filtrados.length} resultado${filtrados.length !== 1 ? "s" : ""}:\n\n${lineas.join("\n")}\n\nEscribÃƒÂ­ el nÃƒÂºmero para generar.`,
        { parse_mode: "HTML" }
      );
    }

    const idx = parseInt(texto.trim()) - 1;
    if (idx < 0 || idx >= listaActual.length)
      return ctx.reply(`EscribÃƒÂ­ un nÃƒÂºmero del 1 al ${listaActual.length}.`);

    const elegido = listaActual[idx];
    setSesion(chatId, { fase: "generar_confirmando", elegido, cdUser, cdPass });
    return ctx.reply(
      `Ã‚Â¿Generar requerimiento <b>${escapeHtml(elegido.nombre)}</b>? (sÃƒÂ­ / no)`,
      { parse_mode: "HTML" }
    );
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ /generar: confirmaciÃƒÂ³n Ã¢â€â‚¬Ã¢â€â‚¬
  if (sesion.fase === "generar_confirmando" && texto && !texto.startsWith("/")) {
    if (!/^s[iÃƒÂ­]/i.test(texto) && texto.toLowerCase() !== "ok") {
      resetSesion(chatId);
      return ctx.reply("Cancelado.");
    }

    const { elegido, cdUser, cdPass } = sesion;
    await ctx.reply(`Ã¢ÂÂ³ Generando <b>${escapeHtml(elegido.nombre)}</b>Ã¢â‚¬Â¦`, { parse_mode: "HTML" });

    let tipoGenerar = null;
    try {
      const sesCD = await cdObtenerSesionActiva(chatId, cdUser, cdPass);
      if (!sesCD.ok) throw new Error(sesCD.motivo);

      tipoGenerar = await leerTipoMapeo(chatId, elegido.nombre);

      if (!tipoGenerar) {
        await ctx.reply(`Ã°Å¸â€Â Buscando categorÃƒÂ­a de "<b>${escapeHtml(elegido.nombre)}</b>" en CDÃ¢â‚¬Â¦`, { parse_mode: "HTML" });
        const resultado = await cdScrapearTipoRequerimiento(sesCD.page, elegido.nombre);
        if (resultado) {
          tipoGenerar = resultado.tipo;
          await guardarTipoMapeo(chatId, elegido.nombre, tipoGenerar);
        }
      }

      if (!tipoGenerar) {
        setSesion(chatId, { fase: "generar_tipo_manual", elegido, cdUser, cdPass });
        return ctx.reply(
          `No pude determinar la categorÃƒÂ­a de "<b>${escapeHtml(elegido.nombre)}</b>" automÃƒÂ¡ticamente.\n\nÃ‚Â¿A cuÃƒÂ¡l pertenece?\n1. empresa\n2. personal\n3. mÃƒÂ¡quinas`,
          { parse_mode: "HTML" }
        );
      }

      await cdGenerarRequerimiento(sesCD.page, tipoGenerar, elegido.nombre);
      resetSesion(chatId);
      return ctx.reply(`Ã¢Å“â€¦ <b>${escapeHtml(elegido.nombre)}</b> generado.`, { parse_mode: "HTML" });
    } catch (e) {
      if (e.sectores) {
        const lineas = e.sectores.map((s, i) => `${i + 1}. ${escapeHtml(s.text)}`);
        setSesion(chatId, { fase: "generar_sector", elegido, cdUser, cdPass, tipo: tipoGenerar, sectores: e.sectores });
        const msg = `Ã°Å¸ÂÂ­ Ã‚Â¿CuÃƒÂ¡l sector para "<b>${escapeHtml(elegido.nombre)}</b>"?\n\n${lineas.join("\n")}`;
        if (e.screenshot) return ctx.replyWithPhoto(new InputFile(e.screenshot, "debug.jpg"), { caption: msg, parse_mode: "HTML" });
        return ctx.reply(msg, { parse_mode: "HTML" });
      }
      cdInvalidarSesion(chatId);
      resetSesion(chatId);
      console.error("[GENERAR-CMD]", e.message);
      const caption = `Ã¢ÂÅ’ Error: ${e.message}`;
      if (e.screenshot)
        return ctx.replyWithPhoto(new InputFile(e.screenshot, "debug.jpg"), { caption, parse_mode: "HTML" });
      return ctx.reply(caption, { parse_mode: "HTML" });
    }
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ /generar: tipo manual Ã¢â€â‚¬Ã¢â€â‚¬
  if (sesion.fase === "generar_tipo_manual" && texto && !texto.startsWith("/")) {
    const TIPOS = ["empresa", "personal", "maquinas"];
    const n = parseInt(texto.trim());
    let tipo = (n >= 1 && n <= 3) ? TIPOS[n - 1] : TIPOS.find((x) => texto.toLowerCase().includes(x)) || null;
    if (!tipo)
      return ctx.reply("EscribÃƒÂ­ <code>1</code> (empresa), <code>2</code> (personal) o <code>3</code> (mÃƒÂ¡quinas).", { parse_mode: "HTML" });

    const { elegido, cdUser, cdPass } = sesion;
    await guardarTipoMapeo(chatId, elegido.nombre, tipo);
    await ctx.reply(`Ã¢ÂÂ³ Generando <b>${escapeHtml(elegido.nombre)}</b>Ã¢â‚¬Â¦`, { parse_mode: "HTML" });

    try {
      const sesCD = await cdObtenerSesionActiva(chatId, cdUser, cdPass);
      if (!sesCD.ok) throw new Error(sesCD.motivo);
      await cdGenerarRequerimiento(sesCD.page, tipo, elegido.nombre);
      resetSesion(chatId);
      return ctx.reply(`Ã¢Å“â€¦ <b>${escapeHtml(elegido.nombre)}</b> generado.`, { parse_mode: "HTML" });
    } catch (e) {
      if (e.sectores) {
        const lineas = e.sectores.map((s, i) => `${i + 1}. ${escapeHtml(s.text)}`);
        setSesion(chatId, { fase: "generar_sector", elegido, cdUser, cdPass, tipo, sectores: e.sectores });
        const msg = `Ã°Å¸ÂÂ­ Ã‚Â¿CuÃƒÂ¡l sector para "<b>${escapeHtml(elegido.nombre)}</b>"?\n\n${lineas.join("\n")}`;
        if (e.screenshot) return ctx.replyWithPhoto(new InputFile(e.screenshot, "debug.jpg"), { caption: msg, parse_mode: "HTML" });
        return ctx.reply(msg, { parse_mode: "HTML" });
      }
      cdInvalidarSesion(chatId);
      resetSesion(chatId);
      console.error("[GENERAR-CMD]", e.message);
      const caption = `Ã¢ÂÅ’ Error: ${e.message}`;
      if (e.screenshot)
        return ctx.replyWithPhoto(new InputFile(e.screenshot, "debug.jpg"), { caption, parse_mode: "HTML" });
      return ctx.reply(caption, { parse_mode: "HTML" });
    }
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ /generar: sector manual Ã¢â€â‚¬Ã¢â€â‚¬
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
      return ctx.reply(`EscribÃƒÂ­ un nÃƒÂºmero del 1 al ${sectores.length}:\n${lineas.join("\n")}`, { parse_mode: "HTML" });
    }
    await ctx.reply(`Ã¢ÂÂ³ Generando <b>${escapeHtml(elegido.nombre)}</b>Ã¢â‚¬Â¦`, { parse_mode: "HTML" });
    try {
      const sesCD = await cdObtenerSesionActiva(chatId, cdUser, cdPass);
      if (!sesCD.ok) throw new Error(sesCD.motivo);
      await cdGenerarRequerimiento(sesCD.page, tipo, elegido.nombre, sectorElegido.value);
      resetSesion(chatId);
      return ctx.reply(`Ã¢Å“â€¦ <b>${escapeHtml(elegido.nombre)}</b> generado.`, { parse_mode: "HTML" });
    } catch (e) {
      cdInvalidarSesion(chatId);
      resetSesion(chatId);
      const caption = `Ã¢ÂÅ’ Error: ${e.message}`;
      if (e.screenshot) return ctx.replyWithPhoto(new InputFile(e.screenshot, "debug.jpg"), { caption, parse_mode: "HTML" });
      return ctx.reply(caption, { parse_mode: "HTML" });
    }
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ ÃƒÅ¡nico: buscando requerimiento Ã¢â€â‚¬Ã¢â€â‚¬
  if (sesion.fase === "unico_buscando_req" && texto && !texto.startsWith("/")) {
    const listaActual = sesion.filtroActual || sesion.requerimientos;

    if (texto.toLowerCase() === "lista") {
      setSesion(chatId, { filtroActual: sesion.requerimientos });
      return ctx.reply(
        `Ã°Å¸â€œâ€¹ ${sesion.requerimientos.length} requerimientos:\n\n${formatearReqs(sesion.requerimientos)}\n\nEscribÃƒÂ­ un nÃƒÂºmero para seleccionar, o texto para filtrar.`,
        { parse_mode: "HTML" }
      );
    }

    const esNumerico = /^\d+$/.test(texto.trim());
    if (!esNumerico) {
      const filtro = texto.toLowerCase();
      const filtrados = sesion.requerimientos.filter((r) => r.nombre.toLowerCase().includes(filtro));
      if (!filtrados.length)
        return ctx.reply(`No encontrÃƒÂ© nada con "<b>${escapeHtml(texto)}</b>". ProbÃƒÂ¡ con otra palabra, o escribÃƒÂ­ <code>lista</code>.`, { parse_mode: "HTML" });
      setSesion(chatId, { filtroActual: filtrados });
      return ctx.reply(
        `Ã°Å¸â€Â ${filtrados.length} resultado${filtrados.length !== 1 ? "s" : ""}:\n\n${formatearReqs(filtrados, { mostrarTodos: true })}\n\nEscribÃƒÂ­ el nÃƒÂºmero para seleccionar.`,
        { parse_mode: "HTML" }
      );
    }

    const idx = parseInt(texto.trim()) - 1;
    if (idx < 0 || idx >= listaActual.length)
      return ctx.reply(`EscribÃƒÂ­ un nÃƒÂºmero del 1 al ${listaActual.length}.`);

    const req = listaActual[idx];
    setSesion(chatId, { fase: "unico_confirmando", reqElegido: req });
    const entidad = req.entidad ? ` Ã¢â‚¬â€ <i>${escapeHtml(req.entidad)}</i>` : "";
    return ctx.reply(
      `Ã°Å¸â€œâ€ž Vas a subir el PDF a:\n<b>${escapeHtml(req.nombre)}</b>${entidad}\n\nÃ‚Â¿Confirmar? (sÃƒÂ­ / no)`,
      { parse_mode: "HTML" }
    );
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ ÃƒÅ¡nico: confirmando subida Ã¢â€â‚¬Ã¢â€â‚¬
  if (sesion.fase === "unico_confirmando" && texto && !texto.startsWith("/")) {
    if (!/^s[iÃƒÂ­]/i.test(texto) && texto.toLowerCase() !== "ok") {
      resetSesion(chatId);
      return ctx.reply("Cancelado.");
    }

    const { buffer, reqElegido, cdUser, cdPass } = sesion;
    await ctx.reply("Ã¢ÂÂ³ Subiendo a controldocumentario.comÃ¢â‚¬Â¦");
    try {
      const sesCD = await cdObtenerSesionActiva(chatId, cdUser, cdPass);
      if (!sesCD.ok) {
        resetSesion(chatId);
        return ctx.reply(`Ã¢ÂÅ’ Error conectando a CD: ${sesCD.motivo}`);
      }
      const nombre = `${reqElegido.nombre.replace(/[^a-z0-9]/gi, "_")}.pdf`;
      await cdSubirArchivo(sesCD.page, reqElegido.href, buffer, nombre, reqElegido.nombre, reqElegido.entidad);
      const entidad = reqElegido.entidad ? ` Ã¢â‚¬â€ ${escapeHtml(reqElegido.entidad)}` : "";
      resetSesion(chatId);
      return ctx.reply(`Ã¢Å“â€¦ ${escapeHtml(reqElegido.nombre)}${entidad}`);
    } catch (e) {
      cdInvalidarSesion(chatId);
      resetSesion(chatId);
      const caption = `Ã¢ÂÅ’ Error: ${e.message}`;
      if (e.screenshot) {
        return ctx.replyWithPhoto(new InputFile(e.screenshot, "debug.jpg"), { caption });
      }
      return ctx.reply(caption);
    }
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Admin: mensaje sin reconocer Ã¢â€â‚¬Ã¢â€â‚¬
  if (ADMIN_IDS.includes(chatId)) return ctx.reply(tonteria());

  // Ã¢â€â‚¬Ã¢â€â‚¬ Registro con cÃƒÂ³digo Ã¢â€â‚¬Ã¢â€â‚¬
  const cliente = await cargarCliente(chatId);
  if (cliente) return ctx.reply("No conozco esas palabras... solo manejo comandos y PDF :)");

  if (esperandoCodigo.has(chatId)) {
    const pendiente = await consumirPendiente(texto);
    if (pendiente) {
      esperandoCodigo.delete(chatId);
      await registrarCliente(chatId, pendiente.nombre);
      return ctx.reply(`Ã‚Â¡Bienvenido <b>${pendiente.nombre}</b>! Estoy listo para los PDF.`, {
        parse_mode: "HTML",
      });
    }
    return ctx.reply("ContraseÃƒÂ±a incorrecta.");
  }

  esperandoCodigo.add(chatId);
  return ctx.reply("No te conozco... Ã‚Â¿ContraseÃƒÂ±a?");
});

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Generables: helpers de flujo Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

function _mostrarGenerables(ctx, chatId) {
  const { sinRequerido } = getSesion(chatId);
  const itemsStr = sinRequerido.map((item, i) => {
    const pags = item.paginas.slice().sort((a, b) => a - b).join(", ");
    const entidad = item.entidad ? ` (<i>${escapeHtml(item.entidad)}</i>)` : "";
    return `${i + 1}. PÃƒÂ¡gs. ${pags} Ã¢â€ â€™ "<b>${escapeHtml(item.tipo)}</b>"${entidad}`;
  }).join("\n");

  return ctx.reply(
    `Ã¢Å¡Â¡ <b>${sinRequerido.length} documento${sinRequerido.length !== 1 ? "s" : ""} identificado${sinRequerido.length !== 1 ? "s" : ""} sin requerido en CD:</b>\n\n${itemsStr}\n\nÃ‚Â¿Generamos los requeridos faltantes?\nEscribÃƒÂ­ los nÃƒÂºmeros (ej: <code>1,2</code>), <code>todo</code> para todos, o <code>omitir</code> para saltear.`,
    { parse_mode: "HTML" }
  );
}

async function _procesarSiguienteGenerable(ctx, chatId) {
  const sesion = getSesion(chatId);
  const { pendientes, indiceActual, cdUser, cdPass } = sesion;

  if (indiceActual >= pendientes.length) {
    resetSesion(chatId);
    return ctx.reply("Ã¢Å“â€¦ Procesamiento de requeridos completado.");
  }

  const item = pendientes[indiceActual];
  const tipoGuardado = await leerTipoMapeo(chatId, item.tipo);

  if (tipoGuardado) {
    return _generarItem(ctx, chatId, item, tipoGuardado);
  }

  // Tipo no conocido Ã¢â€ â€™ scrape
  await ctx.reply(`Ã°Å¸â€Â Buscando categorÃƒÂ­a de "<b>${escapeHtml(item.tipo)}</b>" en controldocumentarioÃ¢â‚¬Â¦`, { parse_mode: "HTML" });

  try {
    const sesCD = await cdObtenerSesionActiva(chatId, cdUser, cdPass);
    if (!sesCD.ok) {
      resetSesion(chatId);
      return ctx.reply(`Ã¢ÂÅ’ Error conectando a CD: ${sesCD.motivo}`);
    }

    const resultado = await cdScrapearTipoRequerimiento(sesCD.page, item.tipo);

    if (resultado) {
      await guardarTipoMapeo(chatId, item.tipo, resultado.tipo);
      return _generarItem(ctx, chatId, item, resultado.tipo);
    }

    // No encontrado Ã¢â€ â€™ pedir al usuario
    setSesion(chatId, { ...sesion, fase: "trabajar_generando_tipo", itemActual: item });
    return ctx.reply(
      `No pude determinar la categorÃƒÂ­a de "<b>${escapeHtml(item.tipo)}</b>" automÃƒÂ¡ticamente.\n\nÃ‚Â¿A cuÃƒÂ¡l pertenece?\n1. empresa\n2. personal\n3. mÃƒÂ¡quinas`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    console.error("[SCRAPE-TIPO]", e.message);
    setSesion(chatId, { ...sesion, indiceActual: indiceActual + 1 });
    await ctx.reply(`Ã¢Å¡Â Ã¯Â¸Â Error buscando categorÃƒÂ­a para "<b>${escapeHtml(item.tipo)}</b>": ${e.message}\nSalteandoÃ¢â‚¬Â¦`, { parse_mode: "HTML" });
    return _procesarSiguienteGenerable(ctx, chatId);
  }
}

async function _generarItem(ctx, chatId, item, tipo, sector = null) {
  const sesion = getSesion(chatId);
  const { buffer, cdUser, cdPass, pendientes, indiceActual } = sesion;
  const entidadLabel = item.entidad ? ` (${escapeHtml(item.entidad)})` : "";

  await ctx.reply(`Ã¢ÂÂ³ Generando requerido "<b>${escapeHtml(item.tipo)}</b>"${entidadLabel}Ã¢â‚¬Â¦`, { parse_mode: "HTML" });

  try {
    const sesCD = await cdObtenerSesionActiva(chatId, cdUser, cdPass);
    if (!sesCD.ok) throw new Error(sesCD.motivo);

    await cdGenerarRequerimiento(sesCD.page, tipo, item.tipo, sector);
    await ctx.reply(`Ã¢Å“â€¦ Requerido generado. Subiendo documentoÃ¢â‚¬Â¦`);

    // Re-read reqs and find the newly created one Ã¢â‚¬â€ retry once if CD is slow to reflect it
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
      // Buscamos solo por nombre Ã¢â‚¬â€ esto aplica cuando generamos con "Todos" (mÃƒÂºltiples entidades).
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
      await ctx.reply(`Ã¢Å¡Â Ã¯Â¸Â Requerido generado pero no lo encontrÃƒÂ© en CD. UsÃƒÂ¡ /unico para subirlo manualmente.`);
    } else {
      const paginasOrdenadas = item.paginas.slice().sort((a, b) => a - b);
      const bufferItem = await cortarPaginas(buffer, paginasOrdenadas);
      for (const reqNuevo of reqsNuevos) {
        const nombre = `${reqNuevo.nombre.replace(/[^a-z0-9]/gi, "_")}.pdf`;
        await cdSubirArchivo(sesCD.page, reqNuevo.href, bufferItem, nombre, reqNuevo.nombre, reqNuevo.entidad);
        await ctx.reply(`Ã¢Å“â€¦ ${escapeHtml(reqNuevo.nombre)}${reqNuevo.entidad ? ` (<i>${escapeHtml(reqNuevo.entidad)}</i>)` : ""}`, { parse_mode: "HTML" });
      }
    }
  } catch (e) {
    if (e.sectores) {
      const lineas = e.sectores.map((s, i) => `${i + 1}. ${escapeHtml(s.text)}`);
      setSesion(chatId, { ...getSesion(chatId), fase: "trabajar_generando_sector", itemActual: item, tipoActual: tipo, sectores: e.sectores });
      const msg = `Ã°Å¸ÂÂ­ Ã‚Â¿CuÃƒÂ¡l sector para "<b>${escapeHtml(item.tipo)}</b>"?\n\n${lineas.join("\n")}`;
      if (e.screenshot) return ctx.replyWithPhoto(new InputFile(e.screenshot, "debug.jpg"), { caption: msg, parse_mode: "HTML" });
      return ctx.reply(msg, { parse_mode: "HTML" });
    }
    const caption = `Ã¢ÂÅ’ Error con "<b>${escapeHtml(item.tipo)}</b>"${entidadLabel}: ${e.message}`;
    if (e.screenshot) {
      await ctx.replyWithPhoto(new InputFile(e.screenshot, "debug.jpg"), { caption, parse_mode: "HTML" });
    } else {
      await ctx.reply(caption, { parse_mode: "HTML" });
    }
  }

  setSesion(chatId, { ...getSesion(chatId), indiceActual: indiceActual + 1 });
  return _procesarSiguienteGenerable(ctx, chatId);
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Vencimientos: helpers de formato Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

function _buildMsgVencimientos(items, diasP, diasV, diasE = 10) {
  const fraseDias = (d) => {
    if (d < 0) { const n = Math.abs(d); return n === 1 ? "VENCIDO hace 1 dÃƒÂ­a" : `VENCIDO hace ${n} dÃƒÂ­as`; }
    if (d === 0) return "vence HOY";
    if (d === 1) return "vence MAÃƒâ€˜ANA";
    return `vence en ${d} dÃƒÂ­as`;
  };
  const ico = (d) => d < 0 ? "Ã°Å¸â€Â´" : d <= 3 ? "Ã°Å¸Å¸Â " : "Ã°Å¸Å¸Â¡";

  const generales = items.filter(i => i.tipo === "general");
  const empresa   = items.filter(i => i.tipo === "empresa");
  const personal  = items.filter(i => i.tipo === "personal");
  const vehiculos = items.filter(i => i.tipo === "vehiculo");

  const partes = [
    `Ã°Å¸â€â€ <b>Vencimientos prÃƒÂ³ximos</b>`,
    `<i>Ã°Å¸â€Â´ vencido Ã‚Â· Ã°Å¸Å¸Â  hoy/1-3 dÃƒÂ­as Ã‚Â· Ã°Å¸Å¸Â¡ 4+ dÃƒÂ­as | empresa ${diasE}d Ã‚Â· personal ${diasP}d Ã‚Â· vehÃƒÂ­culos ${diasV}d</i>`,
  ];

  const bloque = (titulo, lista, sinNombre = false) => {
    partes.push(`\n${titulo}`);
    if (!lista.length) { partes.push("Ã¢Å“â€¦ sin vencimientos"); return; }
    const ordenada = [...lista].sort((a, b) => a.diasFaltantes - b.diasFaltantes);
    for (const it of ordenada.slice(0, 60)) {
      partes.push(sinNombre
        ? `${ico(it.diasFaltantes)} ${escapeHtml(it.columna)} Ã¢â‚¬â€ ${it.fecha} (${fraseDias(it.diasFaltantes)})`
        : `${ico(it.diasFaltantes)} ${escapeHtml(it.columna)} Ã¢â‚¬â€ ${escapeHtml(it.nombre)} Ã¢â‚¬â€ ${it.fecha} (${fraseDias(it.diasFaltantes)})`
      );
    }
    if (ordenada.length > 60) partes.push(`Ã¢â‚¬Â¦y ${ordenada.length - 60} mÃƒÂ¡s.`);
  };

  bloque("Ã°Å¸â€œâ€¹ <b>GENERAL (proveedor)</b>", generales, true);
  bloque("Ã°Å¸ÂÂ¢ <b>EMPRESA</b>", empresa);
  bloque("Ã°Å¸â€˜Â· <b>PERSONAL</b>", personal);
  bloque("Ã°Å¸Å¡â€” <b>VEHÃƒÂCULOS</b>", vehiculos);
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

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Parte mensual: helper de mensaje y cron Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

function _msgParteMensual(personal, maquinas) {
  const total = personal.actualizados + maquinas.actualizados;
  const lineas = [];
  const errores = [];
  if (personal.actualizados > 0) lineas.push(`Ã°Å¸â€˜Â· Personal: ${personal.actualizados} empleado${personal.actualizados !== 1 ? "s" : ""}`);
  if (maquinas.actualizados > 0) lineas.push(`Ã°Å¸Å¡â€” MÃƒÂ¡quinas: ${maquinas.actualizados} vehÃƒÂ­culo${maquinas.actualizados !== 1 ? "s" : ""}`);
  if (personal?.ok === false && personal?.error) errores.push(`Ã¢Å¡Â Ã¯Â¸Â Personal: ${personal.error}`);
  if (maquinas?.ok === false && maquinas?.error) errores.push(`Ã¢Å¡Â Ã¯Â¸Â MÃƒÂ¡quinas: ${maquinas.error}`);
  if (!lineas.length && !errores.length) return "Ã¢Å“â€¦ Parte mensual: ya estaba todo al dÃƒÂ­a (0 cambios).";
  const bloques = [];
  if (lineas.length) bloques.push(`Ã¢Å“â€¦ Parte mensual grabado:\n${lineas.join("\n")}`);
  else if (total === 0) bloques.push("Ã¢Å“â€¦ Parte mensual: sin cambios grabados.");
  if (errores.length) bloques.push(errores.join("\n"));
  return bloques.join("\n\n");
}

// DÃƒÂ­a 1 de cada mes a las 08:00
cron.schedule("0 8 1 * *", async () => {
  console.log("[CRON] Parte mensual automÃƒÂ¡tico iniciado");
  const clientes = await listarTodosClientes();
  for (const cliente of clientes) {
    if (!cliente.cdUser || !cliente.cdPass) continue;
    const chatId = cliente.chatId;
    try {
      await bot.api.sendMessage(chatId, "Ã¢ÂÂ³ Grabando parte mensual automÃƒÂ¡ticoÃ¢â‚¬Â¦");
      const sesCD = await cdObtenerSesionActiva(chatId, cliente.cdUser, cliente.cdPass);
      if (!sesCD.ok) {
        await bot.api.sendMessage(chatId, `Ã¢ÂÅ’ Parte mensual automÃƒÂ¡tico Ã¢â‚¬â€ error de login: ${sesCD.motivo}`);
        continue;
      }
      const { personal, maquinas } = await cdGrabarParteMensual(sesCD.page);
      await bot.api.sendMessage(chatId, _msgParteMensual(personal, maquinas));
    } catch (e) {
      cdInvalidarSesion(chatId);
      console.error(`[CRON PARTE] ${chatId}: ${e.message}`);
      await bot.api.sendMessage(chatId, `Ã¢ÂÅ’ Parte mensual automÃƒÂ¡tico fallÃƒÂ³: ${e.message}`).catch(() => {});
    }
  }
  console.log("[CRON] Parte mensual automÃƒÂ¡tico finalizado");
});

// Todos los dÃƒÂ­as a las 13:46 Ã¢â‚¬â€ notifica solo si hay vencimientos prÃƒÂ³ximos
cron.schedule("30 15 * * *", async () => {
  const inicio = Date.now();
  console.log(`[CRON VENC] Ã¢â€“Â¶ Iniciado Ã¢â‚¬â€ ${new Date().toLocaleString("es-AR")}`);
  const clientes = await listarTodosClientes();
  const total = clientes.length;
  let procesados = 0, sinCredenciales = 0, conAlertas = 0, errores = 0;
  console.log(`[CRON VENC] Clientes a evaluar: ${total}`);

  for (const cliente of clientes) {
    if (!cliente.cdUser || !cliente.cdPass) {
      sinCredenciales++;
      console.log(`[CRON VENC] Ã¢ÂÂ­ ${cliente.nombre || cliente.chatId} Ã¢â‚¬â€ sin credenciales CD`);
      continue;
    }
    const chatId = cliente.chatId;
    const diasP = cliente.diasPersonal ?? 10;
    const diasV = cliente.diasVehiculos ?? 10;
    const diasE = cliente.diasEmpresa ?? 10;
    procesados++;
    console.log(`[CRON VENC] Ã°Å¸â€Â [${procesados}/${total - sinCredenciales}] ${cliente.nombre || chatId} Ã¢â‚¬â€ diasE=${diasE} diasP=${diasP} diasV=${diasV}`);
    try {
      const sesCD = await cdObtenerSesionActiva(chatId, cliente.cdUser, cliente.cdPass);
      if (!sesCD.ok) {
        console.log(`[CRON VENC] Ã¢ÂÅ’ ${cliente.nombre || chatId} Ã¢â‚¬â€ login fallido: ${sesCD.motivo}`);
        errores++;
        continue;
      }
      console.log(`[CRON VENC] Ã¢Å“â€¦ ${cliente.nombre || chatId} Ã¢â‚¬â€ sesiÃƒÂ³n OK, consultando vencimientosÃ¢â‚¬Â¦`);
      const { items } = await cdLeerVencimientos(sesCD.page, diasP, diasV, diasE);
      console.log(`[CRON VENC] Ã°Å¸â€œâ€¹ ${cliente.nombre || chatId} Ã¢â‚¬â€ ${items.length} item(s) encontrado(s)`);
      if (!items.length) {
        console.log(`[CRON VENC] Ã¢Å“â€ ${cliente.nombre || chatId} Ã¢â‚¬â€ sin vencimientos prÃƒÂ³ximos, no se envÃƒÂ­a alerta`);
        continue;
      }
      conAlertas++;
      const chunks = [..._chunksVenc(_buildMsgVencimientos(items, diasP, diasV, diasE))];
      console.log(`[CRON VENC] Ã°Å¸â€œÂ¨ ${cliente.nombre || chatId} Ã¢â‚¬â€ enviando ${chunks.length} mensaje(s) con alertas`);
      for (const chunk of chunks)
        await bot.api.sendMessage(chatId, chunk, { parse_mode: "HTML" });
      console.log(`[CRON VENC] Ã¢Å“â€¦ ${cliente.nombre || chatId} Ã¢â‚¬â€ alerta enviada`);
    } catch (e) {
      cdInvalidarSesion(chatId);
      errores++;
      console.error(`[CRON VENC] Ã°Å¸â€™Â¥ ${cliente.nombre || chatId}: ${e.message}`);
    }
  }

  const duracion = ((Date.now() - inicio) / 1000).toFixed(1);
  console.log(`[CRON VENC] Ã¢â€“Â  Finalizado en ${duracion}s Ã¢â‚¬â€ procesados=${procesados} alertas=${conAlertas} errores=${errores} sinCreds=${sinCredenciales}`);
});

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Setup y arranque Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

bot.catch((err) => console.error("[BOT ERROR]", err.message));

async function setupCommands() {
  const base = [
    { command: "estado", description: "Ver tu cuenta conectada y mapeos" },
    { command: "miid", description: "Ver tu chat ID" },
    { command: "config", description: "Configurar credenciales de controldocumentario.com" },
    { command: "pendientes", description: "Ver requerimientos pendientes en CD" },
    { command: "vencimientos", description: "Ver vencimientos prÃƒÂ³ximos de documentos" },
    { command: "partemes", description: "Grabar parte mensual (personal y mÃƒÂ¡quinas)" },
    { command: "aprender", description: "Configurar mapeo de documentos" },
    { command: "listo", description: "Finalizar mapeo actual" },
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
console.log(`ControlBun corriendoÃ¢â‚¬Â¦ Admins: ${ADMIN_IDS.join(", ") || "Ã¢Å¡Â Ã¯Â¸Â NO CONFIGURADO"}`);
