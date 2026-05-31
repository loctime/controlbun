# ControlBun — Estado del proyecto (para Claude)

> **Estado al 2026-05-31:**
> - Comando `/bunn` y trigger automático de PDF: PAUSADOS (devuelven mensaje informativo que deriva a `/unico`). El handler delegado original quedó comentado en `bot.js` para reactivación rápida. Se prevé reactivar próximamente.
> - Las 4 fases `trabajar_*` y los 3 helpers `_mostrarGenerables`, `_procesarSiguienteGenerable`, `_generarItem` fueron eliminados (~292 líneas). Eran el matching con IA pre-Bunn (`claude.js` / `matchearPaginasConReqs`). No vuelven — reemplazados definitivamente por Bunn.
> - `/aprender` y `/mapeos` siguen activos como comandos pero su output (mapeos guardados) queda huérfano hasta que se reactive Bunn.
> - Túnel cloudflared cambiado de QUIC a HTTP/2 (2026-05-31) para reducir ruido en logs.
> - Comando `/generar` agregado al menú visible al cliente.

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
| `/config` | todos | Configurar credenciales de CD + detecta nombre de empresa automáticamente |
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
  "diasVehiculos": 15,
  "nombreEmpresa": "MATESIN CLAUDIO FABIAN"
}
```

`nombreEmpresa` se detecta automáticamente al hacer `/config` leyendo la primera columna del área de trabajo de CD (`cdDetectarNombreEmpresa`). Si la detección falla, el bot pregunta al usuario. Se usa en el prompt de IA para que no confunda el nombre del dueño con empleados, y para que priorice la patente como entidad en documentos de vehículos.

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
  "tipo": "personal",
  "guardadoEn": 1234567890
}
```

Un mapeo por tipo de requerimiento. El nombre del archivo es el nombre del requerimiento (incluyendo sufijo de período `-2026-4`). `baseNombreReq()` en bot.js quita ese sufijo para comparar tipos entre períodos.

El campo `tipo` ("empresa" | "personal" | "maquinas") es opcional. Se guarda la primera vez que se necesita generar el requerido — ya sea scrapeado automáticamente del modal de CD o elegido por el usuario. A partir de ahí se reutiliza sin preguntar.

El campo `guardadoEn` (timestamp Unix ms) se usa como cache-buster en las URLs de imágenes del panel web (`?v=${guardadoEn}`), para evitar que el browser muestre imágenes viejas después de eliminar y recrear un mapeo.

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

### /config — Configurar credenciales
1. Pide email de CD
2. Pide contraseña
3. Prueba el login; si falla, avisa y termina
4. Guarda credenciales
5. Intenta auto-detectar nombre de empresa (`cdDetectarNombreEmpresa`) leyendo la primera columna del área de trabajo en Bandeja.aspx
   - Si detecta → guarda en `nombreEmpresa` y muestra al usuario para confirmar/corregir
   - Si no detecta → pregunta al usuario (`config_esperando_empresa`); puede escribir el nombre o `omitir`

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
- Las imágenes usan `?v=${guardadoEn}` para evitar cache del browser tras eliminar/recrear mapeos

### /modelo — Cambiar AI (admin)
- `/modelo` → muestra provider activo
- `/modelo claude` o `/modelo haiku` → cambia a Claude Haiku
- `/modelo gemini` → cambia a Gemini 2.5 Flash
- Cambio inmediato sin reiniciar. Persiste en `runtime.json`.

### ~~Trabajar — Subir PDF con IA~~ [ELIMINADO 2026-05-31]
Flujo eliminado. Era la subida automática vía matching con IA (Codex/Gemini). Reemplazado definitivamente por Bunn (modo delegado con visión nativa). El código de las 4 fases `trabajar_*` y los helpers `_procesarSiguienteGenerable`/`_generarItem`/`_mostrarGenerables` se borró de bot.js. El comando `claude.js`/`matchearPaginasConReqs` ya no se importa.

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

### Generación de requeridos faltantes (flujo post-subida)

Cuando el sistema identifica un documento (matchea un mapeo aprendido) pero no hay requerido pendiente en CD para ese tipo, el resultado va al bucket `sinRequerido` en vez de `sinAsignar`.

**Flujo:**
1. `matchearPaginasConReqs` retorna `{ grupos, sinAsignar, sinRequerido, paginasClasificadas }`
2. Después del upload normal, si hay items en `sinRequerido` → muestra lista y pregunta si generar
3. Para cada item a generar:
   a. Busca `tipo` guardado en el mapeo JSON
   b. Si no lo tiene → `cdScrapearTipoRequerimiento` abre el modal de CD e itera empresa/personal/maquinas para encontrar en qué categoría aparece el requerido (matching exacto por nombre)
   c. Si lo encuentra → guarda `tipo` en mapeo + genera; si no → pregunta al usuario (opciones 1/2/3)
4. `cdGenerarRequerimiento` automatiza el modal: selecciona tipo → selecciona requerido (matching exacto) → maneja sector (si aplica) → "Todos" → Generar
5. Re-lee bandeja para encontrar el req recién creado:
   - Primero busca por tipo + entidad (normalizada)
   - Si no encuentra, busca por tipo solo (cubre caso patente vs nombre de persona)
   - Si no aparece en el primer intento, espera 5s y reintenta
   - Si hay múltiples reqs del mismo tipo (ej: UMM906 y HTC822), sube el PDF a todos
6. Pasa al siguiente item o termina

**Dropdown de sectores (sobres empresa):**
Algunos sobres de tipo empresa muestran un dropdown "Sectores" que es obligatorio.
`cdGenerarRequerimiento` lo detecta después del wait post-`cmbSobre`:
- **1 opción**: auto-selecciona silenciosamente
- **Múltiples opciones sin `sector`**: lanza error con `err.sectores = [{value, text}]`; bot.js pregunta al usuario y reintenta con el valor elegido
- **`sector` provisto**: busca y selecciona la opción que coincide

**Matching exacto en generación:**
`cdScrapearTipoRequerimiento` y `cdGenerarRequerimiento` usan matching exacto (normalizado) para el nombre del requerido en `#cmbSobre`. No hay fuzzy fallback. Si no hay exacto → error claro. Los nombres de reqs vienen de la lista propia de CD, por lo que SIEMPRE debe existir match exacto.

**Funciones:**
- `cdScrapearTipoRequerimiento(page, nombreRequerido)` en cd.js — descubrimiento de tipo (exacto)
- `cdGenerarRequerimiento(page, tipo, nombreRequerido, sector = null)` en cd.js — automatización del modal
- `cdDetectarNombreEmpresa(page)` en cd.js — lee primera columna del área de trabajo de Bandeja.aspx
- `guardarTipoMapeo(chatId, nombreBase, tipo)` en mapeos.js — persiste el tipo en el JSON
- `leerTipoMapeo(chatId, nombreBase)` en mapeos.js — lee tipo guardado
- `_mostrarGenerables`, `_procesarSiguienteGenerable`, `_generarItem` en bot.js — orquestación

### matchearPaginasConReqs — lógica de validación y deduplicación (claude.js)

`matchearPaginasConReqs(nuevasPaginas, mapeos, reqsPendientes, nombreEmpresa = "")` — el cuarto parámetro se pasa desde bot.js con `cliente.nombreEmpresa`.

**Validación de grupos por tipo detectado (no por nombre de req):**
El filtro usa `tipo_detectado` de `paginas_clasificadas` comparado contra nombres de mapeos. La IA usa el nombre EXACTO del tipo aprendido en `tipo_detectado`.

**Filtros de reqs asignados por la IA (paso 3 del loop):**
Después de que la IA asigna índices de reqs a cada grupo, se aplican dos filtros antes de aceptarlos:
1. **Entidad**: el req debe tener la misma entidad que el grupo (o sin entidad). Previene que la IA asigne req de HTC822 a un grupo de UMM906.
2. **Nombre**: `baseNombre(req)` debe empezar con `tipoBase` o viceversa. Previene que "Pago del seguro técnico" se asigne a un grupo cuyo tipo es "Seguro técnico" — son documentos distintos y ninguno empieza con el otro. Permite variantes legítimas como "Recibos de haberes ram" para tipo "Recibos de haberes".

Si después de estos filtros `reqs.length === 0` → el grupo va a `sinRequerido` (generable).

**Rescue de sinRequerido por entity mismatch:**
Al final del procesamiento, los items en `sinRequerido` que SÍ tienen reqs pendientes por nombre de tipo (pero con entidad diferente, ej: dueño vs patente) se mueven a grupos con todos esos reqs. Esto cubre documentos de vehículos donde el doc muestra el nombre del propietario pero CD usa la patente como entidad.

**Documentos de empresa (sin entidad):**
Páginas en `sinAsignar` con `tipo_detectado` reconocido se reagrupan como docs de empresa. Buscan reqs pendientes por nombre de tipo (sin filtro de entidad). Aplica cuando la IA no detecta patente ni nombre en la página.

**Deduplicación por período:**
Para cada par `(baseNombre × entidad)`, solo se conserva el req con el período más reciente (mayor año, luego mayor número en el sufijo `-YYYY-N`). Los reqs de períodos anteriores van en `grupo.omitidos[]`.

**Advertencia de período desactualizado:**
Si el req más reciente de un grupo está 2+ meses atrás del mes actual, el mensaje de confirmación incluye un aviso ⚠️.

**Prompt con nombre de empresa:**
Si `nombreEmpresa` está configurado, el PASO 1 del prompt incluye: "si este nombre aparece junto a una patente → usá la patente como entidad; si aparece solo → dejá entidad vacía (doc de empresa)". Resuelve la confusión cuando la empresa tiene nombre de persona (ej: "MATESIN CLAUDIO FABIAN").

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
| `config_esperando_empresa` | Esperando nombre de empresa (si auto-detección falló) |
| `generar_buscando` | `/generar`: usuario filtra/elige el tipo de requerimiento a crear |
| `generar_confirmando` | `/generar`: confirmando creación |
| `generar_tipo_manual` | `/generar`: usuario elige categoría (empresa/personal/máquinas) cuando auto-detección falla |
| `generar_sector` | `/generar`: usuario elige sector cuando CD lo pide (dropdown) |

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
| Flujo /config (credenciales + auto-detección nombre empresa) | ✅ Completo y probado |
| Flujo /aprender mejorado | ✅ Con detección de conflictos, auto-skip 1 pág, sugerencia continuar |
| Flujo /unico (subida directa sin IA) | ✅ Implementado |
| Flujo /mapeos (gestión de mapeos) | ✅ Implementado |
| Comando /modelo (switch AI en runtime) | ✅ Implementado |
| Flujo /pendientes (listar reqs pendientes) | ✅ Implementado |
| Flujo /vencimientos (próximos vencimientos + screenshots) | ✅ Implementado |
| Flujo /partemes (parte mensual manual) | ✅ Implementado |
| Cron parte mensual (día 1 de cada mes, 08:00, todos los clientes) | ✅ Implementado |
| Cron vencimientos diario (08:00, notifica solo si hay items) | ✅ Implementado |
| cd.js: login (con caché de sesión 25 min) | ✅ Funcionando |
| cd.js: leer tipos de reqs (dropdown completo) | ✅ Funcionando |
| cd.js: leer reqs con entidades (para /trabajar) | ✅ Funcionando |
| cd.js: subir archivo (adjuntar + continuar + enviar) | ✅ Probado y funcionando |
| cd.js: detectar nombre empresa automáticamente | ✅ Funcionando (primera columna área de trabajo) |
| claude.js: multi-provider (Claude/Gemini/Ollama) | ✅ Switcheable en runtime |
| claude.js: matchearPaginasConReqs | ✅ Filtros de entidad y nombre, rescue entity-mismatch, docs empresa sin entidad, nombre empresa en prompt |
| Flujo Trabajar en bot.js | ✅ Con omitidos por período, aviso de reqs desactualizados, oferta de generación |
| Generación de requeridos faltantes | ✅ Matching exacto en modal + retry post-generación + upload a múltiples entidades (patentes) |
| Panel web (`/web`) con Cloudflare Tunnel | ✅ Funcionando en `mapeos.controldoc.app` con cache-busting de imágenes |
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
- **No usar fuzzy matching en cdScrapearTipoRequerimiento ni cdGenerarRequerimiento** — los nombres vienen de la lista propia de CD, siempre hay match exacto. El fuzzy causaba seleccionar "Pago del seguro automotor" en vez de "Seguro automotor"

## Producción — VPS Contabo

| Campo | Valor |
|---|---|
| IP | 5.189.136.177 |
| Path del proyecto | `/opt/controlbun` |
| Process manager | PM2 (`pm2 status`, `pm2 logs controlbun`) |
| Panel web | https://mapeos.controldoc.app |
| Autostart | pm2-root.service (systemd) |

**Deploy tras un push:**
```bash
cd /opt/controlbun && git pull && pm2 restart controlbun
```

**Carpetas fuera de git** (transferir por SFTP si cambian):
- `clientes/` — JSONs con credenciales de cada cliente
- `mapeos/` — mapeos aprendidos por usuario

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
