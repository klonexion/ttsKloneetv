---
name: gates-de-verificacion
description: Comandos exactos de verificación en este repo (lint por paquete, build del frontend, y test:db, test:oauth, test:eventsub, test:chatters, test:chat-send, test:tts, test:edge-tts, test:piper, test:voice-model, test:chat-command y test:settings del backend) y cómo verificar el backend sin choques de puerto.
metadata:
  type: project
---

Gates vigentes (no hay typecheck: JS puro). Desde la raíz del worktree:

- `npm --prefix backend run lint` y `npm --prefix frontend run lint`
  (ESLint 9 flat config con `--max-warnings=0`: un warning rompe el gate).
- `npm --prefix frontend run build`.
- `npm --prefix backend run test:db` — capa de datos (T-002), 25 comprobaciones.
- `npm --prefix backend run test:oauth` — flujo OAuth (T-003), 16 comprobaciones.
- `npm --prefix backend run test:eventsub` — relay de chat (T-004), 16
  comprobaciones: EventSub → provider → upsert en `users` → `chat:message` por
  `/ws`, las dos reconexiones, la deduplicación por `message_id` y el apagado con
  SIGTERM (ver [[shutdown-backend-cuelga-con-ws]]).
- `npm --prefix backend run test:chatters` — columna de usuarios (T-007), 15
  comprobaciones: Get Chatters paginado → merge con `users` → `users:list` por
  `/ws`, la aparición instantánea de quien escribe, los flags `muted`/`ignored`,
  las entradas y salidas entre polls y el 401 por scope. Usa
  `TWITCH_CHATTERS_POLL_MS` corto (el default de producción son 60 s).
- `npm --prefix backend run test:chat-send` — envío al chat (T-006), 16
  comprobaciones: `POST /api/chat/send` → Helix → eco por EventSub →
  `chat:message` en `/ws`, la validación (vacío, solo espacios, tope de 500), los
  tres modos de fallo de Twitch (permanente, transitorio, `is_sent: false`) y el
  caso sin sesión.
- `npm --prefix backend run test:tts` — núcleo TTS (T-008), 36 comprobaciones:
  interfaz `TTSEngine`, ids de voz namespaced, el registro con su respaldo al
  navegador, los filtros (ignored/muted/`!`/bots/URLs), el pipeline sobre una base
  temporal y la trama `chat:message` enriquecida con `tts` (relay con hub y
  provider falsos, **sin** levantar el backend). Ojo: fija las claves del payload,
  así que quien cambie la trama toca también este gate y `test:eventsub`.
- `npm --prefix backend run test:edge-tts` — motor edge-tts y la capa de audio de
  servidor (T-009), 31 comprobaciones. **Es el único gate que necesita internet**
  (edge-tts es un servicio online): con `SKIP_NETWORK=1` corre solo la parte
  determinista (25/25) y sirve en una máquina sin red. Levanta Express en el
  puerto 0 con motores falsos para las rutas `GET /api/voices` y
  `GET /api/tts/audio/:id`.

- `npm --prefix backend run test:piper` — motor Piper (T-010): **45 comprobaciones
  con Piper instalado y 41 sin él** (el bloque de síntesis real se omite con un aviso
  y el gate pasa igual, porque la degradación limpia es criterio de aceptación;
  `SKIP_PIPER_REAL=1` lo omite a mano). No necesita red: Piper sintetiza en local.
  Apunta `TTS_PIPER_DIR`/`TTS_PIPER_VOICES_DIR` a instalaciones falsas en el tmpdir
  para probar "instalado" y "sin instalar" en la misma corrida, y usa un Piper de
  mentira por la costura `spawnImpl`. Ver [[piper-empaquetado]].
- `npm --prefix backend run test:voice-model` — modelo de voz/pitch y acciones por
  usuario (T-011), 43 comprobaciones: el rango y la persistencia del pitch aleatorio
  (con un **reinicio real**: se cierra y se reabre el archivo SQLite), la prioridad
  `override > command > global` con un usuario en cada nivel pasando por el pipeline,
  que cambiar `global_voice_id` mueva **solo** al nivel 3 conservando los pitch, el
  `PATCH /api/users/:id/preferences` sobre un Express en el puerto 0, y el enganche
  `assignUserVoice()` que usará T-012. Hermético: sin `.env`, sin red, sin puertos fijos.
- `npm --prefix backend run test:chat-command` — comando `!cambia-mi-voz` (T-012), 35
  comprobaciones: el parseo (mayúsculas, espacios, argumentos y los falsos positivos),
  el sorteo sobre un registro de motores de juguete (solo español, nunca la voz
  actual, reparte entre motores), el camino completo por el relay (el comando se ve y
  no se lee, `voice_source = 'command'`, aplica al mensaje siguiente, ocho repeticiones
  sin cooldown), el override que gana, los casos de `muted`/`ignored`/usuario nuevo, un
  **reinicio real** de la base y que nada de eso lance (catálogo, red o base caídos).
  Hermético: sin `.env`, sin red, sin puertos.
- `npm --prefix backend run test:settings` — ajustes globales (T-013), 29
  comprobaciones: defaults y normalización de valores imposibles de `app_settings`,
  la validación del patch, `GET`/`PATCH /api/settings` sobre un Express en el puerto
  0, que cambiar `global_voice_id` mueva **solo** al nivel 3 sin reiniciar (pipeline
  y relay construidos antes de la escritura), la convivencia con el
  `!cambia-mi-voz` de T-012 (comando real por el relay: la voz de nivel 2 no la pisa
  la global) y que los tres ajustes sobrevivan a cerrar/reabrir el archivo **y** a un
  **SIGTERM + arranque del backend real**. La
  segunda mitad levanta `src/server.js` como hijo, que es lo que prueba el montaje
  en `app.js`; no necesita red ni fakes (`TTS_EDGE_ENABLED=false`,
  `TTS_PIPER_ENABLED=false` y sin sesión de Twitch basta).

**Para correr `test:piper` con los artefactos del checkout principal,
`TTS_PIPER_DIR` apunta a la carpeta `vendor`, NO a `vendor/piper`** (`piperPaths()`
resuelve `<root>/piper`, `<root>/piper-voices` y el manifiesto dentro de ese root).
Con la ruta mal puesta el gate igual pasa, pero en **41/41 "Piper no instalado"** en
vez de 45/45 — y eso parece un problema de empaquetado cuando en realidad es la
variable.

Los once `test:*` corren sobre una base SQLite temporal (`DB_FILE`) y puertos
libres, así que **no necesitan `.env` ni credenciales** y no tocan
`backend/data/app.sqlite` ni pelean con un backend ya corriendo (el único que sale
a la red es `test:edge-tts`). Todos menos `test:db`, `test:tts` y `test:edge-tts`
levantan el backend real como proceso hijo apuntado a un imitador
([[imitador-de-servicios-externos]]).

Los tres que levantan el backend llevan `TTS_EDGE_ENABLED: 'false'` en el entorno
del hijo desde T-009, para seguir siendo herméticos: con el motor registrado, cada
mensaje de chat dispararía una síntesis real contra Microsoft. Si añades un gate que
arranque el backend, cópialo.

Cada worktree nuevo necesita `npm install` en el paquete que vas a verificar
(`npm --prefix backend install`): los `node_modules` no se comparten entre
worktrees.

**Verificar el backend arrancado:** usa un puerto libre por variable de entorno
(los subagentes en paralelo se pisan en el 3000/5173) y **nunca commitees un
`.env` de pruebas**. `dotenv` no sobreescribe una variable ya presente en
`process.env`, ni siquiera vacía: `TWITCH_CLIENT_ID= node src/server.js` simula
"falta la variable" aunque exista un `.env` con valor.

**Al levantar Vite a mano:** hay que lanzarlo con `cwd` en `frontend/`
(`node node_modules/vite/bin/vite.js`); desde la raíz del repo no encuentra
`vite.config.js`, ignora `FRONTEND_PORT`/`BACKEND_PORT` y sirve la raíz en el 5173
ajeno ([[puerto-5173-ocupado]]).

**Corre el gate antes de investigar por qué falla.** Tras el merge de T-007 con
`main` (que ya traía T-006 y T-008) se dio por hecho que `test:chatters` fallaba
por el cambio de trama de T-008, y la iteración se colgó investigando la
hipótesis: el gate estaba **verde, 15/15**. Los nueve gates pasan sobre el merge
sin tocar código. Diagnostica sobre output real, no sobre una hipótesis heredada.

**Los gates que levantan el backend hijo son intermitentes bajo carga.** Corriendo los
nueve seguidos, `test:oauth` falló una vez con `timeout esperando que el backend
responda /api/health (10000 ms)` y volvió a pasar 16/16 cuatro veces seguidas sobre el
**mismo árbol**. El síntoma es un timeout de arranque, no una aserción: antes de
buscar una regresión, **repite el gate solo** (y si hace falta, espacia las corridas).

**No hay `timeout` ni `gtimeout` en esta máquina** (macOS sin coreutils de
Homebrew en el PATH). Para no colgarse: pon el tope en el propio parámetro
`timeout` de la herramienta Bash y redirige a un log (`> …/gate.log 2>&1`), así
queda output parcial si lo mata. Los seis gates completos tardan ~2 min en total,
así que 180 s por gate sobra.

**Why:** los comandos de la definición del subagente (`pnpm`, `--filter`,
typecheck) no existen aquí, y confundir el gate cuesta una iteración.

**How to apply:** al abrir una iteración, corre estos comandos tal cual. Ver
[[no-es-yardos]].
