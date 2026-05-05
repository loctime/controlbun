# ControlBun

Bot de Telegram que automatiza la subida de documentos PDF a [controldocumentario.com](https://controldocumentario.com). Usa Claude para identificar y asignar documentos, y Playwright para automatizar el navegador.

## Cómo funciona

1. **Aprender**: el usuario manda un PDF de referencia, agrupa las páginas por tipo de documento y las asigna a los requerimientos de su cuenta en CD. El bot guarda ese mapeo.
2. **Trabajar**: el usuario manda el PDF del mes. El bot lo matchea contra el mapeo con Claude, lo divide por secciones y lo sube automáticamente a CD.

## Instalación

```bash
npm install
npx playwright install chromium
```

Crear `.env`:
```
TG_TOKEN=tu_token_de_telegram
ANTHROPIC_API_KEY=sk-ant-...
ADMIN_CHAT_ID=tu_chat_id
```

## Uso

```bash
node bot.js
```

## Comandos disponibles

| Comando | Descripción |
|---|---|
| `/config` | Configurar credenciales de controldocumentario.com |
| `/aprender` | Mapear un PDF de referencia a los requerimientos de CD |
| `/listo` | Finalizar el mapeo en curso |
| `/miid` | Ver tu chat ID |
| `/nuevocliente` | (Admin) Registrar un nuevo usuario |

## Estructura del proyecto

```
controlBun/
├── bot.js          # Bot principal, flujos de conversación
├── pdf.js          # Renderizado y corte de PDFs
├── claude.js       # Matching con Claude AI
├── cd.js           # Automatización de controldocumentario.com
├── mapeos.js       # Almacenamiento de mapeos por usuario
├── clientes.js     # Gestión de clientes
├── mapeos/         # Mapeos por usuario (gitignored)
└── clientes/       # Datos de clientes (gitignored)
```

## Tecnologías

- [grammY](https://grammy.dev/) — bot de Telegram
- [Playwright](https://playwright.dev/) — automatización de navegador y renderizado de PDFs
- [Claude AI](https://anthropic.com) — matching visual de documentos
- [pdf-lib](https://pdf-lib.js.org/) — corte de PDFs
