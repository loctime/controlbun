# ControlBun — Documentación del sistema

## ¿Qué es ControlBun?

ControlBun es un bot de Telegram que automatiza la gestión de documentación en [controldocumentario.com](https://controldocumentario.com) (CD).

CD es la plataforma que usan las empresas constructoras para gestionar la documentación de sus contratistas: certificados, seguros, recibos de sueldo, vencimientos, etc. El problema es que CD es **complejo y tedioso de usar**: hay que entrar al sitio, navegar entre requerimientos, adjuntar cada PDF manualmente uno por uno, grabar partes mensuales en un formulario engorroso, y revisar vencimientos en tablas difíciles de leer.

**ControlBun resuelve todo eso desde Telegram:**

- Mandás un PDF → el bot lo analiza con IA, lo divide automáticamente y sube cada sección al requerimiento correcto en CD.
- Revisás vencimientos en segundos, recibís alertas automáticas todos los días.
- El parte mensual se graba solo el día 1 de cada mes, sin que tengas que hacer nada.
- Todo desde el celular, en segundos.

---

## Primeros pasos

### 1. Registrarte

Cuando escribís al bot por primera vez, te pide una contraseña de acceso. El administrador te la da de antemano. Ingresala para crear tu cuenta.

### 2. Configurar tus credenciales de CD

Usá `/config` para vincular tu cuenta de controldocumentario.com. El bot te pedirá:
- Tu **usuario de CD** (email)
- Tu **contraseña de CD**

Antes de guardar, el bot prueba el login en CD para verificar que las credenciales sean correctas.

### 3. Enseñarle los documentos

Antes de poder subir PDFs automáticamente, el bot necesita saber qué tipo de documento es cada uno. Esto se hace una sola vez con `/aprender`.

---

## Comandos

### `/config` — Configurar credenciales

Vinculá tu usuario y contraseña de controldocumentario.com. El bot verifica el login antes de guardar. Si las credenciales cambian, volvé a usar este comando.

---

### `/aprender` — Enseñar tipos de documentos

Este es el paso inicial que permite al bot reconocer tus PDFs en el futuro.

**¿Cómo funciona?**

1. Escribís `/aprender` → el bot se conecta a CD y carga los tipos de requerimientos de tu cuenta.
2. Mandás un PDF de ejemplo (una muestra del tipo de documento que querés mapear).
3. El bot muestra cada página como imagen.
4. Si el PDF tiene múltiples páginas, elegís cuáles corresponden a un mismo tipo de documento (ej: "páginas 1 y 2 son el recibo de haberes").
5. Escribís el nombre del requerimiento al que corresponde (o parte del nombre para buscar).
6. Guardás el mapeo.

Podés seguir mapeando más tipos de documentos en la misma sesión. Cuando terminás, escribís `/listo` o "no".

**Manejo de conflictos:** Si ya tenés un ejemplo guardado para ese tipo de documento, el bot te muestra el ejemplo actual y te pregunta si querés reemplazarlo, elegir otro requerimiento, o subir un PDF diferente como referencia.

---

### Mandar un PDF — Subida automática con IA

El flujo principal: mandás un PDF directamente al chat (sin ningún comando previo).

**¿Qué hace el bot?**

1. **Renderiza** el PDF — convierte cada página en imagen.
2. **Lee tus mapeos** — carga todos los tipos de documentos que aprendiste.
3. **Lee los requerimientos pendientes** de tu cuenta en CD.
4. **Clasifica con IA** — un modelo de lenguaje visual analiza cada página y la asigna al requerimiento pendiente que corresponde, usando tus mapeos como referencia visual.
5. **Muestra el resumen** con qué páginas van a qué requerimiento, y pide confirmación.
6. **Sube** — corta el PDF por grupos y sube cada sección al requerimiento correcto en CD.

**Casos que maneja automáticamente:**
- **Múltiples entidades en un mismo PDF** (ej: recibos de sueldo de varios empleados): el bot agrupa por entidad y sube por separado.
- **Períodos anteriores**: si hay requerimientos del mismo tipo de meses anteriores, los omite y solo sube el más reciente.
- **Requeridos faltantes**: si el bot identifica un documento pero no hay requerido pendiente en CD para ese tipo, ofrece generarlo automáticamente.

**Aviso de reqs desactualizados:** Si el requerimiento más reciente de un tipo está 2 o más meses atrás del mes actual, el bot te avisa ⚠️ para que lo tengas en cuenta.

---

### `/pendientes` — Ver requerimientos pendientes

Muestra la lista completa de requerimientos pendientes en tu cuenta de CD, con el nombre del recurso (empleado, vehículo, etc.).

Útil para saber qué documentación falta entregar antes de subir PDFs.

---

### `/vencimientos` — Ver vencimientos próximos

Consulta la pantalla de vencimientos en CD y devuelve un resumen con:
- **General (proveedor)**: documentos de la empresa con vencimiento próximo.
- **Personal**: documentos de empleados (carnet de conducir, ART, etc.).
- **Vehículos**: VTV, seguro, etc.

Cada ítem muestra la fecha, cuántos días faltan, y un semáforo de colores:
- 🔴 Vencido
- 🟠 Vence hoy o en 1-3 días
- 🟡 Vence en 4+ días

Además de la lista de texto, envía capturas de pantalla de la pantalla de CD para verificación visual.

Los umbrales de días se configuran por cliente (`diasPersonal`, `diasVehiculos`).

---

### `/partemes` — Grabar parte mensual

Graba el parte mensual en CD: registra la asistencia de personal y máquinas para el mes en curso.

En CD esto implica navegar el formulario de partes, seleccionar el período, marcar cada fila y confirmar — lo que manualmente tomaría varios minutos. El bot lo hace automáticamente en segundos e informa cuántos empleados y vehículos se actualizaron.

---

### `/unico` — Subir un PDF directo (sin IA)

Para cuando querés subir un PDF a un requerimiento específico sin que la IA lo clasifique. Útil para documentos ocasionales o casos que el bot no reconoce automáticamente.

**Flujo:**
1. `/unico` → mandás el PDF.
2. El bot carga los requerimientos pendientes en CD.
3. Filtrás por nombre o elegís por número.
4. Confirmás → el bot sube el PDF completo al requerimiento elegido.

---

### `/mapeos` — Gestionar mapeos guardados

Muestra todos los tipos de documentos aprendidos con el número de páginas de referencia.

Para cada mapeo podés:
- **Ver** la imagen de referencia guardada.
- **Reemplazar** con un nuevo PDF de referencia (si el formato del documento cambió).
- **Eliminar** el mapeo.

---

### `/web` — Panel de mapeos en la web

Genera un link de acceso al panel web en `https://mapeos.controldoc.app`. El link es de un solo uso y expira en 10 minutos.

El panel web permite ver todos los mapeos, hacer zoom en las imágenes de referencia, reemplazar o eliminar mapeos desde la computadora.

También podés acceder al panel directamente con tu usuario y contraseña de CD (sin necesitar el link de Telegram).

---

### `/estado` — Ver tu cuenta

Muestra tu nombre, si tenés credenciales de CD configuradas, y cuántos tipos de documentos tenés mapeados.

---

## Automatizaciones

El bot ejecuta dos tareas automáticas sin que tengas que hacer nada:

### Parte mensual automático
**Cuándo:** Día 1 de cada mes a las 08:00.
**Qué hace:** Graba el parte mensual en CD para todos los clientes con credenciales configuradas. Te notifica por Telegram con el resultado.

### Alertas de vencimientos
**Cuándo:** Todos los días a las 13:00.
**Qué hace:** Consulta los vencimientos en CD. Si hay algún documento próximo a vencer, te manda una alerta. Si todo está en orden, no te molesta.

---

## Panel web (`mapeos.controldoc.app`)

Interfaz web para gestionar tus mapeos desde la computadora.

**Acceso:**
- Desde Telegram: `/web` → click en el link generado.
- Directo: entrá a `https://mapeos.controldoc.app` e ingresá con tu usuario y contraseña de controldocumentario.com.

**Funcionalidades:**
- Ver todas las imágenes de referencia de tus mapeos en un grid de cards.
- Zoom con click en cualquier imagen (lightbox).
- Reemplazar la referencia de un mapeo subiendo un nuevo PDF y eligiendo las páginas.
- Eliminar un mapeo con confirmación.

---

## Comandos de administrador

Solo disponibles para el administrador del sistema.

### `/nuevocliente NombreApellido CODIGO`
Registra un nuevo cliente generando un código de acceso de un solo uso. El cliente escribe ese código en el chat del bot para registrarse.

### `/modelo [claude|gemini]`
Ver o cambiar el modelo de IA que usa el bot para clasificar documentos.
- **Claude Haiku** — más robusto para JSON estructurado (producción).
- **Gemini 2.5 Flash** — gratuito, ventana de 1M tokens (desarrollo).

El cambio es inmediato, sin reiniciar el bot.

---

## ¿Cómo funciona la IA?

Cuando mandás un PDF, el bot hace **una sola llamada** al modelo de IA (Claude o Gemini) con:
- Las imágenes de referencia de todos tus mapeos aprendidos.
- Las imágenes de todas las páginas del PDF nuevo.
- Los requerimientos pendientes en CD.

La IA devuelve la asignación de cada página al requerimiento correspondiente. Una sola llamada para todo el documento, sea de 5 o 50 páginas.

---

## CD antes vs. con ControlBun

| Tarea | Sin ControlBun | Con ControlBun |
|---|---|---|
| Subir un paquete de PDFs | Navegar manualmente por cada requerimiento, adjuntar uno por uno | Mandás el PDF al chat → confirmás → listo |
| Detectar qué va a qué requerimiento | Mirás cada página y buscás manualmente | IA automática |
| Cortar un PDF con múltiples documentos | Necesitás herramienta externa + subir cada parte por separado | Automático |
| Grabar parte mensual | Navegar el formulario de CD, marcar cada fila | `/partemes` o automático el día 1 |
| Ver vencimientos próximos | Entrar a CD, navegar a Vencimientos, leer las tablas | `/vencimientos` o alerta automática diaria |
| Ver requerimientos pendientes | Entrar a CD | `/pendientes` |
| Generar un requerido faltante | Buscar el tipo en el modal de CD, seleccionarlo, confirmar | Automático post-subida |
