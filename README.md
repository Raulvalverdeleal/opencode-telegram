# OpenCode Server + Telegram

MVP con una sesion por chat de Telegram usando OpenCode Server.

## Requisitos

- Node.js 20+
- OpenCode instalado y configurado
- Token de bot de Telegram

## Configuracion

1. Copia `.env.example` a `.env`
2. Rellena `TELEGRAM_BOT_TOKEN` y `OPENCODE_SERVER_PASSWORD`

### Control de acceso por fingerprint (secure by default)

- El bot usa `TELEGRAM_ALLOWED_FINGERPRINTS` para autorizar llamadas.
- Fingerprint usado: `chat_id:user_id`.
- Si `TELEGRAM_ALLOWED_FINGERPRINTS` esta vacio, el bot deniega todo.
- Si el primer valor es `*`, entra en modo discovery y responde con tu fingerprint para copiarlo al `.env`.

Ejemplos:

```bash
TELEGRAM_ALLOWED_FINGERPRINTS=*
```

Luego, cambia a allowlist estricto:

```bash
TELEGRAM_ALLOWED_FINGERPRINTS=-1001234567890:99887766,-1001234567890:11223344
```

## Arranque

En terminal 1, inicia OpenCode server con las credenciales de `.env`:

```bash
npm run start:opencode
```

En terminal 2:

```bash
npm install
npm run start:telegram
```

Tambien puedes pasar flags extra al server:

```bash
npm run start:opencode -- --cors http://localhost:5173
```

## Comandos

- `/start`: crea o recupera la sesion del chat
- `/new <nombre_opcional>`: crea una sesion nueva para ese chat
- `/rename <nombre>`: renombra la sesion activa del chat
- `/stop`: interrumpe la ejecucion actual del agente para ese chat
- `/verbose`: alterna trazas de progreso (ON/OFF)
- `/verbose 1`: activa trazas de progreso
- `/verbose 0`: desactiva trazas de progreso
- `/status`: muestra sesion activa, nombre, directorio y estado verbose
- `/sessions <filtro_opcional>`: lista sesiones y permite filtrar por nombre
- `/switch <session_id>`: cambia la sesion activa del chat
- `/<session_id>` (por ejemplo `/ses_abc123`): cambia la sesion activa con acceso directo
- `/restart`: reinicia solo el bot de Telegram y al volver envia `/status` en ese chat
- `/fingerprint`: muestra tu fingerprint actual (`chat_id:user_id`)

## Progreso en tiempo real

- El bot usa SSE como canal principal para progreso (`sse-first`).
- Con `verbose` en ON, envia trazas durante la ejecucion (estado de sesion, tools y pasos).
- Las trazas de tools incluyen contexto util (por ejemplo comando `bash`, ruta de `read`, patron de `glob`, resumen de `apply_patch`).
- `/stop` aborta la ejecucion activa de la sesion del chat.

## Atajos de sesiones

- El listado de `/sessions` muestra cada sesion como:
  - titulo de sesion
  - `/<session_id>`
- En Telegram, al pulsar ese comando se envia solo el comando, por eso el bot acepta `/<session_id>` como alias directo de `/switch <session_id>`.

## Notas

- Cada `chat_id` mantiene su propia `session_id`
- El mapeo se guarda en `chat-sessions.json` con historial por chat
- `verbose` se guarda por chat en `chat-sessions.json` (por defecto ON)
- Para fijar modelo por defecto puedes usar `DEFAULT_PROVIDER_ID` y `DEFAULT_MODEL_ID`

## Scripts PM2 utiles

- `npm run pm2:restart:telegram`: reinicia solo el bot de Telegram
- `npm run pm2:restart:opencode`: reinicia solo OpenCode server
- `npm run pm2:restart`: reinicia ambos procesos
