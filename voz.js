import { Client, handle_file } from "@gradio/client";
import { writeFile, unlink, rm, mkdtemp } from "fs/promises";
import { readFileSync, writeFileSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";
import path from "path";

const execFileP = promisify(execFile);

// Voz oficial de ControlApps (VoxCPM2 Voice Design — variante "Locutor").
// Receta validada y guardada: ver memoria reference_voxcpm_voz_oficial.
const SPACE = "openbmb/VoxCPM-Demo";
// Voz #1 "Locutor" elegida por Diego. Para que suene SIEMPRE igual se clona desde
// este sample de referencia (Voice Design genera voz aleatoria en cada corrida).
const REF_AUDIO = "voz-ref.mp3"; // cwd = /opt/controlbun
const MAX_LEN = 800; // recorte de seguridad por audio
const STATE_FILE = "voz-state.json"; // on/off por chat (cwd = /opt/controlbun)

// ── Estado on/off por chat ──────────────────────────────────────────────────
function leerEstado() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function guardarEstado(obj) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(obj));
  } catch (e) {
    console.error("[voz] no pude guardar estado:", e.message);
  }
}
export function vozHabilitada(chatId) {
  return leerEstado()[String(chatId)] === true;
}
// Alterna el estado del chat y devuelve el nuevo valor (true = activado).
export function toggleVoz(chatId) {
  const st = leerEstado();
  const key = String(chatId);
  st[key] = !st[key];
  guardarEstado(st);
  return st[key];
}

// ── Generación de nota de voz ────────────────────────────────────────────────
// Genera una nota de voz (OGG/Opus, lista para Telegram) a partir de texto.
// Devuelve { path, cleanup } — el caller debe llamar cleanup() tras enviarla.
export async function generarNotaVoz(texto) {
  const limpio = (texto || "").trim();
  if (!limpio) throw new Error("Texto vacío");
  const recortado = limpio.slice(0, MAX_LEN);

  const app = await Client.connect(SPACE);
  const result = await app.predict("/generate", {
    text_input: recortado,
    control_instruction: "",
    reference_wav_path_input: handle_file(REF_AUDIO),
    use_prompt_text: false,
    prompt_text_input: "",
    cfg_value_input: 2.0,
    do_normalize: true,
    denoise: false,
  });

  const fd = result?.data?.[0];
  const url = fd?.url || fd?.path;
  if (!url) throw new Error("El Space no devolvió audio");

  const resp = await fetch(url);
  if (!resp.ok) throw new Error("No se pudo descargar el audio (HTTP " + resp.status + ")");
  const buf = Buffer.from(await resp.arrayBuffer());

  const dir = await mkdtemp(path.join(os.tmpdir(), "voz-"));
  const mp3 = path.join(dir, "in.mp3");
  const ogg = path.join(dir, "out.ogg");
  await writeFile(mp3, buf);
  await execFileP("ffmpeg", ["-y", "-loglevel", "error", "-i", mp3, "-c:a", "libopus", "-b:a", "48k", ogg]);
  await unlink(mp3).catch(() => {});

  return {
    path: ogg,
    cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {}),
  };
}
