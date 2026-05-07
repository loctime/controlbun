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

  content.push({ type: "text", text: "TIPOS DE DOCUMENTO APRENDIDOS (referencias visuales):\nIMPORTANTE: estas imágenes muestran el TIPO de documento, NO la entidad. La patente o nombre que aparezca en la imagen de referencia es solo un ejemplo — ignorala al detectar entidades en páginas nuevas.\n" });
  mapeos.forEach((m, i) => {
    const nPags = m.paginas.length;
    content.push({ type: "text", text: `\nTipo ${i + 1}: "${m.nombre}" — EXACTAMENTE ${nPags} página${nPags !== 1 ? "s" : ""} por documento` });
    m.paginas.forEach((p, pi) => {
      content.push({ type: "text", text: `  Página de referencia ${pi + 1} (solo muestra el formato, ignorar la entidad que aparezca):` });
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

TAREA: formar grupos de páginas por entidad y asignarlos a los requerimientos pendientes.

PASO 1 — IDENTIFICAR ENTIDADES:
Leé las páginas nuevas (NO las referencias del mapeo). Las páginas nuevas que muestran una patente de vehículo o nombre de empleado VISIBLE EN ESA PÁGINA son las páginas "ancla" — cada valor único es una entidad distinta.
Si una página nueva no tiene patente visible → entidad_detectada: vacío. Asumir que es un documento de "empresa".

PASO 2 — COMPLETAR CADA GRUPO SEGÚN EL MAPEO:
El mapeo de referencia es la autoridad: define exactamente qué tipos de página necesita cada entidad.
Para cada entidad identificada en el Paso 1:
  a) Asigná las páginas ancla que la identifican directamente.
  b) Revisá el mapeo: ¿cuantas paginas exactas son? Buscá esas páginas entre las restantes sin asignar, comparando visualmente con las imágenes de referencia del mapeo.
  c) Si hay varias páginas candidatas para el mismo slot y son visualmente idénticas: asignalas en orden de aparición — la 1ra candidata (menor número de página) va a la 1ra entidad (la que apareció antes en el documento), la 2da candidata a la 2da entidad, etc.

PASO 3 — VERIFICAR Y DESCARTAR:
Cada grupo debe quedar exactamente como indica el mapeo. Si falta algún tipo de página para completar un grupo → descartarlo. El mapeo manda: no aceptar grupos incompletos.
Si sobran paginas que no corresponden a ningun grupo → descartarlas.

PASO 4 — ASIGNAR REQUERIMIENTOS:
Para cada grupo completo, encontrá TODOS los requerimientos pendientes que coinciden con sus tipos de documento:
- Comparar visualmente con las imágenes de referencia del mapeo.
- Ignorar el sufijo de período en el nombre del req (ej: "-2026-4") al comparar.
- Si dos tipos del mapeo son visualmente similares, incluí los reqs de ambos.
- Solo asignar reqs que coincidan con algún tipo aprendido. No inventar tipos.

Respondé SOLO JSON válido, sin texto extra:
{
  "paginas_clasificadas": [
    { "pagina": 1, "tipo_detectado": "Pago del seguro técnico", "entidad_detectada": "" },
    { "pagina": 2, "tipo_detectado": "Pago del seguro técnico", "entidad_detectada": "" },
    { "pagina": 3, "tipo_detectado": "Pago del seguro automotor", "entidad_detectada": "UMM906" },
    { "pagina": 4, "tipo_detectado": "Pago del seguro automotor", "entidad_detectada": "HTC822" }
  ],
  "grupos": [
    { "entidad": "UMM906", "paginas": [1, 3], "reqs": [1, 2] },
    { "entidad": "HTC822", "paginas": [2, 4], "reqs": [3, 4] }
  ],
  "sinAsignar": []
}

paginas_clasificadas: para CADA página nueva, el tipo detectado (escribe EXACTAMENTE el nombre del Tipo aprendido de la lista, ej: "F 931" — no describas con palabras propias) y la entidad detectada (patente/nombre, o vacío si no tiene).
reqs: números 1-based de la lista de reqs pendientes.
sinAsignar: páginas que no corresponden a ningún tipo del mapeo o que quedaron de grupos descartados.`,
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
  // Map de baseNombre(mapeo) → cantidad de páginas esperadas
  const paginasPorTipo = new Map(mapeos.map((m) => [baseNombre(m.nombre), m.paginas.length]));
  // Map de número de página → tipo detectado por la IA (normalizado)
  const tipoDetectadoPorPag = new Map(
    (parsed.paginas_clasificadas || []).map((pc) => [pc.pagina, baseNombre(pc.tipo_detectado || "")])
  );

  const grupos = [];
  const sinAsignarExtra = [];
  const sinRequeridoItems = [];
  for (const g of parsed.grupos) {
    if (!g.paginas?.length) continue;

    // 1. Verificar si el tipo fue reconocido desde el mapeo
    const tiposAprendidosEnGrupo = g.paginas
      .map((p) => tipoDetectadoPorPag.get(p))
      .filter((t) => t && paginasPorTipo.has(t));

    if (!tiposAprendidosEnGrupo.length) {
      const tiposRaw = g.paginas.map((p) => tipoDetectadoPorPag.get(p) || "?").join(", ");
      console.log(`[MATCH] Grupo "${g.entidad}": tipo detectado "${tiposRaw}" sin mapeo — descartado`);
      sinAsignarExtra.push(...g.paginas);
      continue;
    }

    // 2. Validar página count según el tipo detectado (primer tipo aprendido del grupo)
    const tipoBase = tiposAprendidosEnGrupo[0];
    const esperadas = paginasPorTipo.get(tipoBase) || 1;
    const paginasGrupo = g.paginas.length;

    if (paginasGrupo < esperadas) {
      console.log(`[MATCH] Grupo "${g.entidad}" (${tipoBase}): ${paginasGrupo}/${esperadas} págs (incompleto, descartado)`);
      sinAsignarExtra.push(...g.paginas);
      continue;
    }
    if (paginasGrupo > esperadas) {
      console.log(`[MATCH] Grupo "${g.entidad}" (${tipoBase}): ${paginasGrupo}/${esperadas} págs (exceso, revisar agrupación)`);
    }

    // 3. Verificar reqs asignados
    const reqs = (g.reqs || [])
      .map((n) => (n >= 1 && n <= reqsPendientes.length ? reqsPendientes[n - 1] : null))
      .filter(Boolean);

    if (!reqs.length) {
      // Tipo reconocido + páginas completas, pero sin requerido en CD → generable
      console.log(`[MATCH] Grupo "${g.entidad}" (${tipoBase}): tipo reconocido sin requerido en CD → generable`);
      sinRequeridoItems.push({ paginas: g.paginas, tipo: tipoBase, entidad: String(g.entidad || "") });
      continue;
    }

    // Por cada (baseType × entidad), quedar solo con el período más reciente
    const parsePeriodo = (nombre) => {
      const m = String(nombre || "").match(/-(\d{4})-(\d+)$/i);
      return m ? [parseInt(m[1]), parseInt(m[2])] : [0, 0];
    };
    const reqLatest = new Map();
    const omitidos = [];
    for (const r of reqs) {
      const key = `${baseNombre(r.nombre)}|${String(r.entidad || "").toLowerCase()}`;
      const [yr, per] = parsePeriodo(r.nombre);
      const existing = reqLatest.get(key);
      if (!existing) {
        reqLatest.set(key, { req: r, yr, per });
      } else if (yr > existing.yr || (yr === existing.yr && per > existing.per)) {
        omitidos.push(existing.req);
        reqLatest.set(key, { req: r, yr, per });
      } else {
        omitidos.push(r);
      }
    }
    const reqsFinal = [...reqLatest.values()].map((v) => v.req);
    if (omitidos.length) {
      console.log(`[MATCH] Grupo "${g.entidad}": ${omitidos.map((r) => r.nombre).join(", ")} omitidos (período anterior)`);
    }

    grupos.push({ entidad: String(g.entidad || ""), paginas: g.paginas, reqs: reqsFinal, omitidos });
  }

  const sinAsignar = [
    ...(Array.isArray(parsed.sinAsignar) ? parsed.sinAsignar : []),
    ...sinAsignarExtra,
  ];
  const paginasClasificadas = Array.isArray(parsed.paginas_clasificadas) ? parsed.paginas_clasificadas : [];
  if (grupos.length || sinRequeridoItems.length) {
    return { grupos, sinAsignar, sinRequerido: sinRequeridoItems, paginasClasificadas };
  }
  return null;
}
