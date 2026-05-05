import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODELO = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";

async function llamarClaude(body) {
  return await client.messages.create(body);
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
