# ControlBun — Estado del proyecto (para Claude)

## Qué es esto

Bot de Telegram que reemplaza la extensión de Chrome ControlInject/ControlBun.
Automatiza la subida de documentos PDF a controldocumentario.com usando Claude para el matching visual y Playwright para la automatización web. Cada cliente es un usuario de Telegram con sus propias credenciales de CD y sus propios mapeos.

## Archivos clave

| Archivo | Rol |
|---|---|
| `bot.js` | Manejador principal del bot. Estado de sesión por usuario (en memoria). Comandos: /config, /aprender, /listo, /nuevocliente |
| `pdf.js` | Renderizado de PDFs a imágenes (`pdfAImagenes` via Playwright + pdfjs CDN). Corte de PDFs (`cortarPaginas` via pdf-lib) |
| `claude.js` | Matching de páginas con Claude (`compararPaginasConReferencia`). Portado directamente desde background.js de la extensión |
| `mapeos.js` | Almacenamiento de mapeos por usuario en archivos JSON bajo `mapeos/{chatId}/` |
| `cd.js` | Automatización de controldocumentario.com con Playwright: login, leer requerimientos, subir archivos |
| `clientes.js` | Gestión de clientes: registro con código, credenciales CD, configuración |

## Estructura de datos

### Cliente (`clientes/{slug}.json`)
```json
{
  "chatId": "5027660294",
  "nombre": "Fernando Vidal",
  "cdUser": "usuario@empresa.com",
  "cdPass": "contraseña",
  "diasPersonal": 7,
  "diasVehiculos": 15
}
```

### Mapeo (`mapeos/{chatId}/{nombre_requerimiento}.json`)
```json
{
  "nombre": "Recibo de haberes",
  "paginas": [
    { "num": 1, "imagen": "base64...", "texto": "" },
    { "num": 2, "imagen": "base64...", "texto": "" }
  ],
  "href": "https://controldocumentario.com/...",
  "entidad": "García Juan",
  "guardadoEn": 1234567890
}
```

## Flujos principales

### /config — Configurar credenciales de CD
1. Usuario: `/config`
2. Bot pide usuario (email) → contraseña
3. Bot prueba el login real contra CD antes de guardar
4. Si OK → guarda en `clientes/{slug}.json`

### /aprender — Mapear documentos
1. `/aprender` → login a CD → lee requerimientos pendientes (con entidades)
2. Pide PDF de referencia → lo renderiza → manda todas las páginas al chat
3. Usuario agrupa páginas: `1,2` → bot muestra lista de requerimientos de CD
4. Usuario elige número → bot confirma y pide siguiente grupo
5. `/listo` o todas asignadas → guarda mapeos por requerimiento

### Trabajar — Subir PDF (TODO)
1. Usuario manda PDF
2. Bot renderiza páginas con Playwright (`pdfAImagenes`)
3. Claude compara páginas contra mapeos del usuario (`compararPaginasConReferencia`)
   - Claude recibe: imágenes de referencia + entidades de CD + páginas nuevas
   - Claude devuelve asignaciones directas a requerimientos
4. pdf-lib corta el PDF por bloque (`cortarPaginas`)
5. Bot muestra resumen y pide confirmación
6. Playwright sube cada sección a su requerimiento en CD (`cdSubirArchivo`)

## Decisiones de arquitectura importantes

### Playwright para renderizado de PDFs
pdfjs + node-canvas falla con imágenes embebidas en Node.js (`"Image or Canvas expected"`).
Solución: Playwright lanza un Chromium headless y ejecuta pdfjs v3 desde CDN, igual que la extensión.
No cambiar esto — el error es un bug de compatibilidad pdfjs v5 / canvas en Node.js.

### Mapeos por tipo de requerimiento (no por empresa/sábana)
La extensión guardaba mapeos por empresa ("Empresa ABC" → bloques con reqs).
El bot lo invierte: cada archivo JSON es un tipo de requerimiento ("Recibo de haberes" → páginas de referencia).
Esto simplifica el matching: Claude recibe directamente la lista de reqs pendientes de CD con sus imágenes de referencia.

### Claude recibe requerimientos + entidades + imágenes
A diferencia de la extensión donde Claude solo veía imágenes de referencia, el bot le da también:
- La lista de requerimientos pendientes de CD con sus entidades (nombre/patente)
- El texto estable de cada página de referencia (TODO: extraer al aprender)
Esto resuelve ambigüedades de OCR: si lee "HRB4B7" pero en CD existe "HRB477", Claude elige el correcto.

### Estado de sesión en memoria
Las sesiones de /aprender y /config se guardan en un `Map` en memoria.
Si el bot se reinicia, el usuario pierde el estado y debe volver a empezar.
Aceptable para este caso de uso — los flujos son cortos.

### 1 sola llamada a Claude para todo el matching
Igual que la extensión. Claude ve TODAS las refs + TODAS las páginas nuevas en una sola llamada.
No cambiar a multi-llamada — el costo sube y no mejora la precisión.
No agregar chain-of-thought — empeora las asignaciones.

## Estado actual

| Módulo | Estado |
|---|---|
| Renderizado PDF (Playwright + pdfjs CDN) | ✅ Funcionando |
| Corte de PDFs (pdf-lib) | ✅ Implementado |
| Flujo /config (credenciales CD) | ✅ Completo |
| Flujo /aprender (mapeo) | ✅ Completo |
| cd.js: login + leer reqs | ✅ Implementado (pendiente prueba real) |
| cd.js: subir archivo | ✅ Estructura base (ajustar selectores con CD real) |
| claude.js: compararPaginasConReferencia | ✅ Portado desde extensión |
| Flujo Trabajar en bot.js | ⏳ Pendiente |
| Texto estable en mapeos (al aprender) | ⏳ Pendiente |
| Prueba end-to-end con CD real | ⏳ Pendiente |

## Lo que NO hacer

- No usar `pdfjs-dist` + `canvas` en Node.js — usa siempre Playwright para renderizar
- No agregar chain-of-thought al prompt de Claude para matching
- No cambiar el flujo de 1 sola llamada a Claude por matching
- No commitear `.env`, `mapeos/`, `clientes/`, `pendientes.json` — datos sensibles por cliente
- No guardar las credenciales de CD en texto plano en otro lado que no sea el JSON del cliente

## Para continuar

Si algo no funciona en el flujo de CD (login, leer reqs, subir):
- Verificar selectores con `headless: false` en `cd.js` → `chromium.launch({ headless: false })`
- Los iframes de CD son el punto más frágil — revisar `cdSubirArchivo` si falla la subida

Variables de entorno necesarias en `.env`:
```
TG_TOKEN=...
ANTHROPIC_API_KEY=...
ADMIN_CHAT_ID=...
```
