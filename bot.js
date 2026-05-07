import "dotenv/config";
import { Bot, InputFile } from "grammy";
import cron from "node-cron";
import { cargarCliente, registrarCliente, guardarPendiente, consumirPendiente, actualizarCliente, listarTodosClientes } from "./clientes.js";
import { pdfAImagenes, cortarPaginas, inicializarPdf } from "./pdf.js";
import { guardarMapeo, leerTodosMapeosPorTipo, eliminarMapeo, leerMapeoBruto } from "./mapeos.js";
import { cdObtenerSesionActiva, cdInvalidarSesion, cdLeerRequerimientos, cdLeerTiposRequerimientos, cdSubirArchivo, cdLeerVencimientos, cdGrabarParteMensual } from "./cd.js";
import { matchearPaginasConReqs, setAiProvider, getCurrentProviderLabel } from "./claude.js";
import { tonteria } from "./tonterias.js";
import { startWebServer, generarTokenWeb } from "./web.js";
import { startTunnel } from "./tunnel.js";

const bot = new Bot(process.env.TG_TOKEN);
const ADMIN_IDS = (process.env.ADMIN_CHAT_ID || "").split(",").map(s => s.trim()).filter(Boolean);

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

bot.command("nuevocliente", async (ctx) => {
  if (!ADMIN_IDS.includes(String(ctx.chat.id))) return;
  const match = ctx.match?.trim().match(/^(\S+)\s+(\S+)$/);
  if (!match) return ctx.reply("Uso: /nuevocliente NombreApellido CODIGO");
  const nombre = match[1].replace(/([A-Z])/g, " $1").trim().replace(/\b\w/g, (c) => c.toUpperCase());
  await guardarPendiente(match[2].trim(), nombre);
  return ctx.reply(`✅ Código <code>${match[2]}</code> listo para <b>${nombre}</b>.`, { parse_mode: "HTML" });
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

  await ctx.reply("⏳ Consultando requerimientos pendientes…");
  try {
    const sesCD = await cdObtenerSesionActiva(chatId, cliente.cdUser, cliente.cdPass);
    if (!sesCD.ok) {
      if (sesCD.screenshot) {
        return ctx.replyWithPhoto(new InputFile(sesCD.screenshot, "login.jpg"), { caption: `❌ ${sesCD.motivo}` });
      }
      return ctx.reply(`❌ ${sesCD.motivo}`);
    }

    const reqs = await cdLeerRequerimientos(sesCD.page);
    if (!reqs.length)
      return ctx.reply("✅ No hay requerimientos pendientes en CD.");

    const lineas = reqs.map((r, i) => {
      const entidad = r.entidad ? ` — <i>${escapeHtml(r.entidad)}</i>` : "";
      return `${i + 1}. ${escapeHtml(r.nombre)}${entidad}`;
    });

    return ctx.reply(
      `📋 <b>${reqs.length} requerimiento${reqs.length !== 1 ? "s" : ""} pendiente${reqs.length !== 1 ? "s" : ""}:</b>\n\n${lineas.join("\n")}`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    cdInvalidarSesion(chatId);
    console.error("[PENDIENTES]", e.message);
    return ctx.reply(`❌ Error: ${e.message}`);
  }
});

bot.command("vencimientos", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const cliente = await cargarCliente(chatId);
  if (!cliente) return ctx.reply("No tengo tu cuenta registrada.");
  if (!cliente.cdUser || !cliente.cdPass)
    return ctx.reply("❌ No tenés credenciales configuradas. Usá /config primero.");

  const diasP = cliente.diasPersonal ?? 10;
  const diasV = cliente.diasVehiculos ?? 10;
  await ctx.reply(`🔎 Consultando vencimientos (personal: ${diasP} días, vehículos: ${diasV} días)…`);

  try {
    const sesCD = await cdObtenerSesionActiva(chatId, cliente.cdUser, cliente.cdPass);
    if (!sesCD.ok) {
      if (sesCD.screenshot)
        return ctx.replyWithPhoto(new InputFile(sesCD.screenshot, "login.jpg"), { caption: `❌ ${sesCD.motivo}` });
      return ctx.reply(`❌ ${sesCD.motivo}`);
    }

    const { items, screenshots } = await cdLeerVencimientos(sesCD.page, diasP, diasV);

    if (!items.length) {
      await ctx.reply(
        `✅ <b>Todo OK</b> — sin vencimientos próximos.\n\n<i>Personal: ${diasP} días · Vehículos: ${diasV} días</i>`,
        { parse_mode: "HTML" }
      );
      for (const ss of screenshots) await ctx.replyWithPhoto(new InputFile(ss.buffer, ss.nombre));
      return;
    }

    for (const chunk of _chunksVenc(_buildMsgVencimientos(items, diasP, diasV)))
      await ctx.reply(chunk, { parse_mode: "HTML" });
    for (const ss of screenshots) await ctx.replyWithPhoto(new InputFile(ss.buffer, ss.nombre));
  } catch (e) {
    cdInvalidarSesion(chatId);
    console.error("[VENCIMIENTOS]", e.message);
    return ctx.reply(`❌ Error: ${e.message}`);
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
            `✅ 1 página lista.\n\n¿A qué requerimiento corresponde?\n\nEscribí parte del nombre para buscar, o <code>lista</code> para verlos todos.\n\n/listo para finalizar.`,
            { parse_mode: "HTML" }
          );
        }

        setSesion(chatId, { fase: "aprender_agrupando", buffer, imagenes, grupos: [], paginasSinAsignar: todasLasPaginas });
        return ctx.reply(`✅ ${imagenes.length} páginas listas.\n\n` + msgAgrupar(todasLasPaginas), { parse_mode: "HTML" });
      } catch (e) {
        console.error("[PDF ERROR]", e.message);
        return ctx.reply(`❌ Error renderizando: ${e.message}`);
      }
    }

    // Modo trabajar: analizar y subir
    await ctx.reply("⏳ Analizando documentos…");
    try {
      const buffer = await bajarPdf(ctx);
      const imagenes = await pdfAImagenes(buffer);

      const mapeos = await leerTodosMapeosPorTipo(chatId);
      if (!mapeos.length)
        return ctx.reply("❌ No tenés mapeos configurados. Usá /aprender primero para enseñarme los tipos de documentos.");

      await ctx.reply(`🔗 ${imagenes.length} páginas listas. Leyendo requerimientos de CD…`);
      const sesCD = await cdObtenerSesionActiva(chatId, cliente.cdUser, cliente.cdPass);
      if (!sesCD.ok) {
        if (sesCD.screenshot) {
          return ctx.replyWithPhoto(new InputFile(sesCD.screenshot, "login.jpg"), { caption: `❌ ${sesCD.motivo}` });
        }
        return ctx.reply(`❌ Error conectando a CD: ${sesCD.motivo}`);
      }

      const reqs = await cdLeerRequerimientos(sesCD.page);
      if (!reqs.length)
        return ctx.reply("No hay requerimientos pendientes en CD por el momento.");

      await ctx.reply(`🤖 Clasificando ${imagenes.length} páginas contra ${reqs.length} requerimientos pendientes…`);
      const resultado = await matchearPaginasConReqs(imagenes, mapeos, reqs);

      if (!resultado || !resultado.grupos.length)
        return ctx.reply("❌ No pude identificar los documentos. Verificá que el PDF coincide con los mapeos configurados.");

      const totalSubidas = resultado.grupos.reduce((s, g) => s + g.reqs.length, 0);

      // Debug: clasificación por página
      if (resultado.paginasClasificadas?.length) {
        const debugLineas = resultado.paginasClasificadas.map(
          (p) => `  pág ${p.pagina}: <i>${escapeHtml(p.tipo_detectado || "?")}</i>${p.entidad_detectada ? ` — <b>${escapeHtml(p.entidad_detectada)}</b>` : " (sin entidad)"}`
        ).join("\n");
        await ctx.reply(`🔍 <b>Clasificación detectada:</b>\n${debugLineas}`, { parse_mode: "HTML" });
      }

      const _parseTotalMeses = (nombre) => {
        const m = String(nombre || "").match(/-(\d{4})-(\d+)$/i);
        return m ? parseInt(m[1]) * 12 + parseInt(m[2]) : null;
      };
      const _now = new Date();
      const _totalMesesActual = _now.getFullYear() * 12 + (_now.getMonth() + 1);

      const lineas = resultado.grupos.map((g, i) => {
        const pags = g.paginas.slice().sort((a, b) => a - b).join(", ");
        const reqsStr = g.reqs.map((r) => `  • <i>${escapeHtml(r.nombre)}</i>`).join("\n");
        let linea = `${i + 1}. <b>${escapeHtml(g.entidad || "Sin entidad")}</b> → págs. ${pags}\n${reqsStr}`;
        if (g.omitidos?.length) {
          const omitStr = g.omitidos.map((r) => `  ⏩ <i>${escapeHtml(r.nombre)}</i>`).join("\n");
          linea += `\n${omitStr} (período anterior, no se sube)`;
        }
        const maxTotalMeses = Math.max(...g.reqs.map((r) => _parseTotalMeses(r.nombre) ?? 0));
        const mesesAtras = _totalMesesActual - maxTotalMeses;
        if (maxTotalMeses > 0 && mesesAtras >= 2) {
          linea += `\n  ⚠️ El req más reciente está ${mesesAtras} mes${mesesAtras !== 1 ? "es" : ""} atrás del mes actual`;
        }
        return linea;
      });
      if (resultado.sinAsignar.length)
        lineas.push(`\n⚠️ Sin identificar: páginas ${resultado.sinAsignar.join(", ")}`);

      setSesion(chatId, {
        fase: "trabajar_confirmando",
        buffer,
        gruposSubir: resultado.grupos,
        cdUser: cliente.cdUser,
        cdPass: cliente.cdPass,
      });

      return ctx.reply(
        `📋 <b>${resultado.grupos.length} grupo${resultado.grupos.length !== 1 ? "s" : ""}, ${totalSubidas} subida${totalSubidas !== 1 ? "s" : ""}:</b>\n\n${lineas.join("\n\n")}\n\n¿Confirmar y subir todo? (sí / no)`,
        { parse_mode: "HTML" }
      );
    } catch (e) {
      console.error("[TRABAJAR]", e.message);
      return ctx.reply(`❌ Error: ${e.message}`);
    }
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
      resetSesion(chatId);
      return ctx.reply("✅ Confirmado, ya entramos a control documentario. Ya podés usar /aprender.");
    } catch (e) {
      cdInvalidarSesion(chatId);
      resetSesion(chatId);
      return ctx.reply(`❌ Error probando credenciales: ${e.message}\n\nUsá /config para intentar de nuevo.`);
    }
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
    if (!/^s[ií]/i.test(texto) && texto.toLowerCase() !== "ok") {
      resetSesion(chatId);
      return ctx.reply("Cancelado.");
    }

    const { buffer, gruposSubir, cdUser, cdPass } = sesion;
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

      const todosOmitidos = gruposSubir.flatMap((g) => g.omitidos || []);
      resetSesion(chatId);
      let msgFinal = `Listo. ${ok} subido${ok !== 1 ? "s" : ""}${fail ? `, ${fail} con error` : ""}.`;
      if (todosOmitidos.length) {
        const omitStr = todosOmitidos
          .map((r) => `  • ${escapeHtml(r.nombre)}${r.entidad ? ` — <i>${escapeHtml(r.entidad)}</i>` : ""}`)
          .join("\n");
        msgFinal += `\n\n⚠️ Quedaron pendientes (período anterior, subir aparte):\n${omitStr}`;
      }
      return ctx.reply(msgFinal, { parse_mode: "HTML" });
    } catch (e) {
      cdInvalidarSesion(chatId);
      resetSesion(chatId);
      return ctx.reply(`❌ Error durante la subida: ${e.message}`);
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

// ─── Vencimientos: helpers de formato ────────────────────────────────────────

function _buildMsgVencimientos(items, diasP, diasV) {
  const fraseDias = (d) => {
    if (d < 0) { const n = Math.abs(d); return n === 1 ? "VENCIDO hace 1 día" : `VENCIDO hace ${n} días`; }
    if (d === 0) return "vence HOY";
    if (d === 1) return "vence MAÑANA";
    return `vence en ${d} días`;
  };
  const ico = (d) => d < 0 ? "🔴" : d <= 3 ? "🟠" : "🟡";

  const generales = items.filter(i => i.tipo === "general");
  const personal  = items.filter(i => i.tipo === "personal");
  const vehiculos = items.filter(i => i.tipo === "vehiculo");

  const partes = [
    `🔔 <b>Vencimientos próximos</b>`,
    `<i>🔴 vencido · 🟠 hoy/1-3 días · 🟡 4+ días | personal ${diasP}d · vehículos ${diasV}d</i>`,
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

  bloque("📋 <b>GENERAL (proveedor)</b>", generales, true);
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
  if (total === 0) return "✅ Parte mensual: ya estaba todo al día (0 cambios).";
  const lineas = [];
  if (personal.actualizados > 0) lineas.push(`👷 Personal: ${personal.actualizados} empleado${personal.actualizados !== 1 ? "s" : ""}`);
  if (maquinas.actualizados > 0) lineas.push(`🚗 Máquinas: ${maquinas.actualizados} vehículo${maquinas.actualizados !== 1 ? "s" : ""}`);
  return `✅ Parte mensual grabado:\n${lineas.join("\n")}`;
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

// Todos los días a las 08:00 — notifica solo si hay vencimientos próximos
cron.schedule("0 13 * * *", async () => {
  console.log("[CRON] Check vencimientos automático iniciado");
  const clientes = await listarTodosClientes();
  for (const cliente of clientes) {
    if (!cliente.cdUser || !cliente.cdPass) continue;
    const chatId = cliente.chatId;
    const diasP = cliente.diasPersonal ?? 10;
    const diasV = cliente.diasVehiculos ?? 10;
    try {
      const sesCD = await cdObtenerSesionActiva(chatId, cliente.cdUser, cliente.cdPass);
      if (!sesCD.ok) continue;
      const { items } = await cdLeerVencimientos(sesCD.page, diasP, diasV);
      if (!items.length) continue;
      for (const chunk of _chunksVenc(_buildMsgVencimientos(items, diasP, diasV)))
        await bot.api.sendMessage(chatId, chunk, { parse_mode: "HTML" });
    } catch (e) {
      cdInvalidarSesion(chatId);
      console.error(`[CRON VENC] ${chatId}: ${e.message}`);
    }
  }
  console.log("[CRON] Check vencimientos finalizado");
});

// ─── Setup y arranque ────────────────────────────────────────────────────────

bot.catch((err) => console.error("[BOT ERROR]", err.message));

async function setupCommands() {
  const base = [
    { command: "estado", description: "Ver tu cuenta conectada y mapeos" },
    { command: "miid", description: "Ver tu chat ID" },
    { command: "config", description: "Configurar credenciales de controldocumentario.com" },
    { command: "pendientes", description: "Ver requerimientos pendientes en CD" },
    { command: "vencimientos", description: "Ver vencimientos próximos de documentos" },
    { command: "partemes", description: "Grabar parte mensual (personal y máquinas)" },
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
console.log(`ControlBun corriendo… Admins: ${ADMIN_IDS.join(", ") || "⚠️ NO CONFIGURADO"}`);
