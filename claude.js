import { readFileSync, writeFileSync } from "fs";
import Anthropic from "@anthropic-ai/sdk";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llava";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const MODELO = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";

let aiProvider = process.env.AI_PROVIDER || "claude"; // claude | gemini | ollama
try {
  const rt = JSON.parse(readFileSync("runtime.json", "utf8"));
  if (rt.aiProvider) aiProvider = rt.aiProvider;
} catch {}

const anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const _label = () => aiProvider === "ollama" ? `Ollama (${OLLAMA_MODEL})`
  : aiProvider === "gemini" ? `Gemini (${GEMINI_MODEL})`
  : `Claude (${MODELO})`;
console.log(`[AI] Usando: ${_label()}`);

export function setAiProvider(p) {
  aiProvider = p;
  try { writeFileSync("runtime.json", JSON.stringify({ aiProvider: p })); } catch {}
  console.log(`[AI] Cambiado a: ${_label()}`);
}
export function getCurrentProviderLabel() { return _label(); }

function anthropicAOpenAI(content) {
  return content.map((item) => {
    if (item.type === "image") {
      const { media_type, data } = item.source;
      return { type: "image_url", image_url: { url: `data:${media_type};base64,${data}` } };
    }
    return item;
  });
}

async function _llamarOpenAICompat({ baseUrl, apiKey, model, messages, max_tokens }) {
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, max_tokens }),
  });
  if (!resp.ok) throw new Error(`${model} error ${resp.status}: ${await resp.text()}`);
  const json = await resp.json();
  return { content: [{ text: json.choices[0].message.content }] };
}

async function llamarClaude(body) {
  console.log(`[AI] Llamando ${_label()}...`);

  const messages = body.messages.map((msg) => ({
    role: msg.role,
    content: Array.isArray(msg.content) ? anthropicAOpenAI(msg.content) : msg.content,
  }));

  if (aiProvider === "ollama") {
    return _llamarOpenAICompat({ baseUrl: `${OLLAMA_BASE_URL}/v1`, apiKey: "ollama", model: OLLAMA_MODEL, messages, max_tokens: body.max_tokens });
  }
  if (aiProvider === "gemini") {
    return _llamarOpenAICompat({ baseUrl: GEMINI_BASE_URL, apiKey: GEMINI_API_KEY, model: GEMINI_MODEL, messages, max_tokens: body.max_tokens });
  }
  return await anthropicClient.messages.create(body);
}

// Portado directamente de background.js de la extensión.
// Cambios: chrome.storage / IndexedDB eliminados, llamarClaudeMessages → llamarClaude.
export async function compararPaginasConReferencia(nuevasPaginas, referencia) {
  const tieneImagenes =
    (referencia?.imagenesPorBloque && Object.keys(referencia.imagenesPorBloque).length > 0) ||
    (referencia?.imagenes?.length > 0);
  if (!nuevasPaginas?.length || !referencia?.bloques?.length || !tieneImagenes) return null;

  const bloquesRef = referencia.bloques
    .map((b) => {
      let imagenesRef = [];
      if (Array.isArray(referencia.imagenes) && referencia.imagenes.length > 0) {
        imagenesRef = (b.paginas || [])
          .map((pNum) => {
            const img = referencia.imagenes.find((i) => i.pagina === pNum);
            return img ? img.base64 : null;
          })
          .filter(Boolean);
      }
      if (
        imagenesRef.length === 0 &&
        referencia.imagenesPorBloque &&
        referencia.imagenesPorBloque[b.nombre]
      ) {
        imagenesRef = [referencia.imagenesPorBloque[b.nombre]];
      }
      return imagenesRef.length > 0 ? { ...b, imagenesRef } : null;
    })
    .filter(Boolean);

  if (!bloquesRef.length) return null;

  bloquesRef.forEach((b, idx) => {
    console.log(
      `[MAU] Ref ${idx + 1} "${b.nombre}": ${b.imagenesRef.length} imagen(es), páginas: [${(b.paginas || []).join(",")}]`
    );
  });

  const content = [];

  content.push({ type: "text", text: "BLOQUES DE REFERENCIA (todas las páginas del bloque):\n" });
  bloquesRef.forEach((b, idx) => {
    content.push({
      type: "text",
      text: `\nRef ${idx + 1}: ${b.nombre || "Bloque"} (${b.imagenesRef.length} tipo(s) de formulario)`,
    });
    b.imagenesRef.forEach((imgBase64, pIdx) => {
      content.push({ type: "text", text: `  Formulario ${pIdx + 1} de Ref ${idx + 1}:` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: imgBase64 } });
    });
  });

  content.push({ type: "text", text: "\n\nPÁGINAS NUEVAS:\n" });
  nuevasPaginas.forEach((p) => {
    content.push({ type: "text", text: `\nPágina ${p.pagina}:` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: p.base64 } });
  });

  content.push({
    type: "text",
    text: `

TAREA: para cada página nueva, determiná a qué Ref pertenece.

CÓMO HACER EL MATCH:
Cada Ref representa un empleado y tiene uno o más tipos de formulario (Formulario 1, Formulario 2, etc.).
Una página nueva pertenece a un Ref si es del MISMO TIPO de formulario que alguno de sus formularios:
  - Mismo nombre o título del formulario
  - Misma empresa o institución que lo emite
  - Misma estructura general del documento

No importa el orden en que vienen las páginas, la calidad del scan, ni pequeñas diferencias de contenido.
Lo que importa es si es el MISMO TIPO de formulario.

Además, extraé de cada página nueva (si es legible):
- apellido (si podés, apellido + nombre completo del empleado)
- nombre
- CUIL del empleado
- entidades_mencionadas: array con nombres completos y/o patentes que aparezcan en la página

Si una página definitivamente no es ningún tipo de formulario de ningún Ref → bloque: null.

IMPORTANTE: reportá TODAS las páginas nuevas en el JSON, incluso las que no coinciden (bloque: null).

Respondé SOLO JSON válido, sin texto extra:
{
  "paginas": [
    { "pagina_nueva": 1, "apellido": "APELLIDO NOMBRE", "nombre": "", "cuil_leido": "20-12345678-9", "entidades_mencionadas": ["APELLIDO NOMBRE"], "bloque": "Ref 1" },
    { "pagina_nueva": 2, "apellido": "", "nombre": "", "cuil_leido": "", "entidades_mencionadas": [], "bloque": null }
  ]
}`,
  });

  const json = await llamarClaude({
    model: MODELO,
    max_tokens: 2500,
    messages: [{ role: "user", content }],
  });

  const textoResp = (json?.content?.[0]?.text || "").trim();
  console.log(`[MAU] Respuesta Claude (${textoResp.length} chars):`, textoResp.slice(0, 400));

  let parsed = null;
  try {
    const bloqueJson = textoResp.match(/```json\s*([\s\S]*?)```/i);
    if (bloqueJson) {
      parsed = JSON.parse(bloqueJson[1].trim());
    } else {
      parsed = JSON.parse(textoResp);
    }
  } catch {
    const m = textoResp.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
  }

  if (!parsed?.paginas?.length) return null;

  const normCuil = (s) => String(s || "").replace(/\D/g, "");
  const bloquesMapIdx = new Map();

  for (const item of parsed.paginas) {
    if (!item.pagina_nueva || !item.bloque) continue;

    let refIdx = bloquesRef.findIndex((b) => b.nombre === item.bloque);
    if (refIdx === -1) {
      const mm = String(item.bloque).match(/^Ref\s*(\d+)$/i);
      if (mm) {
        const i = parseInt(mm[1]) - 1;
        if (i >= 0 && i < bloquesRef.length) refIdx = i;
      }
    }
    if (refIdx === -1) continue;

    const refBloque = bloquesRef[refIdx];
    const cuilLeido = normCuil(item.cuil_leido);
    console.log(`[MAU] Pág ${item.pagina_nueva} → Ref ${refIdx + 1} "${refBloque.nombre}" CUIL=${cuilLeido || "(sin cuil)"}`);

    if (!bloquesMapIdx.has(refIdx)) {
      bloquesMapIdx.set(refIdx, {
        nombre: refBloque.nombre,
        paginas: [],
        paginasMapeo: (refBloque.paginas || []).length,
        requerimientos: refBloque.requerimientos || [],
        destino: refBloque.destino || { modo: "uno", entidadesObjetivo: [] },
        meta: {},
      });
    }

    const entrada = bloquesMapIdx.get(refIdx);
    const metaActual = entrada.meta;
    const metaNuevo = {
      ...metaActual,
      apellido: metaActual.apellido || String(item.apellido || "").trim(),
      nombre: metaActual.nombre || String(item.nombre || "").trim(),
    };
    const entidadesPag = Array.isArray(item.entidades_mencionadas)
      ? item.entidades_mencionadas.map((x) => String(x || "").trim()).filter(Boolean)
      : [];
    if (entidadesPag.length) {
      const prev = Array.isArray(metaActual.entidades_mencionadas) ? metaActual.entidades_mencionadas : [];
      metaNuevo.entidades_mencionadas = Array.from(new Set([...prev, ...entidadesPag]));
    }
    if (cuilLeido) metaNuevo.cuil = item.cuil_leido;
    entrada.meta = metaNuevo;
    entrada.paginas.push(item.pagina_nueva);
  }

  const descartados = [];
  const resultado = Array.from(bloquesMapIdx.values()).filter((b) => {
    if (!b.paginas.length || !b.requerimientos.length) return false;
    if (b.paginasMapeo > 0 && b.paginas.length < b.paginasMapeo) {
      console.log(`[MAU] Bloque "${b.nombre}" descartado: ${b.paginas.length}/${b.paginasMapeo} páginas`);
      descartados.push(b);
      return false;
    }
    return true;
  });

  if (resultado.length) resultado.descartados = descartados;
  return resultado.length ? resultado : null;
}

// Matching para el flujo /trabajar del bot.
// mapeos: [{ nombre, paginas: [{ num, imagen, texto }] }]  — tipos aprendidos con imágenes de referencia
// reqsPendientes: [{ nombre, entidad, href }]               — reqs pendientes leídos de CD
// nuevasPaginas: [{ pagina, base64 }]                       — páginas del PDF nuevo
//
// Agrupa páginas por entidad (empleado/vehículo) y devuelve TODOS los reqs que le corresponden a cada grupo.
// Un mismo grupo puede subirse a múltiples reqs si el usuario así lo configuró en /aprender.
// Devuelve { grupos: [{ entidad, paginas: [N], reqs: [req1, req2] }], sinAsignar: [N] } o null
export async function matchearPaginasConReqs(nuevasPaginas, mapeos, reqsPendientes) {
  if (!nuevasPaginas?.length || !mapeos?.length || !reqsPendientes?.length) return null;

  const content = [];

  content.push({ type: "text", text: "TIPOS DE DOCUMENTO APRENDIDOS (referencias visuales):\n" });
  mapeos.forEach((m, i) => {
    const nPags = m.paginas.length;
    content.push({ type: "text", text: `\nTipo ${i + 1}: "${m.nombre}" — EXACTAMENTE ${nPags} página${nPags !== 1 ? "s" : ""} por documento` });
    m.paginas.forEach((p, pi) => {
      content.push({ type: "text", text: `  Página de referencia ${pi + 1}:` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: p.imagen } });
    });
  });

  const listaReqs = reqsPendientes
    .map((r, i) => `${i + 1}. ${r.nombre}${r.entidad ? ` — ${r.entidad}` : ""}`)
    .join("\n");
  content.push({ type: "text", text: `\n\nREQUERIMIENTOS PENDIENTES EN CD:\n${listaReqs}` });

  content.push({ type: "text", text: "\n\nPÁGINAS NUEVAS A CLASIFICAR:\n" });
  nuevasPaginas.forEach((p) => {
    content.push({ type: "text", text: `\nPágina ${p.pagina}:` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: p.base64 } });
  });

  content.push({
    type: "text",
    text: `

TAREA: agrupar las páginas nuevas por entidad e identificar los requerimientos pendientes correspondientes.

PASO 1 — AGRUPAR POR ENTIDAD:
Leé la patente del vehículo o el nombre del empleado en CADA página.
Agrupá las páginas que pertenecen a la misma entidad (misma patente o misma persona).
CRÍTICO: cada grupo debe tener EXACTAMENTE la cantidad de páginas indicada para ese tipo de documento.
Si una entidad aparece en más o menos páginas de las esperadas, revisá si leíste mal la patente/nombre.

PASO 2 — IDENTIFICAR REQUERIMIENTOS:
Para cada grupo, encontrá TODOS los requerimientos pendientes que coinciden visualmente con los Tipos aprendidos:
- Comparar el tipo de documento (visualmente) con las imágenes de referencia.
- El nombre del req incluye un período (ej: "-2026-4") — ignorarlo al comparar con el tipo aprendido.
- Si dos Tipos aprendidos son visualmente idénticos o muy similares, incluí los reqs de AMBOS.
- SOLO asignár reqs cuyo tipo base coincida con algún Tipo aprendido. No inventar nuevos tipos.

Respondé SOLO JSON válido, sin texto extra:
{
  "grupos": [
    { "entidad": "UMM906", "paginas": [1, 3], "reqs": [1, 2] },
    { "entidad": "HTC822", "paginas": [2, 4], "reqs": [3, 4] }
  ],
  "sinAsignar": []
}

reqs: array de números (1-based) de la lista de reqs pendientes.
sinAsignar: páginas que definitivamente no corresponden a ningún tipo aprendido.`,
  });

  const resp = await llamarClaude({
    model: MODELO,
    max_tokens: 2000,
    messages: [{ role: "user", content }],
  });

  const textoResp = (resp?.content?.[0]?.text || "").trim();
  console.log(`[MATCH] Respuesta Claude (${textoResp.length} chars):`, textoResp.slice(0, 400));

  let parsed = null;
  try {
    const bloqueJson = textoResp.match(/```json\s*([\s\S]*?)```/i);
    parsed = JSON.parse(bloqueJson ? bloqueJson[1].trim() : textoResp);
  } catch {
    const m = textoResp.match(/\{[\s\S]*\}/);
    if (m) try { parsed = JSON.parse(m[0]); } catch {}
  }

  if (!parsed?.grupos?.length) return null;

  // Normaliza el nombre quitando el sufijo de período "-YYYY-N" para comparar.
  const baseNombre = (s) => String(s || "").replace(/-\d{4}-\d+$/i, "").trim().toLowerCase();
  // Map de baseNombre → cantidad de páginas esperadas según el mapeo aprendido
  const paginasPorTipo = new Map(mapeos.map((m) => [baseNombre(m.nombre), m.paginas.length]));

  const grupos = [];
  const sinAsignarExtra = [];
  for (const g of parsed.grupos) {
    if (!g.paginas?.length) continue;

    // Filtrar reqs a solo tipos aprendidos
    const reqs = (g.reqs || [])
      .map((n) => (n >= 1 && n <= reqsPendientes.length ? reqsPendientes[n - 1] : null))
      .filter(Boolean)
      .filter((r) => {
        const coincide = paginasPorTipo.has(baseNombre(r.nombre));
        if (!coincide) console.log(`[MATCH] Req descartado (sin mapeo): "${r.nombre}"`);
        return coincide;
      });

    if (!reqs.length) { sinAsignarExtra.push(...g.paginas); continue; }

    // Validar página count: el grupo debe tener al menos las páginas que el mapeo espera
    const paginasGrupo = g.paginas.length;
    const reqsValidos = reqs.filter((r) => {
      const esperadas = paginasPorTipo.get(baseNombre(r.nombre)) || 1;
      if (paginasGrupo < esperadas) {
        console.log(`[MATCH] "${r.nombre}" — ${g.entidad}: ${paginasGrupo}/${esperadas} págs (incompleto, descartado)`);
        return false;
      }
      if (paginasGrupo > esperadas) {
        console.log(`[MATCH] "${r.nombre}" — ${g.entidad}: ${paginasGrupo}/${esperadas} págs (exceso, revisar agrupación)`);
      }
      return true;
    });

    if (reqsValidos.length > 0) {
      grupos.push({ entidad: String(g.entidad || ""), paginas: g.paginas, reqs: reqsValidos });
    } else {
      sinAsignarExtra.push(...g.paginas);
    }
  }

  const sinAsignar = [
    ...(Array.isArray(parsed.sinAsignar) ? parsed.sinAsignar : []),
    ...sinAsignarExtra,
  ];
  return grupos.length ? { grupos, sinAsignar } : null;
}
