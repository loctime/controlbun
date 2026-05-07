# ControlBun — Estado del proyecto (para Claude)

## Qué es esto

Bot de Telegram que reemplaza la extensión de Chrome ControlInject/ControlBun.
Automatiza la subida de documentos PDF a controldocumentario.com usando Claude/Gemini para el matching visual y Playwright para la automatización web. Cada cliente es un usuario de Telegram con sus propias credenciales de CD y sus propios mapeos.

## Archivos clave

| Archivo | Rol |
|---|---|
| `bot.js` | Manejador principal del bot. Estado de sesión por usuario (en memoria). Todos los comandos y flujos. |
| `pdf.js` | Renderizado de PDFs a imágenes (`pdfAImagenes` via Playwright + pdfjs CDN). Corte de PDFs (`cortarPaginas` via pdf-lib) |
| `claude.js` | Multi-provider AI: Claude Haiku / Gemini 2.5 Flash / Ollama. Matching de páginas (`matchearPaginasConReqs`). Provider switcheable en runtime. |
| `mapeos.js` | Almacenamiento de mapeos por usuario en archivos JSON bajo `mapeos/{chatId}/` |
| `cd.js` | Automatización de controldocumentario.com con Playwright: login, leer requerimientos, subir archivos, leer vencimientos |
| `clientes.js` | Gestión de clientes: registro con código, credenciales CD, configuración |
| `web.js` | Servidor HTTP (puerto 3100) para el panel web. Auth por token de un solo uso, API REST de mapeos. |
| `tunnel.js` | Arranca cloudflared con el token del túnel. Reconexión automática en 15s si cae. |
| `public/app.html` | SPA del panel web: grid de cards con imágenes de referencia, lightbox, modales de eliminar y reemplazar. |
| `runtime.json` | Provider de AI activo (persiste entre reinicios). Gitignoreado. |

## Comandos del bot

| Comando | Acceso | Descripción |
|---|---|---|
| `/config` | todos | Configurar credenciales de CD (prueba el login antes de guardar) |
| `/aprender` | todos | Mapear tipos de documentos con páginas de referencia |
| `/listo` | todos | Finalizar mapeo en curso |
| `/pendientes` | todos | Ver requerimientos pendientes en CD |
| `/vencimientos` | todos | Ver vencimientos próximos (personal + vehículos + proveedor) + screenshots de CD |
| `/partemes` | todos | Grabar parte mensual manualmente (personal + máquinas) |
| `/unico` | todos | Subir un PDF directo a un requerimiento sin IA ni corte |
| `/mapeos` | todos | Ver, reemplazar o eliminar mapeos guardados |
| `/web` | todos | Obtener link de acceso al panel web (expira en 10 min) |
| `/modelo` | admin | Cambiar provider de AI en runtime: `/modelo claude` o `/modelo gemini` |
| `/nuevocliente` | admin | Registrar nuevo cliente: `/nuevocliente NombreApellido CODIGO` |
| `/miid` | todos | Ver el chat ID propio |

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

Un mapeo por tipo de requerimiento. El nombre del archivo es el nombre del requerimiento (incluyendo sufijo de período `-2026-4`). `baseNombreReq()` en bot.js quita ese sufijo para comparar tipos entre períodos.

## Flujos principales

### /aprender — Mapear documentos
1. `/aprender` → login a CD → muestra mapeos ya guardados (si hay) con sugerencia de `/mapeos`
2. Pide PDF de referencia
3. Si **1 página**: va directo a elegir requerimiento (sin pedir agrupación)
4. Si **múltiples páginas**: pide agrupar con mensaje claro (`msgAgrupar`). Cuando queda 1 sola página sin asignar, también va directo a elección.
5. Al elegir requerimiento: detecta si ya existe un mapeo para ese tipo
   - **sí** → reemplaza con las páginas elegidas del PDF actual
   - **no** → vuelve a elegir otro requerimiento
   - **otro** → pide un PDF diferente para usar como referencia
   - **/mapeos** → sale al gestor de mapeos (funciona como comando en cualquier momento)
6. Al guardar: pregunta si quiere mapear otro documento. Si manda PDF → nuevo ciclo (sin reconectar a CD). Si escribe cualquier cosa → termina.
7. `/listo` en cualquier momento guarda lo asignado hasta ese punto.

Todos los mensajes del flujo /aprender incluyen recordatorio `/listo para finalizar el mapeo.`

### /unico — Subir sin IA
1. `/unico` → "Mandame el PDF"
2. PDF recibido → conecta a CD, muestra lista de reqs pendientes
3. Usuario filtra por nombre o elige por número
4. Confirmación → sube el PDF completo sin cortar ni procesar páginas

### /mapeos — Gestionar mapeos
1. `/mapeos` → lista numerada de tipos aprendidos con cantidad de páginas
2. Usuario elige número → bot muestra imagen(es) de referencia + opciones:
   - `reemplazar` → pide nuevo PDF; si 1 pág guarda directo, si múltiples pide cuáles usar
   - `eliminar` → confirmación → elimina y vuelve a la lista actualizada
   - `cancelar` → vuelve a la lista
3. Después de eliminar o reemplazar, **vuelve a mostrar la lista** (no cierra el flujo).

### /web — Panel web de mapeos
El panel vive en `https://mapeos.controldoc.app` y siempre está disponible sin pasar por Telegram.

**Auth principal — formulario de login:**
1. Usuario entra a `https://mapeos.controldoc.app` y ve el formulario
2. Ingresa su usuario y contraseña de controldocumentario.com
3. `POST /api/login` busca en `clientes/*.json` cuál tiene esas credenciales → devuelve el `chatId`
4. Si coincide: crea sesión (cookie HttpOnly, 7 días), muestra el panel
5. Si no coincide: muestra error "Credenciales incorrectas"

**Auth alternativa — link desde Telegram:**
1. `/web` → genera token de un solo uso (válido 10 min) y manda link `https://mapeos.controldoc.app/auth?t=TOKEN`
2. Click → valida token (se destruye), crea sesión, redirige a `/`

**Operaciones disponibles:** zoom (lightbox), **eliminar** (con confirmación), **reemplazar** (subir PDF → seleccionar páginas)
- Múltiples usuarios pueden usar el panel en simultáneo — cada sesión está aislada por `chatId`
- Si se reinicia el bot, las sesiones web activas se invalidan (están en memoria) → el usuario loguea de nuevo

### /modelo — Cambiar AI (admin)
- `/modelo` → muestra provider activo
- `/modelo claude` o `/modelo haiku` → cambia a Claude Haiku
- `/modelo gemini` → cambia a Gemini 2.5 Flash
- Cambio inmediato sin reiniciar. Persiste en `runtime.json`.

### Trabajar — Subir PDF con IA
1. Usuario manda PDF (sin comando previo)
2. Bot renderiza páginas → lee mapeos → lee reqs pendientes de CD
3. AI asigna cada página a un req pendiente específico (`matchearPaginasConReqs`)
4. Bot muestra resumen con confirmación:
   - Cada grupo lista los reqs a subir y los omitidos con ⏩ (períodos anteriores)
   - Si el req más reciente está 2+ meses atrás del mes actual → aviso ⚠️
5. Usuario dice "sí" → corta PDF por grupo → sube cada sección a CD
6. Mensaje final lista los reqs omitidos (período anterior) bajo "⚠️ Quedaron pendientes"

## Decisiones de arquitectura importantes

### AI Provider switcheable en runtime
`claude.js` lee `AI_PROVIDER` del `.env` al arrancar, pero puede sobreescribirse con `runtime.json` (persiste entre reinicios) o con el comando `/modelo` (cambia en memoria + escribe `runtime.json`).
- **Producción**: Claude Haiku (`claude-haiku-4-5-20251001`) — más robusto para JSON estructurado
- **Desarrollo**: Gemini 2.5 Flash — gratuito, ventana de 1M tokens
- `anthropicClient` se crea siempre aunque el provider sea gemini, para que el switch sea instantáneo.

### Un mapeo por tipo de requerimiento
Cada archivo en `mapeos/{chatId}/` representa UN tipo de documento (ej: "Recibo de haberes"). `baseNombreReq(s)` quita el sufijo de período (`-2026-4`) para comparar si dos reqs son el mismo tipo aunque sean de períodos distintos. Al re-aprender un tipo ya existente, el bot muestra la imagen guardada y ofrece 4 opciones.

### Sesión de CD cacheada por usuario
`cdObtenerSesionActiva(chatId, cdUser, cdPass)` mantiene la sesión de Playwright abierta por 25 minutos. Si sigue logueada, la reutiliza. Invalida con `cdInvalidarSesion(chatId)` en errores o al cambiar credenciales.

### Dos funciones de lectura de CD separadas
- `cdLeerTiposRequerimientos(page)` — para /aprender: lee el dropdown completo de tipos (sin filtrar por período ni estado).
- `cdLeerRequerimientos(page)` — para /trabajar y /unico: lee filas filtrando "Sobres activos", extrae entidades por columna "Recurso".

### cdLeerVencimientos — lectura de Vencimientos.aspx
`cdLeerVencimientos(page, diasPersonal, diasVehiculos)` — para /vencimientos:
- URL: `Vencimientos.aspx?menu=11`
- Selecciona "personal" en el dropdown (el que tiene Personal + Maquinas), hace Buscar, lee tabla con umbral `diasPersonal`. Lee también la tabla resumen del proveedor (umbral = max de ambos).
- Selecciona "maquinas", hace Buscar, lee tabla con umbral `diasVehiculos`.
- Toma screenshot JPEG después de cada búsqueda (fullPage).
- Devuelve `{ items: [{ tipo, nombre, columna, fecha, diasFaltantes }], screenshots: [{ buffer, nombre }] }`.
- `diasPersonal` y `diasVehiculos` vienen de `cliente.diasPersonal` / `cliente.diasVehiculos` (defaults 7 y 15 en clientes.js).

### Playwright para renderizado de PDFs
pdfjs + node-canvas falla con imágenes embebidas en Node.js (`"Image or Canvas expected"`).
Solución: Playwright lanza Chromium headless y ejecuta pdfjs v3 desde CDN.
**No cambiar esto** — es un bug de compatibilidad pdfjs v5 / canvas en Node.js.

### 1 sola llamada a AI para todo el matching
Claude/Gemini ve TODAS las refs + TODAS las páginas nuevas en una sola llamada.
**No cambiar a multi-llamada** — el costo sube y no mejora la precisión.
**No agregar chain-of-thought** — empeora las asignaciones.

### matchearPaginasConReqs — lógica de validación y deduplicación (claude.js)

**Validación de grupos por tipo detectado (no por nombre de req):**
El filtro que descarta reqs sin mapeo aprendido usa `tipo_detectado` de `paginas_clasificadas` (lo que la IA detectó visualmente) comparado contra los nombres de mapeos. Antes usaba el nombre del req de CD, lo que fallaba cuando el mapeo tiene un nombre distinto al req en CD (ej: mapeo "F 931" vs req "Planilla de capacitación-2026-4"). La IA recibe instrucción explícita de usar el nombre EXACTO del tipo aprendido en `tipo_detectado`.

**Deduplicación por período:**
Para cada par `(baseNombre × entidad)`, solo se conserva el req con el período más reciente (mayor año, luego mayor número en el sufijo `-YYYY-N`). Los reqs de períodos anteriores van en `grupo.omitidos[]` y no se suben. En `bot.js` se muestran con ⏩ en la confirmación y en el resumen final post-subida.

**Advertencia de período desactualizado:**
Si el req más reciente de un grupo está 2+ meses atrás del mes actual (calculado con `año × 12 + período` para manejar cambios de año), el mensaje de confirmación incluye un aviso ⚠️ con cuántos meses atrás está.

### Panel web con Cloudflare Tunnel
`web.js` levanta un servidor HTTP en el puerto `WEB_PORT` (default 3100). El acceso externo se hace via Cloudflare Tunnel (túnel `controlbun-web`, ID `4994129b-9a21-4e27-ad2e-440455820877`), sin abrir puertos en el router.
- URL pública: `https://mapeos.controldoc.app` (CNAME en zona `controldoc.app`)
- `tunnel.js` arranca cloudflared con el token en `CF_TUNNEL_TOKEN` del `.env`
- Auth primaria: formulario con credenciales de CD → `POST /api/login` → busca en `clientes/*.json` → cookie `session` HttpOnly 7 días
- Auth alternativa: token de un solo uso desde `/web` en Telegram → cookie 7 días
- La sesión web muere si el bot se reinicia → el usuario loguea de nuevo con su contraseña
- La configuración de ingress está en Cloudflare (no en archivo local): `mapeos.controldoc.app → http://localhost:3100`

### Estado de sesión en memoria
Sesiones guardadas en un `Map` en memoria. Si el bot se reinicia, el usuario pierde el estado y debe volver a empezar. Aceptable — los flujos son cortos.

### Fases de sesión en bot.js

| Fase | Descripción |
|---|---|
| `aprender_esperando_pdf` | Esperando PDF de referencia |
| `aprender_agrupando` | Usuario agrupa páginas por número |
| `aprender_asignando` | Usuario elige requerimiento para el grupo actual |
| `aprender_confirmando_overwrite` | Conflicto: el req ya tiene mapeo, esperando sí/no/otro |
| `aprender_overwrite_nuevo_pdf` | Esperando PDF alternativo para ese req |
| `aprender_overwrite_nuevo_paginas` | Eligiendo páginas del PDF alternativo |
| `aprender_preguntando_mas` | Mapeo guardado, preguntando si mapear otro |
| `mapeos_lista` | Viendo lista de mapeos, esperando número |
| `mapeos_viendo` | Viendo un mapeo, esperando acción (reemplazar/eliminar/cancelar) |
| `mapeos_confirmando_eliminar` | Confirmando eliminación |
| `mapeos_reemplazando_pdf` | Esperando nuevo PDF de referencia |
| `mapeos_reemplazando_paginas` | Eligiendo páginas del nuevo PDF |
| `unico_esperando_pdf` | Esperando PDF para subida directa |
| `unico_buscando_req` | Eligiendo requerimiento destino |
| `unico_confirmando` | Confirmando subida directa |
| `config_esperando_user` | Esperando email de CD |
| `config_esperando_pass` | Esperando contraseña de CD |
| `trabajar_confirmando` | Confirmando subida con IA |

## AI Provider

`claude.js` soporta tres providers, controlados por `AI_PROVIDER` en `.env` (o sobreescrito por `runtime.json`):

| Valor | Descripción |
|---|---|
| `claude` | Producción — Anthropic API, modelo `claude-haiku-4-5-20251001` |
| `gemini` | Desarrollo/producción — Google AI Studio. Modelo: `gemini-2.5-flash` |
| `ollama` | Local — requiere GPU dedicada; APU Ryzen 7 5700G es demasiado lento |

Variables en `.env`:
```
TG_TOKEN=...
ANTHROPIC_API_KEY=...
ADMIN_CHAT_ID=...
AI_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash

# Panel web
CF_TUNNEL_TOKEN=...   # token del túnel controlbun-web en Cloudflare
WEB_PORT=3100
WEB_URL=https://mapeos.controldoc.app
```

> La key de Gemini debe crearse desde **aistudio.google.com/apikey** (no desde Google Cloud Console — esas keys tienen cuotas en 0).

## Estado actual

| Módulo | Estado |
|---|---|
| Renderizado PDF (Playwright + pdfjs CDN) | ✅ Funcionando |
| Corte de PDFs (pdf-lib) | ✅ Implementado |
| Flujo /config (credenciales CD) | ✅ Completo y probado |
| Flujo /aprender mejorado | ✅ Con detección de conflictos, auto-skip 1 pág, sugerencia continuar |
| Flujo /unico (subida directa sin IA) | ✅ Implementado |
| Flujo /mapeos (gestión de mapeos) | ✅ Implementado |
| Comando /modelo (switch AI en runtime) | ✅ Implementado |
| Flujo /pendientes (listar reqs pendientes) | ✅ Implementado |
| Flujo /vencimientos (próximos vencimientos + screenshots) | ✅ Implementado |
| Flujo /partemes (parte mensual manual) | ✅ Implementado |
| Cron parte mensual (día 1 de cada mes, 08:00, todos los clientes) | ✅ Implementado |
| Cron vencimientos diario (13:00, notifica solo si hay items) | ✅ Implementado (cambiar a 08:00 al migrar a VPS) |
| cd.js: login (con caché de sesión 25 min) | ✅ Funcionando |
| cd.js: leer tipos de reqs (dropdown completo) | ✅ Funcionando |
| cd.js: leer reqs con entidades (para /trabajar) | ✅ Funcionando |
| cd.js: subir archivo (adjuntar + continuar + enviar) | ✅ Probado y funcionando |
| claude.js: multi-provider (Claude/Gemini/Ollama) | ✅ Switcheable en runtime |
| claude.js: matchearPaginasConReqs | ✅ Validación por tipo_detectado, dedup por período |
| Flujo Trabajar en bot.js | ✅ Con omitidos por período y aviso de reqs desactualizados |
| Panel web (`/web`) con Cloudflare Tunnel | ✅ Funcionando en `mapeos.controldoc.app` |
| Texto estable en mapeos (al aprender) | ⏳ Pendiente |
| Prueba end-to-end completa con clientes reales | ⏳ Pendiente |

## Flujo de subida a CD (cdSubirArchivo)

El flujo real de CD tiene 5 pasos que Playwright ejecuta en orden:

1. **Navegar al req** — dos modos según el href extraído de la bandeja (ver más abajo)
2. **Click "Adjuntar archivo"** — en el frame `BandejaDetalle`
3. **Asignar PDF** — `setInputFiles` en `input[type=file]` de `BandejaUpload`
4. **Esperar "Archivo cargado con exito"** — confirma que el servidor recibió el archivo, luego click "Continuar"
5. **Click "Enviar"** — via `__doPostBack('btnEnviar','')` directo en el frame `BandejaDetalle` (el botón tiene `onclick` con `ControlaEnviar()` que valida el archivo antes de postback)

> El botón Enviar es `<input type="submit" id="btnEnviar">`. Se llama `__doPostBack` directamente para evitar race conditions con `ControlaEnviar()`.

## Navegación a un requerimiento (dos modos)

CD usa dos patrones distintos para links de reqs en la bandeja:

| Tipo | Señal | Cómo navegar |
|---|---|---|
| **URL directa** | href tiene `noCache=` | `page.goto(href)` normal |
| **fnDetalle** | `onclick="fnDetalle(ID);"` sin `noCache` | Ir a `Bandeja.aspx` primero, luego `page.evaluate((id) => fnDetalle(id), ID)` |

`BandejaDetalle.aspx` **NO se puede navegar directamente** (devuelve HTTP 500). Solo funciona cargada como iframe dentro de `Bandeja.aspx`. Por eso los links `fnDetalle` necesitan pasar por la bandeja primero.

`cdLeerRequerimientos` extrae el `origen=ID` del `onclick` y arma una URL `BandejaDetalle.aspx?origen=ID` (sin `noCache`). `cdSubirArchivo` y `_navegarAReq` detectan el tipo por ausencia de `noCache=` y usan `fnDetalle` en ese caso.

`_navegarAReq` (fallback) re-lee la bandeja fresca antes de navegar — garantiza hrefs actuales si las sesiones de CD renuevan los tokens.

## Botón Buscar en la bandeja

CD tiene un retraso antes de que el botón "Buscar" esté listo. `_clickBuscarYEsperar` reintenta:
1. Click en Buscar → espera 3s
2. Verifica filas reales (≥4 `td` + link) — si no hay, espera 3s más y reintenta

## Lo que NO hacer

- No usar `pdfjs-dist` + `canvas` en Node.js — usa siempre Playwright para renderizar
- No agregar chain-of-thought al prompt de Claude/Gemini para matching
- No cambiar el flujo de 1 sola llamada a AI por matching
- No commitear `.env`, `mapeos/`, `clientes/`, `pendientes.json`, `runtime.json` — datos sensibles
- No commitear `public/` si tiene datos de usuarios (actualmente solo tiene el HTML estático, está bien commitearlo)
- No guardar las credenciales de CD en texto plano en otro lado que no sea el JSON del cliente
- No crear key de Gemini desde Google Cloud Console — usar aistudio.google.com
- **No navegar directamente a `BandejaDetalle.aspx` con `page.goto`** si el href no tiene `noCache=` — CD devuelve HTTP 500. Siempre pasar por `Bandeja.aspx` + `fnDetalle(ID)`
- No intentar hacer click en las filas de la bandeja para navegar — `__doPostBack` de ASP.NET falla con índices desfasados tras subidas anteriores

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
