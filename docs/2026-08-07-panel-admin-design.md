# Panel Admin de controlbun — diseño

Fecha: 2026-08-07. Decidido con Diego.

## Contexto

Coreo (WhatsApp) y controlbun venían administrándose a mano editando JSONs por
SSH, más comandos de Telegram (`/nuevocliente`, `/prorrogar`). Se decidió sacar
a Telegram del rol administrativo y de canal de clientes por completo — el bot
de Telegram queda solo como canal de **alertas push** (avisos de trial por
vencer, `[EQUIPO:...]` de Coreo). Todo lo demás (clientes, altas) pasa a ser
WhatsApp + un panel web nuevo.

No hay clientes reales en Telegram salvo Fernando (`fernando-vidal.json`, que
además de admin es cliente real con mapeos propios) — el resto de fichas
(`javier`, `jorge-silveira`, `praia`, `diego-bertosi`) son de prueba y se
limpian con backup antes de esto.

## Quién entra

Solo 2 cuentas fijas: Diego y Fernando. No hace falta soportar altas de admins
nuevos sin tocar código.

## Arquitectura

Se extiende el server HTTP que ya corre `web.js` (proceso PM2 `controlbun`,
mismo dominio `mapeos.controldoc.app`, mismo túnel de Cloudflare). Nuevo módulo
`admin.js` que exporta un handler montado por el router existente bajo
`/admin` y `/admin/api/*`.

**No se usa Express ni ningún framework nuevo** — se sigue el patrón `http`
nativo + router a mano que ya usa `web.js`.

### Auth

- 2 cuentas fijas: usuario + hash bcrypt en `.env` (`ADMIN_CREDENTIALS`, JSON
  `[{ "user": "...", "passHash": "..." }, ...]`).
- `POST /admin/api/login` — valida con bcrypt, crea sesión.
- Cookie de sesión propia (`admin_session`), separada de la cookie `session`
  de clientes — mismo mecanismo (`crypto.randomBytes` + `Map` en memoria,
  `HttpOnly`, `SameSite=Lax`).
- Reusa el rate-limiter de intentos fallidos ya existente en `web.js`
  (`checkLoginRateLimit`), con su propio `Map` para no mezclar con el de
  clientes.
- Sesiones en memoria: un restart de PM2 desloguea. Aceptable — mismo
  trade-off que ya tienen las sesiones de clientes hoy.

### Fuente de datos (dos archivos, cruzados)

- `/opt/controlbun/clientes/<userId>.json` — identidad, `waPhone`,
  `trialUntil`, `cdUser` (solo se chequea si existe, nunca se muestra el
  valor ni `cdPass`).
- `/opt/cazador/config-state/capacidades.json` — `{ "<phone>": { nombre,
  sistemas: [...] } }`.

Como `/opt/controlbun` y `/opt/cazador` son del mismo usuario del sistema
(`claude`), el panel lee/escribe ambos por filesystem directo, sin API
intermedia.

## Features

### Listado (`GET /admin/api/clientes`)

Cruza ambos archivos por `waPhone`/número. Por cada cliente devuelve: nombre,
userId, waPhone, sistemas habilitados, estado de trial (`permanente` /
`vence en Nd` / `vencido`), `cdConfigurado: boolean`. Si un número aparece en
un archivo y no en el otro, se marca `inconsistente: true` para que se note en
la UI.

### Alta (`POST /admin/api/clientes`)

Body: `{ nombre, waPhone, sistemas: [...], trialUntil: string|null }`.

1. Valida que `waPhone` no esté ya usado por otro cliente.
2. Genera `userId` reusando `slugify` + `slugDisponible` de `clientes.js`
   (evita colisiones).
3. Escribe `clientes/<userId>.json` (vía `crearClienteWA`, seteando
   `trialUntil` si vino).
4. Escribe la entrada en `capacidades.json` con los `sistemas` elegidos.

No es transaccional entre los dos archivos (dos filesystems, aunque mismo
disco). Si el paso 4 falla después del 3, la respuesta indica explícitamente
qué quedó a medias en vez de devolver un genérico "error".

### Editar (`PATCH /admin/api/clientes/:userId`)

Permite cambiar `nombre`, `sistemas` (capacidades.json) y `trialUntil`
(`null` = permanente). Mismo patrón de escritura en dos pasos con aviso de
inconsistencia si uno falla.

### Baja (`DELETE /admin/api/clientes/:userId`)

Soft-delete, mismo patrón que ya se usó a mano con "die":
`clientes/<userId>.json` → `clientes/.deleted/<userId>.json.bak-<timestamp>`.
Se saca la entrada correspondiente de `capacidades.json`. Nada se borra en
seco — reactivar a mano es posible restaurando el archivo.

### Fuera de alcance (a propósito)

- Ver o editar `cdUser`/`cdPass` — 100% self-service del cliente por
  WhatsApp ("Configurar cuenta ⚙️"). El panel solo muestra sí/no.
- Alertas push (trial por vencer, `[EQUIPO]`) — siguen por Telegram, sin
  cambios. El panel no las gestiona ni las duplica.
- Altas/roles de admin nuevos — 2 cuentas fijas, hardcodeadas.

## Manejo de errores

- `waPhone` duplicado → 409 con el nombre del cliente que ya lo tiene.
- `userId` colisión → resuelto solo (slug con sufijo numérico), no debería
  llegar a error.
- `capacidades.json` corrupto/no parseable → 500 explícito, no se sobreescribe
  a ciegas (evita perder el resto de los clientes).
- Escritura parcial (paso 3 OK, paso 4 falla) → respuesta 207-like con detalle
  de qué archivo quedó desincronizado, para reintentar solo esa parte.

## Testing

`node --test` sobre las funciones puras de `admin.js` (validación de alta,
cruce de listado, soft-delete), mismo patrón que `test/clientes.test.js`:
`CLIENTES_DIR` y `CAPACIDADES_PATH` apuntando a un tmpdir vía env vars.

## Trabajo relacionado, NO parte de este proyecto

Después de tener el panel andando:
1. Limpiar clientes de prueba (`javier`, `jorge-silveira`, `praia`,
   `diego-bertosi`) con backup previo — dejar solo `fernando-vidal`.
2. Apagar el bot de Telegram de controlbun salvo lo mínimo necesario para
   seguir mandando las alertas push (trial, `[EQUIPO]`).
