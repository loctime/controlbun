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

### Trabajar — Subir PDF
1. Usuario manda PDF
2. Bot renderiza páginas con Playwright (`pdfAImagenes`)
3. Lee mapeos del usuario (`leerTodosMapeosPorTipo`) — formato bot: por tipo de requerimiento
4. Lee requerimientos pendientes de CD (`cdLeerRequerimientos`) — con entidades y hrefs reales
5. Claude asigna cada página a un req pendiente específico (`matchearPaginasConReqs` en claude.js)
   - Claude recibe: imágenes de referencia por tipo + lista numerada de reqs pendientes (tipo + entidad) + páginas nuevas
   - Claude devuelve `req_num` (1-based) por cada página nueva
6. Bot muestra resumen (grupos identificados + páginas sin identificar) y pide confirmación
7. Usuario responde "sí" → pdf-lib corta el PDF por grupo (`cortarPaginas`) → Playwright sube cada sección (`cdSubirArchivo`)
8. Bot reporta resultado por grupo (✅/❌) y total final

## Decisiones de arquitectura importantes

### Sesión de CD cacheada por usuario
`cdObtenerSesionActiva(chatId, cdUser, cdPass)` mantiene la sesión de Playwright abierta por 25 minutos por usuario. Si la página sigue logueada, la reutiliza sin hacer login de nuevo. Invalida con `cdInvalidarSesion(chatId)` en errores o al cambiar credenciales.

### Dos funciones de lectura de CD separadas
- `cdLeerTiposRequerimientos(page)` — para /aprender: lee el dropdown de filtro de la bandeja que tiene "Sobres activos" como primera opción. Devuelve todos los TIPOS de requerimientos de la cuenta (lista completa, sin filtrar por período ni estado).
- `cdLeerRequerimientos(page)` — para /trabajar: lee filas de la tabla filtrando por "Sobres activos" y extrae entidades (nombre de empleado o patente) por la columna "Recurso".

### Entidades (empleados/vehículos) leídas por columna "Recurso"
`parsearRecurso(td)` portado de panel.js de la extensión. Detecta el índice de la columna "Recurso" por el `<th>`. Extrae: patente (regex), link del recurso, o primera línea de innerText antes de "Argentina/Empleador/Contrato".

### Lista de tipos para /aprender — sin entidades, sin duplicados
El mapeo es general para todos los empleados/vehículos. El flujo /aprender muestra tipos únicos (ej: "Recibos de haberes ram") sin entidades específicas. Los hrefs específicos se buscan en /trabajar al momento de subir.

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
Claude asigna cada página a un req pendiente específico por número (req_num 1-based).
Esto resuelve ambigüedades de OCR: si lee "HRB4B7" pero en CD existe "HRB477", Claude elige el correcto de la lista.

### Dos funciones de matching en claude.js
- `compararPaginasConReferencia` — formato viejo (extensión), bloques con múltiples empleados. No se usa en el bot.
- `matchearPaginasConReqs(nuevasPaginas, mapeos, reqsPendientes)` — formato nuevo del bot. Recibe tipos aprendidos (imágenes de referencia) + lista de reqs pendientes de CD → asigna páginas directamente a reqs específicos.

### Estado de sesión en memoria
Las sesiones de /aprender y /config se guardan en un `Map` en memoria.
Si el bot se reinicia, el usuario pierde el estado y debe volver a empezar.
Aceptable para este caso de uso — los flujos son cortos.

### 1 sola llamada a Claude para todo el matching
Igual que la extensión. Claude ve TODAS las refs + TODAS las páginas nuevas en una sola llamada.
No cambiar a multi-llamada — el costo sube y no mejora la precisión.
No agregar chain-of-thought — empeora las asignaciones.

## AI Provider

`claude.js` soporta tres providers, controlados por `AI_PROVIDER` en `.env`:

| Valor | Descripción |
|---|---|
| `claude` | Producción — Anthropic API (Haiku por defecto) |
| `gemini` | Desarrollo — Google AI Studio, gratis. Modelo: `gemini-2.5-flash` |
| `ollama` | Local — requiere GPU dedicada; con APU integrada es demasiado lento |

Variables adicionales en `.env`:
```
AI_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash

# Ollama (si se usa)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=hf.co/xtuner/llava-phi-3-mini-gguf:F16
```

> La key de Gemini debe crearse desde **aistudio.google.com/apikey** (no desde Google Cloud Console — esas keys tienen cuotas en 0).

## Estado actual

| Módulo | Estado |
|---|---|
| Renderizado PDF (Playwright + pdfjs CDN) | ✅ Funcionando |
| Corte de PDFs (pdf-lib) | ✅ Implementado |
| Flujo /config (credenciales CD) | ✅ Completo y probado |
| Flujo /aprender (mapeo) | ✅ Completo y probado |
| Flujo /pendientes (listar reqs pendientes) | ✅ Implementado |
| cd.js: login (con caché de sesión 25 min) | ✅ Funcionando |
| cd.js: leer tipos de reqs (dropdown completo) | ✅ Funcionando |
| cd.js: leer reqs con entidades (para /trabajar) | ✅ Funcionando |
| cd.js: subir archivo (adjuntar + continuar + enviar) | ✅ Probado y funcionando |
| claude.js: multi-provider (Claude/Gemini/Ollama) | ✅ Implementado |
| claude.js: matchearPaginasConReqs | ✅ Funcionando con Gemini |
| Flujo Trabajar en bot.js | ✅ Implementado |
| Texto estable en mapeos (al aprender) | ⏳ Pendiente |
| Prueba end-to-end completa con clientes reales | ⏳ Pendiente |

## Flujo de subida a CD (cdSubirArchivo)

El flujo real de CD tiene 5 pasos que Playwright ejecuta en orden:

1. **Navegar al req** — por `href` si existe, o click en la bandeja
2. **Click "Adjuntar archivo"** — en el frame `BandejaDetalle`
3. **Asignar PDF** — `setInputFiles` en `input[type=file]` de `BandejaUpload`
4. **Esperar "Archivo cargado con exito"** — confirma que el servidor recibió el archivo, luego click "Continuar"
5. **Click "Enviar"** — via `__doPostBack('btnEnviar','')` directo en el frame `BandejaDetalle` (el botón tiene `onclick` con `ControlaEnviar()` que valida el archivo antes de postback)

> El botón Enviar es `<input type="submit" id="btnEnviar">`. Se llama `__doPostBack` directamente para evitar race conditions con `ControlaEnviar()`.

## Botón Buscar en la bandeja

CD tiene un retraso antes de que el botón "Buscar" esté listo. `_clickBuscarYEsperar` reintenta:
1. Click en Buscar → espera 3s
2. Verifica filas reales (≥4 `td` + link) — si no hay, espera 3s más y reintenta

## Lo que NO hacer

- No usar `pdfjs-dist` + `canvas` en Node.js — usa siempre Playwright para renderizar
- No agregar chain-of-thought al prompt de Claude/Gemini para matching
- No cambiar el flujo de 1 sola llamada a AI por matching
- No commitear `.env`, `mapeos/`, `clientes/`, `pendientes.json` — datos sensibles por cliente
- No guardar las credenciales de CD en texto plano en otro lado que no sea el JSON del cliente
- No crear key de Gemini desde Google Cloud Console — usar aistudio.google.com

## Para continuar / debug

Script de prueba de subida sin Telegram ni IA:
```
node test-subir.js <archivo.pdf> [filtro_nombre_req]
# Ejemplo:
node test-subir.js 111111.pdf "F 931"
```

Si algo no funciona en el flujo de CD:
- Verificar selectores con `headless: false` en `cd.js` → `chromium.launch({ headless: false })`
- Los iframes de CD son el punto más frágil — revisar `cdSubirArchivo` si falla la subida
- Agregar `await page.screenshot(...)` después de cada paso para ver el estado visual

Variables de entorno necesarias en `.env`:
```
TG_TOKEN=...
ANTHROPIC_API_KEY=...
ADMIN_CHAT_ID=...
AI_PROVIDER=gemini
GEMINI_API_KEY=...
```
