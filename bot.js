import "dotenv/config";
import { Bot, InputFile } from "grammy";
import { cargarCliente, registrarCliente, guardarPendiente, consumirPendiente, actualizarCliente } from "./clientes.js";
import { pdfAImagenes, cortarPaginas } from "./pdf.js";
import { guardarMapeo, leerTodosMapeosPorTipo } from "./mapeos.js";
import { cdObtenerSesionActiva, cdInvalidarSesion, cdLeerRequerimientos, cdLeerTiposRequerimientos, cdSubirArchivo } from "./cd.js";
import { matchearPaginasConReqs } from "./claude.js";
import { tonteria } from "./tonterias.js";

const bot = new Bot(process.env.TG_TOKEN);
const ADMIN_ID = process.env.ADMIN_CHAT_ID;

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

bot.command("nuevocliente", async (ctx) => {
  if (String(ctx.chat.id) !== String(ADMIN_ID)) return;
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
    "⚙️ Configuración de credenciales de controldocumentario.com\n\nMandame tu <b>usuario</b> (email):",
    { parse_mode: "HTML" }
  );
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

    return ctx.reply(
      `✅ ${tiposUnicos.length} tipo${tiposUnicos.length !== 1 ? "s" : ""} de requerimiento encontrado${tiposUnicos.length !== 1 ? "s" : ""}.\n\nMandame el PDF de referencia para configurar el mapeo.`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    cdInvalidarSesion(chatId);
    console.error("[APRENDER]", e.message);
    return ctx.reply(`❌ Error conectando a CD: ${e.message}`);
  }
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

  resetSesion(chatId);
  return ctx.reply(`✅ Mapeo guardado:\n\n${resumen}${nota}`, { parse_mode: "HTML" });
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

    // Aprender: PDF de referencia
    if (sesion.fase === "aprender_esperando_pdf") {
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
        setSesion(chatId, {
          fase: "aprender_agrupando",
          buffer,
          imagenes,
          grupos: [],
          paginasSinAsignar: todasLasPaginas,
        });

        return ctx.reply(
          `✅ ${imagenes.length} páginas listas. Disponibles: <b>${[...todasLasPaginas].join(", ")}</b>\n\n` +
            `Agrupá las que van juntas en un mismo requerimiento.\n` +
            `Escribí los números separados por coma (ej: <code>1,2</code>) o uno solo (ej: <code>3</code>).\n\n` +
            `Cuando termines, escribí /listo.`,
          { parse_mode: "HTML" }
        );
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
      const lineas = resultado.grupos.map((g, i) => {
        const pags = g.paginas.slice().sort((a, b) => a - b).join(", ");
        const reqsStr = g.reqs.map((r) => `  • <i>${escapeHtml(r.nombre)}</i>`).join("\n");
        return `${i + 1}. <b>${escapeHtml(g.entidad || "Sin entidad")}</b> → págs. ${pags}\n${reqsStr}`;
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
    return ctx.reply("Ahora mandame la <b>contraseña</b>:", { parse_mode: "HTML" });
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
      return ctx.reply("✅ Credenciales guardadas y verificadas. Ya podés usar /aprender.");
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
      `✅ Grupo: páginas <b>${nums.join(", ")}</b>\n\n¿A qué requerimiento corresponde?\n\nEscribí algo para buscar en la lista, o <code>lista</code> para verla completa.`,
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
        `📋 ${sesion.requerimientos.length} requerimientos:\n\n${formatearReqs(sesion.requerimientos)}\n\nEscribí un número para seleccionar, o texto para seguir filtrando.`,
        { parse_mode: "HTML" }
      );
    }

    // Texto no numérico → buscar en la lista completa
    const esNumerico = /^[\d,\s]+$/.test(texto);
    if (!esNumerico) {
      const filtro = texto.toLowerCase();
      const filtrados = sesion.requerimientos.filter((r) => r.nombre.toLowerCase().includes(filtro));
      if (!filtrados.length)
        return ctx.reply(`No encontré nada con "<b>${escapeHtml(texto)}</b>". Probá con otra palabra, o escribí <code>lista</code> para verlos todos.`, { parse_mode: "HTML" });
      setSesion(chatId, { filtroActual: filtrados });
      return ctx.reply(
        `🔍 ${filtrados.length} resultado${filtrados.length !== 1 ? "s" : ""}:\n\n${formatearReqs(filtrados, { mostrarTodos: true })}\n\nEscribí el número para seleccionar.`,
        { parse_mode: "HTML" }
      );
    }

    const idxs = texto.split(",").map((s) => parseInt(s.trim()) - 1).filter((n) => !isNaN(n));
    const invalidos = idxs.filter((i) => i < 0 || i >= listaActual.length);
    if (!idxs.length || invalidos.length)
      return ctx.reply(`Escribí un número del 1 al ${listaActual.length}, o texto para buscar.`, { parse_mode: "HTML" });

    const reqsElegidos = idxs.map((i) => listaActual[i]);
    const nuevosGrupos = reqsElegidos.map((req) => ({ ...sesion.grupoActual, req }));
    const grupos = [...(sesion.grupos || []), ...nuevosGrupos];

    const paginasSinAsignar = new Set(sesion.paginasSinAsignar);
    sesion.grupoActual.paginas.forEach((p) => paginasSinAsignar.delete(p));

    setSesion(chatId, { grupos, paginasSinAsignar, grupoActual: null, fase: "aprender_agrupando" });

    const nombresReqs = reqsElegidos
      .map((r) => `<b>${escapeHtml(r.nombre)}</b>${r.entidad ? ` (${escapeHtml(r.entidad)})` : ""}`)
      .join(" y ");

    // Si se mapearon todas las páginas, guardar y terminar
    if (!paginasSinAsignar.size) {
      const asignados = await guardarSesionMapeo(chatId);
      const resumen = asignados
        .map((g) => `• <b>${escapeHtml(g.req.nombre)}</b>${g.req.entidad ? ` (${escapeHtml(g.req.entidad)})` : ""} → ${g.paginas.length} pág.`)
        .join("\n");
      resetSesion(chatId);
      return ctx.reply(`✅ ${nombresReqs} = páginas ${sesion.grupoActual.paginas.join(", ")}\n\nTodas las páginas mapeadas. Mapeo guardado:\n\n${resumen}`, {
        parse_mode: "HTML",
      });
    }

    const restantes = [...paginasSinAsignar];
    return ctx.reply(
      `✅ ${nombresReqs} = páginas ${sesion.grupoActual.paginas.join(", ")}\n\n` +
        `Todavía tenemos ${restantes.length} página${restantes.length !== 1 ? "s" : ""} para mappear (${restantes.join(", ")}).\n` +
        `¿Algún otro grupo? ¿Con qué página seguimos?`,
      { parse_mode: "HTML" }
    );
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
        // Cortar una vez, subir a todos los reqs del grupo
        const bufferGrupo = await cortarPaginas(buffer, paginasOrdenadas);
        for (const req of grupo.reqs) {
          const nombre = `${req.nombre.replace(/[^a-z0-9]/gi, "_")}.pdf`;
          try {
            await cdSubirArchivo(sesCD.page, req.href, bufferGrupo, nombre);
            const entidad = grupo.entidad ? ` — ${escapeHtml(grupo.entidad)}` : "";
            await ctx.reply(`✅ ${escapeHtml(req.nombre)}${entidad}`);
            ok++;
          } catch (e) {
            const entidad = grupo.entidad ? ` — ${escapeHtml(grupo.entidad)}` : "";
            await ctx.reply(`❌ ${escapeHtml(req.nombre)}${entidad}: ${e.message}`);
            fail++;
          }
        }
      }

      resetSesion(chatId);
      return ctx.reply(`Listo. ${ok} subido${ok !== 1 ? "s" : ""}${fail ? `, ${fail} con error` : ""}.`);
    } catch (e) {
      cdInvalidarSesion(chatId);
      resetSesion(chatId);
      return ctx.reply(`❌ Error durante la subida: ${e.message}`);
    }
  }

  // ── Admin: mensaje sin reconocer ──
  if (chatId === String(ADMIN_ID)) return ctx.reply(tonteria());

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

// ─── Setup y arranque ────────────────────────────────────────────────────────

bot.catch((err) => console.error("[BOT ERROR]", err.message));

async function setupCommands() {
  const base = [
    { command: "miid", description: "Ver tu chat ID" },
    { command: "config", description: "Configurar credenciales de controldocumentario.com" },
    { command: "aprender", description: "Configurar mapeo de documentos" },
    { command: "listo", description: "Finalizar mapeo actual" },
  ];
  await bot.api.setMyCommands(base, { scope: { type: "default" } });
  if (ADMIN_ID) {
    await bot.api.setMyCommands(
      [...base, { command: "nuevocliente", description: "Registrar cliente: NombreApellido CODIGO" }],
      { scope: { type: "chat", chat_id: Number(ADMIN_ID) } }
    );
  }
}

setupCommands().catch((e) => console.error("[SETUP ERROR]", e.message));
bot.start();
console.log(`ControlBun corriendo… Admin: ${ADMIN_ID || "⚠️ NO CONFIGURADO"}`);
