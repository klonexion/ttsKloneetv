# PRD: Multi-Chat Streamer Hub con TTS — Fase 1 (Twitch)

## Self-Clarification

1. **Problem/Goal:** El streamer necesita una sola interfaz local para ver el
   chat de Twitch en vivo, escribir en él, y que los mensajes se lean por TTS
   con voces distinguibles por usuario — sin depender de herramientas de
   terceros y con arquitectura lista para sumar YouTube/TikTok y más motores
   TTS después.
2. **Core Functionality:** App web local (frontend Vue + backend Node) con
   login OAuth de Twitch, chat en tiempo real con auto-scroll, envío de
   mensajes, columna de usuarios presentes con acciones locales (mute TTS,
   volumen, ignorar, voz, pitch), y lectura TTS de cada mensaje con tres
   motores (navegador, edge-tts, Piper), voces en español por default.
3. **Scope/Boundaries:** Incluido: todo lo anterior, un solo usuario, corriendo
   local (dev en macOS, producción en Windows 11). Excluido: moderación de
   Twitch (ban/timeout/VIP...), otras plataformas de chat, historial de chat
   persistente, multi-tenant.
4. **Success Criteria:** El streamer inicia sesión con Twitch, ve mensajes en
   vivo, los oye por TTS con la voz/pitch correctos según el modelo de
   prioridad, puede enviar mensajes, gestionar usuarios desde la columna
   derecha, y encender/apagar todo con PM2 tanto en macOS como en Windows 11.
5. **Constraints:** JavaScript (sin TypeScript). Vue 3 + Vite + Vuetify 3.
   Express + ws. SQLite (better-sqlite3). PM2. Secretos solo en `.env` (nunca
   commiteado). Todo el audio se reproduce en el navegador. EventSub WebSocket
   para leer chat y Helix para escribir (IRC para comandos está deprecado).

## Introduction

El proyecto arranca desde cero (greenfield): no existe código, solo los
documentos de diseño. Este plan construye la fase 1 completa como una serie de
tareas atómicas, empezando por un tracer bullet (T-001→T-006) que entrega un
chat de Twitch funcional end-to-end (login → ver mensajes → enviar mensajes), y
montando después el sistema TTS y el modelo de voces encima de esa base
probada.

La arquitectura es un monorepo con `backend/` (Express + ws, sostiene EventSub,
tokens, SQLite y los motores TTS de servidor) y `frontend/` (Vue 3 + Vuetify 3,
reproduce TODO el audio y posee la cola de reproducción). El diseño usa
interfaces adapter en dos ejes — proveedores de chat y motores TTS — para que
la fase 2 (YouTube, TikTok, más voces) agregue implementaciones sin tocar el
frontend.

## Decisiones arquitectónicas durables

- **Monorepo:** `backend/` y `frontend/` como paquetes npm independientes;
  `ecosystem.config.js` (PM2) en la raíz; `.env` solo en `backend/`
  (con `.env.example` commiteado).
- **Rutas backend:** `GET /auth/login` (redirect a Twitch), `GET
  /auth/callback` (redirect URI `http://localhost:3000/auth/callback`),
  WebSocket frontend↔backend en `/ws`, REST bajo `/api/*`.
- **Esquema SQLite:**
  - `tokens` (provider, access_token, refresh_token, expires_at, scopes)
  - `users` (twitch_user_id PK, username, display_name, muted, ignored,
    volume, pitch, voice_id NULL, voice_source `override|command|NULL`,
    first_seen_at, last_active_at)
  - `app_settings` (key, value) — voz global, tema, etc.
- **Interfaces adapter:** `ChatProvider` (fase 1: `TwitchProvider`) y
  `TTSEngine` (fase 1: `BrowserEngine`, `EdgeTtsEngine`, `PiperEngine`). IDs de
  voz namespaced: `browser:<name>`, `edge:<ShortName>`, `piper:<model>`.
- **Flujo de audio:** el backend resuelve voz/pitch/volumen por mensaje y lo
  publica por `/ws`; si el motor es de servidor adjunta el audio (base64 o URL
  servida), si es `browser:` el frontend sintetiza con Web Speech. La **cola
  FIFO vive en el frontend** (sin límite, con skip/vaciar/pausa).
- **Modelo de voz:** prioridad `override` (streamer) → `command`
  (`!cambia-mi-voz`) → voz global (default `edge:es-MX-DaliaNeural`); pitch
  aleatorio persistente por usuario (0.8–1.4) asignado en su primer mensaje.
- **Scopes Twitch:** `user:read:chat`, `user:write:chat`,
  `moderator:read:chatters`.
- **Quality gate:** `npm run lint` y `npm run build` (frontend) / `npm run
  lint` (backend) deben pasar en cada tarea. No hay typecheck (JS puro).

## Design References

- `docs/decisiones.md` — decisiones de la sesión de grill (fuente de verdad).
- `docs/pitch-grill-me.md` — pitch original.
- Twitch: EventSub `channel.chat.message`, Helix Send Chat Message, Get
  Chatters (`https://dev.twitch.tv/docs/`).
- edge-tts para Node: paquete `node-edge-tts` o `edge-tts-universal`.
- Piper TTS: `https://github.com/rhasspy/piper` (binarios macOS/Windows +
  modelos de voz es_ES/es_MX).

## Tasks

### T-001: Scaffold del monorepo con PM2

**Description:** Crear la estructura base del proyecto: `backend/` (Express +
ws, endpoint de salud) y `frontend/` (Vue 3 + Vite + Vuetify 3 con tema oscuro
default y una página placeholder), ESLint en ambos, `ecosystem.config.js` de
PM2 en la raíz que levanta los dos procesos, `.env.example`, `.gitignore` (que
excluye `.env`, `*.sqlite`, `node_modules`) y README con instrucciones de
arranque para macOS y Windows 11.

**Acceptance Criteria:**

- [x] `backend/` responde `GET /api/health` con `{ status: "ok" }` en el puerto 3000.
- [x] `frontend/` (Vite, puerto 5173) renderiza una página Vuetify con tema oscuro y el proxy `/api` → backend configurado.
- [x] `pm2 start ecosystem.config.js` levanta ambos procesos y `pm2 stop all` los detiene (comandos documentados en README).
- [x] Existe `backend/.env.example` con todas las variables (TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_REDIRECT_URI, PORT) y `.env` está en `.gitignore`.
- [x] `npm run lint` pasa en ambos paquetes y `npm run build` pasa en frontend.
- [x] Quality checks pass.
- [x] Verify in browser.

**Notas de implementación (T-001):** convenciones que las tareas siguientes deben
respetar en lugar de introducir un estilo propio.

- **PM2 sin instalación global:** `pm2` es devDependency de la raíz; los scripts
  `npm start` / `npm stop` / `npm run down` / `npm run logs` lo invocan desde
  `node_modules/.bin` (equivalente con `npx pm2 ...`). No hace falta `npm i -g pm2`
  ni en macOS ni en Windows 11.
- **`ecosystem.config.js`:** CommonJS (lo exige PM2), rutas con
  `path.join(__dirname, ...)`, y cada app apunta a un **entrypoint de Node**
  (`backend/src/server.js`, `frontend/node_modules/vite/bin/vite.js`) en vez de
  `npm run ...`, porque la variante con npm necesita intérprete de shell y rompe
  en Windows. Logs en `logs/` (git-ignorado).
- **Paquetes:** dos paquetes npm independientes, ambos ESM (`"type": "module"`),
  sin workspaces. Desde la raíz se orquesta con `npm --prefix <paquete> run <script>`;
  `npm install` en la raíz instala los tres vía `postinstall`.
- **Lint:** ESLint 9 flat config por paquete (`eslint.config.js`); el script `lint`
  usa `--max-warnings=0`, así que un warning rompe el gate. Las reglas de formato
  puro de `eslint-plugin-vue` están desactivadas (el proyecto no usa Prettier).
- **Rutas y proxy:** el frontend usa siempre rutas relativas; `vite.config.js`
  proxya `/api`, `/auth` y `/ws` (con `ws: true`) a `http://localhost:3000`. No
  hardcodear orígenes en el código de la app.
- **Huecos ya previstos:** `backend/src/config.js` (T-002 le añade validación de
  variables requeridas y la ruta de SQLite), `backend/src/ws/hub.js` con
  `broadcast(type, payload)` (único canal push al frontend: T-004/T-007/T-008),
  `backend/src/logger.js`, y `frontend/src/App.vue` como placeholder que T-005
  reemplaza por el shell de tres zonas.
- **Git-ignorado:** `.env`, `*.sqlite`, `backend/data/`, `backend/vendor/`
  (binario y modelos de Piper para T-010), `node_modules/`, `dist/`, `logs/`.
- **Versiones fijadas:** Express 5, ws 8, dotenv 17 (backend); Vue 3.5, Vuetify 3.12,
  Vite 7, ESLint 9 (frontend). Vuetify se importa completo en
  `frontend/src/plugins/vuetify.js` (sin `vite-plugin-vuetify`): el bundle es grande
  pero la app es local y no hay costo de red real.

### T-002: Capa de datos SQLite y configuración

**Description:** Implementar la capa de persistencia del backend con
better-sqlite3: creación/migración idempotente de las tablas `tokens`, `users`
y `app_settings` según el esquema del header, un módulo repositorio con
funciones CRUD para cada tabla, y un módulo de configuración que carga `.env`
y falla con mensaje claro si falta una variable requerida.

**Acceptance Criteria:**

- [x] Al arrancar el backend se crea `backend/data/app.sqlite` con las tres tablas si no existen (idempotente en arranques repetidos).
- [x] El repositorio expone operaciones de lectura/escritura para tokens, users (incluyendo upsert por `twitch_user_id`) y app_settings, con pruebas de humo ejecutables vía un script npm.
- [x] Arrancar sin `TWITCH_CLIENT_ID` en `.env` termina el proceso con un error que nombra la variable faltante.
- [x] `app_settings` se inicializa con la voz global default `edge:es-MX-DaliaNeural` y tema `dark`.
- [x] Quality checks pass.

**Notas de implementación (T-002):** contrato de la capa de datos que consumen
T-003, T-004, T-007 y T-011→T-013.

- **Prueba de humo:** `npm --prefix backend run test:db` (script `test:db` →
  `backend/scripts/smoke-db.js`). Es el gate de datos: 25 comprobaciones sobre una
  base temporal en el tmpdir del SO (nunca toca `backend/data/app.sqlite` ni
  necesita `.env`), incluidas migración idempotente, upsert por `twitch_user_id` y
  un `spawn` real del servidor sin `TWITCH_CLIENT_ID` que verifica exit code 1.
- **`better-sqlite3` 13:** trae prebuilds N-API dentro del tarball de npm
  (`node_modules/better-sqlite3/prebuilds/<plataforma>-<arch>.node`, incluido
  `win32-x64`), así que `npm install` no compila nada ni necesita build tools —
  ni en macOS/Node 24 ni en Windows 11. No bajar de la 12 sin revisar esto.
- **Acceso a la base:** `backend/src/db/index.js` expone `initDatabase()` (el
  entrypoint la llama antes de `listen`), `getDb()`, `getRepositories()` y
  `closeDatabase()` (lo llama el shutdown). Para tests o herramientas hay
  `openDatabase(file)`, que abre y migra cualquier archivo. WAL activado.
- **Migración idempotente** en `backend/src/db/migrations.js`: todo es
  `CREATE TABLE IF NOT EXISTS` + `INSERT OR IGNORE`, así que corre en cada
  arranque y **no pisa** ajustes que el usuario ya cambió. El esquema vive solo
  ahí; no hay tabla de versiones (si una tarea futura necesita alterar columnas,
  añade sentencias condicionales en `migrate()`).
- **Repositorios** (`backend/src/db/repositories/`): factories
  `createTokensRepository(db)` / `createUsersRepository(db)` /
  `createSettingsRepository(db)`, agrupadas por `createRepositories(db)`.
  Traducen entre el `snake_case` de SQL y el `camelCase` de JS: los consumidores
  nunca ven nombres de columna.
  - `tokens`: `get/list/save/delete` por proveedor (default `twitch`, una fila por
    proveedor; `save()` es upsert, así que un refresh de T-003 no duplica filas).
    `scopes` se guarda como string separado por espacios y se devuelve como array.
  - `users`: `get/list/count/upsert/updatePreferences/delete`. `upsert()` es por
    `twitch_user_id`: la primera vez inserta con los defaults y `first_seen_at`,
    después solo refresca `username`, `display_name` y `last_active_at` —
    **nunca** pisa preferencias ni el pitch ya asignado. El `volume`/`pitch` que se
    le pasan solo aplican en la inserción inicial (así T-011 asigna el pitch
    aleatorio en el primer mensaje); los cambios posteriores van por
    `updatePreferences()`, que es un patch parcial y acepta `null` en
    `voiceId`/`voiceSource` para volver a la voz global. `list()` viene ordenado por
    `last_active_at DESC` (lo que necesita la columna de usuarios de T-007).
  - `settings`: `get/all/set/setAll/delete` más `getGlobalVoiceId()` y
    `getTheme()`. Claves sembradas: `global_voice_id` = `edge:es-MX-DaliaNeural`,
    `theme` = `dark` (`SETTING_KEYS` y `DEFAULT_SETTINGS` son la fuente de verdad
    de los nombres; T-013 añade las suyas por el mismo camino).
- **Convenciones de tipos en SQLite:** los timestamps (`expires_at`,
  `first_seen_at`, `last_active_at`) son INTEGER en **ms epoch UTC**
  (`Date.now()`); los booleanos (`muted`, `ignored`) son INTEGER 0/1 en SQL y
  `true`/`false` al salir del repositorio; `voice_source` tiene un `CHECK` que solo
  admite `override`, `command` o NULL.
- **Configuración:** `backend/src/config.js` añade `config.db.{directory,file}` y
  la validación: `REQUIRED_ENV_VARS` = `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`
  (`PORT` y `TWITCH_REDIRECT_URI` tienen default, así que no son requeridas), con
  `findMissingEnvVars(env)` y `assertConfig(env)`, que lanza `MissingConfigError`
  nombrando **todas** las variables que faltan (una variable vacía o con solo
  espacios cuenta como faltante). `server.js` la llama primero y hace
  `logger.error(mensaje)` + `process.exit(1)`; el mensaje nunca imprime valores.
  Las tareas siguientes que necesiten una variable obligatoria nueva la añaden a
  `REQUIRED_ENV_VARS` y a `.env.example`.
- **`dotenv` no sobreescribe** variables ya presentes en `process.env` (ni las
  vacías), así que arrancar con `TWITCH_CLIENT_ID=''` simula "falta la variable"
  aunque exista un `.env` local — de eso se aprovecha la prueba de humo.

### T-003: OAuth con Twitch

**Description:** Implementar el flujo authorization-code completo: el frontend
muestra un botón "Iniciar sesión con Twitch" cuando no hay sesión; `GET
/auth/login` redirige a Twitch con los scopes `user:read:chat
user:write:chat moderator:read:chatters`; `GET /auth/callback` intercambia el
código por tokens, los persiste en SQLite junto con el user id/login del
broadcaster, y redirige al frontend. El backend refresca el access token
automáticamente antes de expirar y expone `GET /api/session` para que el
frontend sepa si está autenticado.

**Acceptance Criteria:**

- [x] Sin tokens en SQLite, el frontend muestra solo el botón "Iniciar sesión con Twitch"; con tokens válidos muestra la app y el nombre del canal conectado.
- [x] El flujo completo login → Twitch → callback → redirect deja access_token, refresh_token y expiración persistidos en la tabla `tokens`.
- [x] Un access token expirado se refresca automáticamente con el refresh_token sin intervención del usuario (verificable forzando `expires_at` en el pasado).
- [x] `GET /api/session` devuelve `{ authenticated, channel }` correctamente en ambos estados.
- [x] Quality checks pass.
- [x] Verify in browser.

**Notas de implementación (T-003):** contrato de la sesión que consumen T-004,
T-006 y T-007, más lo que falta para confirmar contra Twitch real.

- **Alcance de la verificación (importante):** el flujo se ejercitó de punta a
  punta contra un **imitador local** de Twitch, no contra Twitch real: el
  operador todavía no puso sus credenciales (`backend/.env` no existe). Lo que
  está confirmado contra los endpoints reales es solo el *contrato* (forma de las
  peticiones y respuestas); la confirmación en vivo la tiene que hacer el
  operador con los pasos de "Confirmación en vivo" de más abajo.
- **Punto de enganche único para los tokens** (`backend/src/auth/session.js`):
  `await getValidAccessToken()` devuelve un access token válido (refrescando por
  adelantado si le quedan menos de 5 min) o `null` si no hay sesión. **T-004 y
  T-006 no deben leer la tabla `tokens` ni implementar su propio refresh.**
  También hay `getChannel()` (`{ id, login, displayName }` del broadcaster, que
  T-004 necesita para suscribirse a EventSub) y `getSession()`.
- **Nada de estado en memoria:** la sesión se lee de SQLite en cada uso, así que
  un cambio externo en la base (por ejemplo forzar `expires_at` al pasado) se ve
  en el ciclo siguiente sin reiniciar el proceso. `refreshSession()` colapsa las
  llamadas concurrentes en una sola petición a Twitch.
- **Refresh automático:** `startTokenRefreshLoop()` (lo arranca `server.js`)
  revisa la expiración cada `TWITCH_TOKEN_CHECK_INTERVAL_MS` (default 60 s) y
  refresca solo, aunque el frontend esté cerrado. `tokens.save()` es upsert, así
  que la fila no se duplica. Si Twitch **rechaza** el refresh (400/401: token
  revocado), la sesión se borra entera y el frontend vuelve a la compuerta de
  login; los fallos transitorios (red, 5xx) solo se loguean y se reintentan.
- **Identidad del canal en `app_settings`:** claves `twitch_user_id`,
  `twitch_login`, `twitch_display_name` (añadidas a `SETTING_KEYS`), porque el
  esquema de `tokens` está fijado por el plan y no admite columnas nuevas. Se
  borran junto con los tokens: no queda un canal "fantasma" sin sesión.
- **CSRF:** `/auth/login` emite un `state` aleatorio de un solo uso guardado en
  memoria (app local, un solo usuario) con TTL de 10 min; `/auth/callback`
  lo consume y descarta cualquier callback con `state` desconocido o repetido.
  Los fallos vuelven al frontend como `?auth_error=denied|state|missing_code|exchange`
  (el store los traduce a un aviso y limpia la URL); **nunca** se filtra un token
  ni el `client_secret` en logs ni en mensajes de error.
- **Config nueva** (toda en `backend/.env.example`): `FRONTEND_URL` (adonde
  vuelve el navegador tras el callback, default `http://localhost:5173`),
  `TWITCH_AUTH_BASE_URL` / `TWITCH_API_BASE_URL` (defaults: los endpoints reales
  `https://id.twitch.tv` y `https://api.twitch.tv`; ver `TWITCH_DEFAULTS` en
  `config.js`), `TWITCH_TOKEN_CHECK_INTERVAL_MS` y `DB_FILE` (base SQLite
  alternativa, para pruebas). Ninguna es requerida: `REQUIRED_ENV_VARS` sigue
  siendo `TWITCH_CLIENT_ID` + `TWITCH_CLIENT_SECRET`.
- **Imitador de Twitch** (`backend/scripts/fake-twitch.js`): habla el mismo
  contrato HTTP que Twitch (`/oauth2/authorize` → 302 con `code` y `state`,
  `/oauth2/token` para los grants `authorization_code` y `refresh_token` con
  rotación del refresh token, `/helix/users`), aprueba automáticamente y con
  `&fake_deny=1` simula que el usuario cancela. `npm --prefix backend run
  fake-twitch` lo levanta en el 4100 para probar la app entera sin credenciales.
- **Gate de integración:** `npm --prefix backend run test:oauth`
  (`scripts/smoke-oauth.js`, 16 comprobaciones). Levanta el imitador y **el
  backend real** como proceso hijo apuntado a él, sobre una base temporal
  (`DB_FILE`) y un puerto libre, y recorre `/auth/login` → authorize →
  `/auth/callback` → `/api/session` comprobando la persistencia en SQLite,
  el rechazo de callbacks inválidos, el refresh forzando `expires_at` al pasado y
  el borrado de sesión cuando el refresh token ya no sirve. No necesita red ni
  credenciales y no toca `backend/data/app.sqlite`.
- **Compuerta en el frontend:** `App.vue` **envuelve** el shell de T-005 sin
  reestructurarlo — `v-progress-circular` mientras se resuelve `GET /api/session`,
  `components/auth/LoginView.vue` si no hay sesión, y el shell tal cual (app bar,
  drawer, `ChatPanel`, `ChatInputBar`) si la hay, con un chip morado
  (`data-testid="channel-name"`) con el nombre del canal al lado del chip de
  `/ws`. Los huecos de T-006/T-007/T-008 quedan intactos.
- **El `/ws` se abre y cierra con la sesión** (watcher sobre `authenticated`), así
  que T-004/T-007/T-008 pueden asumir que si el shell está montado hay canal
  conectado. El store `stores/session.js` sondea `/api/session` cada 30 s, de modo
  que si el token se revoca la app vuelve sola a la compuerta sin recargar.
- **El botón de login es un enlace real** (`href="/auth/login"`), no un `fetch`:
  el endpoint responde 302 a Twitch y el navegador tiene que navegar.
- **Confirmación en vivo (pendiente, la hace el operador):**
  1. `cp backend/.env.example backend/.env` y rellenar `TWITCH_CLIENT_ID` y
     `TWITCH_CLIENT_SECRET` con los de la app de dev.twitch.tv. Dejar
     `TWITCH_REDIRECT_URI=http://localhost:3000/auth/callback` (tiene que ser
     idéntico al registrado), `PORT=3000` y `FRONTEND_URL=http://localhost:5173`.
     **No** descomentar `TWITCH_AUTH_BASE_URL` ni `TWITCH_API_BASE_URL`.
  2. `npm start` en la raíz (PM2 levanta backend y frontend) y abrir
     `http://localhost:5173`.
  3. Esperado: solo el botón "Iniciar sesión con Twitch" → al pulsarlo, la
     pantalla de consentimiento **de Twitch** pidiendo los tres scopes →
     "Authorize" → vuelve a `http://localhost:5173` con la app y un chip morado
     con el nombre del canal propio, y el chip de conexión en "Conectado".
  4. Comprobar la persistencia: `sqlite3 backend/data/app.sqlite "SELECT provider,
     expires_at, scopes FROM tokens;"` debe devolver una fila; y
     `SELECT * FROM app_settings WHERE key LIKE 'twitch%';` el canal.
  5. Refresh real: `sqlite3 backend/data/app.sqlite "UPDATE tokens SET expires_at
     = 0;"` y esperar hasta un minuto; `SELECT expires_at FROM tokens;` debe
     mostrar una expiración futura y la app seguir funcionando sin re-login.

### T-004: EventSub y relay de mensajes al frontend

**Description:** Implementar la interfaz `ChatProvider` y el `TwitchProvider`:
conexión al EventSub WebSocket de Twitch, suscripción a `channel.chat.message`
del propio canal, manejo de reconexión (mensaje `session_reconnect` y caídas),
y retransmisión de cada mensaje normalizado (`{ id, userId, username,
displayName, text, timestamp }`) a todos los clientes conectados al WebSocket
`/ws` del backend. Cada mensaje además hace upsert del usuario en la tabla
`users` actualizando `last_active_at`.

**Acceptance Criteria:**

- [x] Con sesión activa, el backend establece la suscripción EventSub y los mensajes escritos en el chat de Twitch llegan al frontend por `/ws` en menos de ~2 s.
- [x] Los mensajes se entregan normalizados con el shape documentado, agnóstico de Twitch (sin campos crudos de EventSub).
- [x] Si Twitch envía `session_reconnect` o la conexión cae, el provider se reconecta solo y los mensajes siguen fluyendo (verificable matando la conexión).
- [x] Cada mensaje inserta/actualiza al usuario en `users` con `last_active_at`.
- [x] Quality checks pass.

**Notas de implementación (T-004):** puntos de enganche para la Ola 5 (T-006,
T-007, T-008) y qué falta para confirmar contra Twitch real.

- **Alcance de la verificación (importante):** igual que T-003, todo se ejercitó
  contra un **imitador local** de EventSub, no contra Twitch real (`backend/.env`
  no existe todavía). Lo confirmado contra los endpoints reales es solo el
  *contrato* (protocolo del WebSocket, forma de la suscripción por Helix y del
  evento `channel.chat.message`); la confirmación en vivo la hace el operador con
  los pasos de "Confirmación en vivo" de más abajo.
- **Gate nuevo:** `npm --prefix backend run test:eventsub`
  (`scripts/smoke-eventsub.js`, 16 comprobaciones). Levanta el imitador y **el
  backend real** como proceso hijo apuntado a él, se conecta al `/ws` como el
  navegador y recorre EventSub → provider → upsert en `users` → `chat:message`,
  incluidas las dos reconexiones, la deduplicación por `message_id` y el apagado
  con SIGTERM. No necesita `.env`, red ni puertos fijos, y no toca
  `backend/data/app.sqlite` (usa `DB_FILE` en una base temporal).
- **Dónde vive el provider:** `backend/src/chat/`.
  - `provider.js` — la interfaz adapter `ChatProvider` (eventos `message`,
    `status`, `error`, `auth-invalid`; estados en `CHAT_PROVIDER_STATUS`), el
    validador `isNormalizedChatMessage()` y `createSeenIdFilter()`. Fase 2 (YouTube,
    TikTok) añade implementaciones aquí sin tocar el frontend.
  - `twitch-provider.js` — `createTwitchProvider()` (WebSocket de EventSub,
    reconexión, migración de sesión) y `normalizeChatMessage()`, que es el único
    lugar que conoce el formato crudo de Twitch.
  - `relay.js` — `createChatRelay({ hub })`: upsert + `broadcast()` y el
    supervisor del ciclo de vida. `server.js` lo arranca y lo para en el shutdown.
- **Trama que ya está fluyendo al frontend** (`CHAT_MESSAGE_TYPE` en `relay.js`,
  el mismo string que el store): `broadcast('chat:message', { id, userId,
  username, displayName, text, timestamp })`. `timestamp` es ISO 8601 (el de la
  trama de EventSub) y `id` es el `message_id` de Twitch, así que el store puede
  deduplicar. **T-007 y T-008 publican lo suyo con el mismo `hub.broadcast(tipo,
  payload)`**; no hace falta otro WebSocket ni tocar el relay.
- **Reaccionar a cada mensaje en el backend** (lo que necesita T-008 para el
  pipeline TTS): `relay.onMessage(handler)` entrega el mensaje ya normalizado
  después del upsert. Si T-008 necesita **enriquecer** la trama que ve el
  frontend (adjuntar `{ engine, voiceId, pitch, volume }`), el punto correcto es
  `handleMessage` de `relay.js`: un solo `broadcast` por mensaje, no dos tramas.
- **Cómo llamar a la API de Twitch** (T-006 Helix send, T-007 Get Chatters):
  `helixRequest(path, { accessToken, method, query, body })` de
  `src/twitch/helix.js` pone los headers obligatorios, normaliza errores en
  `TwitchApiError` (`permanent` distingue credencial rechazada de fallo de red) y
  respeta `config.twitch.apiBaseUrl`. El token se obtiene **solo** con
  `await getValidAccessToken()` (T-003) y el canal con `getChannel()`.
- **Suscripciones EventSub adicionales:** `createEventSubSubscription()` en
  `src/twitch/eventsub.js` + `provider.getSessionId()` para el `session_id` en
  uso. Una suscripción nueva no necesita otro WebSocket.
- **Ciclo de vida:** el relay sondea la sesión cada
  `TWITCH_CHAT_SESSION_POLL_MS` (default 5 s) y conecta o desconecta según
  aparezca o se pierda; así un login no exige reiniciar el backend y un token
  revocado apaga la lectura. Si la suscripción es rechazada de forma permanente
  (401/403), el provider emite `auth-invalid` y el relay espera 30 s antes de
  reintentar en vez de martillear Helix.
- **Protocolo, los dos detalles que importan:** (1) hay ~10 s desde el
  `session_welcome` para crear la suscripción o Twitch cierra con 4003; (2) en un
  `session_reconnect` se abre la `reconnect_url` **manteniendo la conexión vieja
  abierta** y **sin volver a suscribirse** (las suscripciones viajan con la
  sesión, re-suscribirse daría 409). De ahí el filtro de ids ya vistos: durante el
  solapamiento el mismo evento puede llegar por las dos conexiones.
- **Watchdog de keepalive:** si pasan `TWITCH_EVENTSUB_KEEPALIVE_SECONDS` (default
  30, negociado con el welcome) más 5 s sin recibir nada, la conexión se da por
  muerta y se reconecta con backoff 1→2→5→10→30 s. Una caída en seco sí genera
  suscripción nueva (sesión nueva).
- **Config nueva** (toda en `backend/.env.example`, ninguna requerida):
  `TWITCH_EVENTSUB_WS_URL` (default el real `wss://eventsub.wss.twitch.tv/ws`),
  `TWITCH_EVENTSUB_KEEPALIVE_SECONDS`, `TWITCH_CHAT_SESSION_POLL_MS`. El gate
  comprueba que los defaults sigan siendo los endpoints reales para que el
  imitador no pueda filtrarse a producción.
- **Imitador de EventSub** (`backend/scripts/fake-eventsub.js`,
  `npm --prefix backend run fake-eventsub`): WebSocket con `session_welcome`,
  `session_keepalive`, `notification`, `session_reconnect` y el cierre 4003 por
  no suscribirse, más `POST /helix/eventsub/subscriptions`; delega el OAuth y
  `/helix/users` en `fake-twitch.js`, así que sirve como
  `TWITCH_AUTH_BASE_URL`, `TWITCH_API_BASE_URL` **y** `TWITCH_EVENTSUB_WS_URL` a la
  vez. Mandos: `/_fake/eventsub/say` (con `repeat` para probar entregas
  duplicadas), `/reconnect`, `/drop`, `/keepalive` y `/stats`.
- **Defecto de apagado, arreglado** (rompía el criterio de `pm2 stop` de T-001):
  `hub.close()` ahora recorre `wss.clients` con `terminate()` antes de
  `wss.close()`, y el shutdown de `server.js` llama a `closeIdleConnections()` +
  `closeAllConnections()` — sin lo segundo las conexiones keep-alive del proxy de
  Vite mantenían el proceso vivo. Con un navegador conectado, SIGTERM cierra en
  ~10 ms (antes se colgaba). Hay un temporizador de seguridad de 5 s que fuerza la
  salida y loguea `cierre forzado`; el gate falla si se usa, así que no puede
  tapar una regresión.
- **Verificado en Chrome real** (imitador en 4110, backend 3004, frontend 5175):
  login por el imitador → suscripción creada con
  `condition = { broadcaster_user_id, user_id }` del canal → 16 mensajes visibles
  en el panel con latencia EventSub→DOM de 1–50 ms → `session_reconnect` (mensaje
  enviado *durante* la migración incluido, 0 suscripciones nuevas) →
  caída en seco (re-suscripción automática) → ráfaga de 30 mensajes con
  auto-scroll anclado al fondo (`scrollTop` 795 de 1390), pausa al subir con el
  botón "Volver abajo" y re-anclado al pulsarlo → filas correctas en `users` →
  SIGTERM con el navegador conectado (8 ms, sin cierre forzado, chip a
  "Reconectando…"). Cero errores de consola.
- **Confirmación en vivo (pendiente, la hace el operador):**
  1. Completar `backend/.env` como describe T-003 (client id/secret reales, sin
     descomentar ninguna `*_BASE_URL` ni `TWITCH_EVENTSUB_WS_URL`) e iniciar sesión.
  2. `npm start` en la raíz y abrir `http://localhost:5173`.
  3. Escribir un mensaje en el chat del canal desde Twitch (web o móvil):
     debe aparecer en el panel izquierdo en menos de ~2 s.
  4. Esperado en `logs/` (o `npm run logs`): `eventsub: conectado` y
     `eventsub: suscrito a channel.chat.message del canal <login>`.
  5. Persistencia: `sqlite3 backend/data/app.sqlite "SELECT twitch_user_id,
     username, last_active_at FROM users ORDER BY last_active_at DESC LIMIT 5;"`
     debe listar a quienes escribieron.
  6. Reconexión real: `pm2 restart backend` (o desconectar el wifi ~30 s y
     volver): el log debe mostrar la reconexión y los mensajes siguientes seguir
     apareciendo sin re-login. El `session_reconnect` lo manda Twitch cuando
     quiere (típicamente al rotar sus servidores), así que ese camino queda
     confirmado solo contra el imitador.
  7. `npm stop` debe detener ambos procesos con el navegador abierto.

### T-005: Shell de UI y panel de chat

**Description:** Construir el layout de tres zonas con Vuetify: panel de chat a
la izquierda, columna de usuarios a la derecha (placeholder por ahora), input
de envío abajo (deshabilitado por ahora). El panel de chat se conecta al `/ws`
del backend, muestra los mensajes en tiempo real (nombre con color + texto) y
hace auto-scroll hacia abajo, pausando el auto-scroll si el usuario sube
manualmente y retomándolo con un botón "volver abajo".

**Acceptance Criteria:**

- [x] Layout de tres zonas (chat izquierda, columna derecha, input abajo) en tema oscuro, usable a 1280×720 y a pantalla completa.
- [x] Los mensajes del chat real aparecen en vivo y la vista se desplaza sola al fondo con cada mensaje nuevo.
- [x] Si el usuario scrollea hacia arriba, el auto-scroll se pausa y aparece un botón para volver al fondo que lo reactiva.
- [x] La conexión `/ws` del frontend se reconecta sola si el backend se reinicia.
- [x] Quality checks pass.
- [x] Verify in browser.

**Notas de implementación (T-005):** dónde engancha cada tarea de la Ola 5 sin
reestructurar el shell.

- **Anatomía del shell** (`frontend/src/App.vue`): `v-app-bar` (título, chip de
  estado de `/ws`, botón de la columna) + `v-navigation-drawer` derecho de 280 px
  (`components/users/UsersPanel.vue`) + `v-main` con una columna flex:
  `ChatPanel` (el **único** contenedor con scroll) y `ChatInputBar` abajo. El
  shell mide `100dvh` y la página nunca scrollea (verificado:
  `scrollHeight === clientHeight` a 1280×720, 1920×1080, 2560×1440 y 414×800).
  Bajo el breakpoint `md` el drawer pasa a `temporary` y el chat toma el ancho
  completo.
- **Huecos por tarea:** **T-006** solo cablea `ChatInputBar.vue` (quitar
  `disabled`, `v-model`, Enter → `POST /api/chat/send`); **T-007** solo rellena
  `UsersPanel.vue` (el contenedor, encabezado y ancho ya están); **T-008** no
  toca el layout: se suscribe al hub y sus controles de cola caben en la app bar
  junto al chip de conexión. Los adornos por mensaje (indicador de "leyendo",
  icono de muteado) van en el slot `trailing` de `ChatMessageItem.vue`.
- **Cliente `/ws` único** (`frontend/src/ws/client.js`): singleton con
  reconexión automática (backoff 0.5→10 s) y despacho **por tipo de trama**.
  Regla para T-004/T-007/T-008: no abrir otro WebSocket ni reasignar
  `onmessage`; registrar `const off = onServerMessage('<tipo>', handler)`. Los
  listeners viven fuera del socket, así que sobreviven a las reconexiones. La URL
  se deriva de `window.location` (viaja por el proxy de Vite, sin orígenes
  hardcodeados) y `connectionState` alimenta el chip de la app bar.
- **Contrato de trama que debe emitir T-004:**
  `broadcast('chat:message', { id, userId, username, displayName, text, timestamp })`
  (la constante vive en `stores/chat-messages.js` como `CHAT_MESSAGE_TYPE`). El
  store normaliza, descarta duplicados por `id`, acepta también un array (por si
  T-004 manda backlog) y recorta a los últimos `MAX_MESSAGES = 500`.
- **Auto-scroll:** el panel se ancla al fondo mientras el usuario esté a ≤40 px
  del final. Un scroll del usuario hacia arriba lo pausa y muestra "Volver
  abajo"; el reflow (mensaje nuevo, resize de ventana, abrir/cerrar la columna de
  usuarios) **no** lo pausa: el handler compara `scrollHeight`/`clientHeight`
  contra el evento anterior y hay un `ResizeObserver` que re-ancla. Si se añade
  contenido de altura variable (avatares, emotes en T-011+), no hace falta tocar
  nada más.
- **Colores de nombre** (`utils/chat-format.js`): tono derivado del `userId` con
  el ángulo dorado. Sin ese paso, los ids consecutivos de Twitch caen en tonos
  casi idénticos (se observó en la verificación) y todos los nombres se ven del
  mismo color.
- **Puertos para desarrollo en paralelo:** `vite.config.js` acepta
  `FRONTEND_PORT` y `BACKEND_PORT` (defaults 5173 / 3000 sin cambios), lo que
  permite `BACKEND_PORT=3005 FRONTEND_PORT=5178 npm --prefix frontend run dev`
  sin tocar la config commiteada.
- **Alcance de la verificación:** el criterio de "chat real en vivo" se verificó
  inyectando mensajes por el `broadcast()` del hub real (mismo camino exacto que
  usará T-004), porque el relay de EventSub llega en T-004. Se comprobó en Chrome
  real: render, auto-scroll, pausa/reanudación y reconexión tras matar y relanzar
  el backend (chip `Reconectando…` → `Conectado`, y los mensajes vuelven a
  fluir). La confirmación contra el chat de Twitch en vivo queda para la Ola 5,
  cuando T-004 esté mergeada.
- **Quirk del backend detectado (no corregido aquí, `backend/` es de T-002):**
  con un cliente WebSocket conectado, `SIGTERM` no termina el proceso —
  `wss.close()` no cierra los sockets existentes, así que la promesa de
  `hub.close()` nunca resuelve y `server.close()` no llega a ejecutarse. Al
  reiniciar con PM2 conviene que el dueño del backend recorra
  `wss.clients` con `terminate()` antes de cerrar.

### T-006: Enviar mensajes al chat

**Description:** Habilitar el input inferior: al presionar Enter, el texto se
envía vía `POST /api/chat/send` y el backend lo publica con la API Helix Send
Chat Message como el broadcaster. El mensaje enviado aparece en el panel de
chat (llega de vuelta por EventSub). El input se limpia al enviar y muestra
error si el envío falla.

**Acceptance Criteria:**

- [x] Escribir un mensaje y presionar Enter lo publica en el chat real de Twitch y aparece en el panel izquierdo.
- [x] El input se limpia tras un envío exitoso; un fallo (p. ej. backend caído) muestra un aviso visible sin perder el texto escrito.
- [x] Los mensajes vacíos o solo espacios no se envían.
- [x] Quality checks pass.
- [x] Verify in browser.

**Notas de implementación (T-006):** contrato del envío y qué falta para
confirmar contra Twitch real.

- **Alcance de la verificación (importante):** igual que T-003 y T-004, todo se
  ejercitó contra **imitadores locales**, no contra Twitch real (`backend/.env`
  no existe). Lo confirmado contra el endpoint real es solo el *contrato* de
  Helix Send Chat Message (ruta, headers, cuerpo, tope de 500 caracteres y la
  respuesta `{ data: [{ message_id, is_sent, drop_reason }] }`); la confirmación
  en vivo la hace el operador con los pasos de más abajo.
- **Gate nuevo:** `npm --prefix backend run test:chat-send`
  (`scripts/smoke-chat-send.js`, 16 comprobaciones). Levanta el imitador de
  EventSub, el de Helix (que hace **eco** del mensaje enviado por EventSub, como
  Twitch) y **el backend real** como proceso hijo, se conecta al `/ws` como el
  navegador y recorre `POST /api/chat/send` → Helix → EventSub → `chat:message`.
  Cubre la validación, los tres modos de fallo de Twitch y el caso sin sesión. No
  necesita `.env`, red ni puertos fijos y no toca `backend/data/app.sqlite`
  (`DB_FILE` a una base temporal). Control negativo comprobado: sin la línea que
  monta el router en `app.js` quedan 3/16.
- **Dónde vive el envío:** `backend/src/chat/`.
  - `send.js` — `sendChatMessage(texto)`: recorta, valida (`MAX_MESSAGE_LENGTH =
    500`), pide el token con `getValidAccessToken()`, el canal con
    `getChannel()` y llama a `helixRequest('/helix/chat/messages', …)` con
    `broadcaster_id === sender_id === canal`. Lanza `ChatSendError` con `code`
    (`CHAT_SEND_CODES`) y `status`. **T-012 debe llamar a esta función** para
    responder en el chat, no a la ruta HTTP.
  - `send-router.js` — `createChatRouter()`, montado con una línea en `app.js`.
- **Contrato HTTP:** `POST /api/chat/send` con `{ text }` →
  `200 { sent: true, messageId }` (el `message_id` de Twitch). Los fallos vienen
  como `{ error, code }` con `error` en español listo para mostrar:
  `400 empty` (vacío o solo espacios), `400 too_long` (>500),
  `401 no_session`, `422 dropped` (Twitch aceptó la petición y **descartó** el
  mensaje: modo solo-seguidores, repetido, baneado…), `502 twitch_rejected`
  (permanente) y `503 twitch_unavailable` (transitorio, reintentable). El gate
  comprueba además que ni el access token ni el `client_secret` aparecen en la
  respuesta de error ni en el log.
- **Un solo camino de render:** el mensaje propio **no** se inyecta en el store;
  vuelve por EventSub (T-004) y se pinta como cualquier otro. Nada de eco
  optimista: evita el duplicado y el "fantasma" si Twitch lo descarta.
- **Input** (`frontend/src/components/chat/ChatInputBar.vue`): `v-model` +
  Enter (`@keydown.enter.prevent`) o el botón `mdi-send` (deshabilitado si no hay
  texto útil), `maxlength` 500, línea de carga mientras vuela la petición. Se
  limpia **solo** si el envío salió bien, y solo si el texto no cambió mientras
  volaba la petición (si el usuario siguió escribiendo, no se le borra lo nuevo).
  El fallo pinta un `v-alert` cerrable arriba del input (`data-testid=
  "chat-send-error"`) y conserva el texto; el aviso se limpia al volver a
  escribir o al reintentar. Los `data-testid` (`chat-input`, `chat-send`) están
  para las verificaciones en navegador.
- **Detalle que no es obvio:** con el backend caído, `fetch('/api/chat/send')`
  **no** rechaza — el proxy de Vite responde `500` sin JSON. De ahí que el aviso
  se derive de "respuesta sin JSON" y no solo del `TypeError` de red; con el
  `TypeError` a secas el usuario habría visto un mensaje vacío.
- **Imitador de Helix** (`backend/scripts/fake-helix-chat.js`,
  `npm --prefix backend run fake-helix-chat`): `POST /helix/chat/messages` con el
  contrato real (exige `client-id` y bearer, valida parámetros y el tope),
  mandos `/_fake/chat/sent`, `/_fake/chat/fail` (status a devolver),
  `/_fake/chat/drop` (`is_sent: false` con `drop_reason`) y `/_fake/chat/reset`.
  Monta `createFakeTwitchApp` **como fallback** (el truco de `fake-eventsub.js`:
  el 404 catch-all va al final), así que sirve de `TWITCH_AUTH_BASE_URL` y
  `TWITCH_API_BASE_URL` a la vez. Con `--eventsub <url>` además reenvía
  `POST /helix/eventsub/subscriptions` al imitador de EventSub y hace eco de cada
  mensaje aceptado por su mando `say` (el eco lleva un `message_id` propio del
  imitador, que no acepta uno de fuera; en Twitch real el id es el mismo).
  `rejected` en `/_fake/chat/sent` cuenta solo los rechazos por headers o
  parámetros inválidos, así que el gate puede exigir `rejected === 0`.
- **Verificado en Chrome real** (imitadores 4130/4131, backend 3006, frontend
  5179, 1280×720, 18 comprobaciones): input habilitado; Enter publica y el
  mensaje aparece en el panel viniendo de EventSub (`broadcaster_id ===
  sender_id === 900100200`), con el input limpio y sin aviso; Enter con el campo
  vacío y con `"     "` no llama a Helix (1 → 1 llamadas) ni borra lo escrito;
  un fallo de Twitch muestra el aviso rojo conservando el texto y sin pintar nada
  en el panel (la página sigue sin scrollear); reintentar con ese mismo texto lo
  publica y limpia el aviso; con el backend detenido el aviso dice "No se pudo
  contactar al backend (HTTP 500)…" y el texto sobrevive. Cero errores de consola.
- **Confirmación en vivo (pendiente, la hace el operador):**
  1. `backend/.env` completo como describe T-003 (sin descomentar ninguna
     `*_BASE_URL`) y sesión iniciada.
  2. `npm start` en la raíz y abrir `http://localhost:5173`.
  3. Escribir un mensaje en el input y presionar Enter: debe aparecer en el chat
     de Twitch (web o móvil) y en el panel izquierdo en menos de ~2 s, y el input
     quedar vacío. En `logs/` (o `npm run logs`): `chat: mensaje publicado en
     <login>`.
  4. Fallo real: `pm2 stop backend`, escribir y presionar Enter → aviso visible y
     el texto intacto; `pm2 start backend` y volver a presionar Enter → se
     publica.
  5. Descarte real (opcional): activar el modo solo-seguidores o "sin mensajes
     repetidos" en el chat y enviar dos veces lo mismo; el aviso debe mostrar el
     motivo que devuelve Twitch (`drop_reason`).

### T-007: Columna de usuarios híbrida

**Description:** Poblar la columna derecha con el modelo híbrido: el backend
consulta Get Chatters cada ~60 s (presentes aunque no escriban) y combina con
la actividad por mensaje; publica la lista por `/ws`. El frontend muestra los
usuarios ordenados por actividad reciente, distinguiendo visualmente quiénes
han hablado en la sesión, con estados persistidos (muted/ignored) visibles como
iconos. Al hacer clic en un usuario se abre su panel de acciones (las acciones
se implementan en T-011; aquí basta el contenedor con los datos del usuario).

**Acceptance Criteria:**

- [x] La columna derecha muestra a los presentes reportados por Get Chatters (poll ~60 s) aunque no hayan escrito.
- [x] Los usuarios que escriben aparecen/suben inmediatamente y se distinguen visualmente de los lurkers.
- [x] Los flags `muted`/`ignored` de SQLite se reflejan como iconos en la lista.
- [x] Clic en un usuario abre un panel/diálogo con su información (username, actividad, flags actuales).
- [x] Quality checks pass.
- [x] Verify in browser.

**Notas de implementación (T-007):** contrato de la columna de usuarios y los
puntos de enganche que T-011 necesita para añadirle las acciones.

- **Alcance de la verificación (importante):** como T-003 y T-004, todo se
  ejercitó contra **imitadores locales** (`backend/.env` sigue sin existir). Lo
  confirmado contra el endpoint real es solo el *contrato* de Get Chatters
  (parámetros, paginación y forma de la respuesta); la confirmación en vivo la
  hace el operador con los pasos de más abajo.
- **Gate nuevo:** `npm --prefix backend run test:chatters`
  (`scripts/smoke-chatters.js`, 15 comprobaciones). Levanta los dos imitadores y
  **el backend real** como proceso hijo, se conecta al `/ws` como el navegador y
  recorre poll → merge con SQLite → `users:list`: la paginación por cursor, la
  aparición instantánea de quien escribe, los flags, las entradas y salidas entre
  polls, el rechazo de Twitch (401 por scope) y el apagado con SIGTERM. No
  necesita `.env`, red ni puertos fijos, y no toca `backend/data/app.sqlite`.
  Comprobado con control negativo: al desactivar `relay.onMessage` y el aviso por
  conexión nueva, 5 de las 15 comprobaciones fallan.
- **Dónde vive el backend:**
  - `src/twitch/chatters.js` — `fetchChatters({ accessToken, broadcasterId })`
    sobre `helixRequest()`; **sigue el `pagination.cursor`** hasta traer el roster
    completo (Twitch pagina de 1000 en 1000) y deduplica ids entre páginas.
    `moderator_id` = broadcaster: en la fase 1 el streamer es su propio moderador
    y Twitch exige que ese id sea el usuario del token.
  - `src/users/presence.js` — `createUsersPresence({ hub, relay })`: el poll, el
    merge y la publicación. **No escribe en SQLite**: la actividad la persiste el
    relay de T-004 (`users.upsert()`), aquí solo se lee con `users.get()`.
  - `src/server.js` arranca el poller justo después de `chatRelay.start()` y lo
    para justo después de `chatRelay.stop()`. No hay rutas HTTP nuevas.
- **Trama que ya está fluyendo al frontend** (`USERS_LIST_TYPE` en
  `presence.js`, el mismo string que el store):
  `broadcast('users:list', { users, presentCount, activeCount, rosterAvailable, rosterFetchedAt, updatedAt })`,
  donde cada usuario es
  `{ userId, username, displayName, present, active, muted, ignored, volume, pitch, voiceId, voiceSource, firstSeenAt, lastActiveAt, known }`.
  - `present` — lo reportó Get Chatters en el último poll (incluye lurkers).
  - `active` — ha escrito desde que arrancó el backend; sube al instante.
  - `known` — tiene fila en `users`. **Un lurker que nunca escribió no la tiene**,
    así que T-011 debe hacer `users.upsert()` antes de guardarle una preferencia.
  - La lista viaja **ya ordenada** (activos por `lastActiveAt` desc, después los
    presentes por nombre): el frontend la pinta tal cual.
- **Cuándo se publica:** al terminar cada poll, al llegar un mensaje
  (`relay.onMessage`, agrupando ráfagas en una ventana de 120 ms) y **cuando un
  navegador se conecta al hub** (`hub.wss.on('connection')`), para que no espere
  hasta un minuto a ver la columna. Cada trama es un reemplazo completo, no un
  delta: el store no acumula nada.
- **Enganches para T-011:** `presence.refresh()` publica la lista con lo que ya se
  sabe (úsalo justo después de escribir una preferencia, para no esperar al poll)
  y `presence.refreshRoster()` fuerza una consulta a Twitch. En el frontend los
  controles van en el `v-card-actions` de
  `components/users/UserDetailDialog.vue`, operando sobre `props.user`; la trama
  siguiente refresca la vista sola, así que no hace falta estado local. Los
  iconos de los flags están centralizados en `USER_FLAG_ICONS`
  (`utils/user-format.js`).
- **Frontend:** `stores/users.js` (normaliza la trama y expone `useUsers()` +
  `selectUser`), `components/users/UsersPanel.vue` (rellena el hueco de T-005:
  encabezado con el contador `presentes · activos`, lista y estado vacío),
  `UserListItem.vue` y `UserDetailDialog.vue`. El feed se enciende y apaga con el
  propio panel (`startUsersFeed()` en `onMounted`), sin tocar `App.vue`.
  Distinción visual: el activo va con opacidad 1, nombre en negrita y con su color
  de chat (`userColor`) y el punto relleno; el lurker con opacidad 0.62, peso
  normal y el punto hueco.
- **Trampa de Vuetify:** `v-list-item` tiene una prop `title` propia, así que un
  `:title` pensado como tooltip **se pinta como texto duplicado** de la fila (se
  vio en la primera verificación en navegador). El tooltip nativo va en un `span`
  dentro del contenido.
- **Robustez:** si Get Chatters falla se **conserva** el último roster conocido
  (un error no significa que la sala se vació) y se reintenta en el ciclo
  siguiente; un rechazo permanente (401/403) se loguea una sola vez nombrando el
  scope `moderator:read:chatters`. Sin sesión no se consulta nada. El conjunto de
  activos está acotado a los 1000 más recientes.
- **Config nueva** (en `backend/.env.example`, no requerida):
  `TWITCH_CHATTERS_POLL_MS` (default **60000**, como pide el criterio; el gate usa
  un valor corto). El gate comprueba que el default siga siendo 60 s y que
  `apiBaseUrl` siga siendo el endpoint real.
- **Imitador de chatters** (`backend/scripts/fake-chatters.js`,
  `npm --prefix backend run fake-chatters`): sirve `GET /helix/chat/chatters` con
  la validación real (bearer, `client-id`, `broadcaster_id`, `moderator_id`,
  `first`, cursor) y los mandos `/_fake/chatters/set` (cambiar el roster: entradas
  y salidas), `/_fake/chatters/fail` (simular el 401 por scope) y
  `/_fake/chatters/stats`. Como `fake-eventsub.js`, **no edita** `fake-twitch.js`:
  monta sus rutas primero y delega el resto; con `forwardBaseUrl` reenvía lo que
  no implementa a otro imitador, así un solo `TWITCH_API_BASE_URL` cubre OAuth,
  `/helix/users`, las suscripciones de EventSub y los chatters.
- **Verificado en Chrome real** (imitadores en 4131/4132, backend 3007, frontend
  5180, poll de 4 s): los 4 presentes de Get Chatters visibles sin escribir
  (contador "4 · 0 activos"); un mensaje por EventSub pone a su autora en la
  primera fila **209 ms** después, en negrita, con su color y opacidad 1 frente a
  la 0.62 de los lurkers; `muted`/`ignored` escritos en SQLite aparecen como
  iconos en el poll siguiente; el clic abre el diálogo con `@login`, actividad,
  último mensaje, primera vez visto, volumen, pitch, voz y los chips de los flags;
  cambiar el roster hace entrar y salir usuarios, y quien habló se conserva como
  `present=false, active=true`; sin scroll horizontal a 1280×720, 1920×1080 ni
  414×800, y a 414 px el botón de la app bar abre la columna con la lista dentro.
  Cero errores de consola; SIGTERM cerró el backend con code 0.
- **Interacción con T-008, observada tras el merge (decisión para el operador):** T-008
  dejó de publicar trama `chat:message` para los usuarios `ignored`, pero mantiene la
  entrega por `relay.onMessage`, que es de donde el poller de presencia lee la
  actividad. Efecto observado: **un usuario `ignored` que escribe sigue subiendo a la
  primera fila de la columna como `active`, con su icono rojo de ignorado, aunque su
  mensaje no aparezca en el chat.** Comprobado con hub, relay y repositorios falsos
  sobre `createUsersPresence`: con un roster que no lo incluye, tras su mensaje la
  lista queda `ignorada (present=false, active=true, ignored=true) > lurker` y
  `activeCount: 1`. El upsert del relay ocurre **antes** de la decisión del pipeline,
  así que su `last_active_at` también se refresca (lo fija `test:tts`). **No se ha
  cambiado el comportamiento** porque el plan no lo especifica: se puede defender
  (saber quién está aunque no se le lea ni se le muestre) y también lo contrario
  (ocultarlo del todo, filtrando `ignored` en `buildUsers()` de `presence.js`, o no
  marcarlo como activo). Queda como decisión del operador; si se quiere ocultar, el
  cambio es de una línea en `presence.js` y toca la aserción de flags de
  `test:chatters`.
- **Confirmación en vivo (pendiente, la hace el operador):**
  1. Completar `backend/.env` como describe T-003 (sin descomentar ninguna
     `*_BASE_URL` ni `TWITCH_CHATTERS_POLL_MS`) e iniciar sesión. El scope
     `moderator:read:chatters` ya se pide; si la sesión es de antes hay que volver
     a autorizar para que Twitch lo conceda.
  2. `npm start` en la raíz y abrir `http://localhost:5173`.
  3. Esperado en la columna derecha: en menos de un minuto aparecen los
     espectadores presentes **sin que escriban** (contador `presentes · activos`);
     en `logs/` (o `npm run logs`) se ve `usuarios: N presentes en el chat`.
  4. Que alguien escriba en el chat: debe subir a la primera fila al instante, en
     negrita y con color; los lurkers quedan atenuados abajo.
  5. Clic en cualquier usuario: se abre su panel con la información.
  6. Marcar a alguien a mano
     (`sqlite3 backend/data/app.sqlite "UPDATE users SET muted = 1 WHERE username = '<login>';"`)
     y esperar el poll: debe aparecer el icono de mute en su fila.
  7. Si la columna se queda vacía y el log dice `Twitch rechazó Get Chatters …
     revisa el scope moderator:read:chatters`, hay que volver a pasar por
     `/auth/login` para conceder ese scope.

### T-008: Núcleo TTS — motor del navegador, cola y filtros

**Description:** Implementar el corazón del TTS: en backend, la interfaz
`TTSEngine`, el registro de motores y el pipeline que decide por mensaje si se
lee y con qué parámetros (aplicando filtros: usuarios ignorados/muteados,
mensajes que empiezan con `!`, bots conocidos como Nightbot/StreamElements, y
URLs reemplazadas por la palabra "enlace"); el mensaje publicado por `/ws`
lleva instrucciones TTS (`{ engine, voiceId, pitch, volume, text }` o `null`).
En frontend, el `BrowserEngine` con Web Speech API y la cola FIFO sin límite
con controles globales: saltar el actual, vaciar cola, pausar/reanudar, más un
indicador del tamaño de la cola.

**Acceptance Criteria:**

- [x] Cada mensaje no filtrado se lee en voz alta (Web Speech) con voz en español, leyendo solo el texto del mensaje (sin "usuario dice").
- [x] Mensajes que empiezan con `!`, de bots conocidos, o de usuarios muted/ignored NO se leen (pero los de muted sí se muestran en el chat; los de ignored no se muestran).
- [x] Las URLs dentro de un mensaje se leen como "enlace".
- [x] Ráfagas de mensajes se encolan en orden FIFO sin descartar ninguno; el indicador muestra el tamaño de la cola.
- [x] Los botones saltar/vaciar/pausar-reanudar funcionan durante la reproducción.
- [x] Quality checks pass.
- [x] Verify in browser.

**Notas de implementación (T-008):** los dos contratos sobre los que montan T-009,
T-010 y T-011, más el alcance real de lo verificado.

- **Alcance de la verificación (importante):** todo el comportamiento observable
  está comprobado de forma determinista (cola, indicador, controles, filtros), pero
  **que se oiga de verdad lo tiene que confirmar el operador con altavoces**: en
  Chrome headless `speechSynthesis.getVoices()` devuelve `0` voces y `speak()`
  responde `error: not-allowed`, así que no hay audio audible que medir. Ver
  "Confirmación en vivo" al final.
- **Gate nuevo:** `npm --prefix backend run test:tts` (`scripts/smoke-tts.js`, 36
  comprobaciones): ids de voz, la interfaz `TTSEngine`, el registro con su
  respaldo, los filtros uno a uno, el pipeline sobre una base SQLite temporal y la
  integración con el relay (con hub y provider falsos). No necesita `.env`, red ni
  puertos. `test:eventsub` sigue en 16/16 con una sola línea cambiada: la que fija
  las claves de la trama, que ahora se importa como `CHAT_MESSAGE_FRAME_FIELDS`.
- **La trama `chat:message` se enriqueció, no se duplicó** (`src/chat/relay.js`,
  `handleMessage`). Contrato exacto del payload:

  ```js
  { id, userId, username, displayName, text, timestamp,   // T-004, sin cambios
    tts: null | { engine, voiceId, pitch, volume, text } } // T-008
  ```

  - `tts.engine` — `'browser' | 'edge' | 'piper'`: quién debe reproducirlo.
  - `tts.voiceId` — id namespaced (`browser:Paulina`, `edge:es-MX-DaliaNeural`) o
    **`null` = "que el cliente elija su mejor voz en español"**.
  - `tts.pitch` 0–2 y `tts.volume` 0–1, ya recortados al rango de Web Speech.
  - `tts.text` — **solo el texto del mensaje** con las URLs sustituidas por
    "enlace". Nunca "usuario dice"; `payload.text` (lo que se muestra) no se toca.
  - `tts: null` = se muestra pero no se lee. **Un usuario `ignored` no genera
    trama en absoluto** (no se muestra ni se lee); `relay.onMessage()` sí lo
    entrega, así que T-012 sigue viendo esos mensajes.
- **Interfaz `TTSEngine` (backend, `src/tts/engine.js`).** Lo que distingue a un
  motor es **quién sintetiza**, no quién reproduce (todo el audio suena en el
  navegador): `kind: 'client'` (el navegador, no adjunta audio) o `kind: 'server'`
  (el backend sintetiza y adjunta). Métodos: `name` (= prefijo de sus ids de voz),
  `kind`, `isAvailable(): Promise<boolean>`, `listVoices(): Promise<TtsVoice[]>` y
  —solo los de servidor— `synthesize({ text, voiceId, pitch, volume }):
  Promise<TtsAudio>`, que **debe lanzar** si falla para que se pueda caer al
  navegador. `TtsVoice = { id, name, engine, language, label }`;
  `TtsAudio = { format, base64 }`. `assertTtsEngine()` valida el contrato al
  registrar, no en el primer mensaje.
- **Registro (`src/tts/registry.js`).** `getTtsRegistry()` es el registro del
  proceso; sumar un motor es **una línea** (`registry.register(createEdgeTtsEngine())`).
  Dos garantías: `resolve(voiceId)` es **sincrónico** (no llama a `isAvailable()`,
  que puede tocar red o disco) y **siempre devuelve un motor**: si la voz apunta a
  un motor no registrado cae a `browser` con `voiceId: null` y lo loguea una sola
  vez. Por eso la voz global sembrada (`edge:es-MX-DaliaNeural`) ya funciona hoy,
  leyéndose con el navegador, sin que T-009 exista.
- **Filtros (`src/tts/filters.js`), funciones puras y en este orden:** `ignored`
  (no se muestra) → `muted` (se muestra, no se lee) → `!comando` → bot conocido
  (`KNOWN_BOT_USERNAMES`: Nightbot, StreamElements y otros nueve, comparados en
  minúsculas contra el `username`; lista cerrada porque un heurístico tipo "acaba
  en bot" silenciaría a usuarios reales) → URLs → "enlace". El reemplazo de URLs
  acepta esquema, `www.`, dominio con TLD "seguro" (`twitch.tv`) y dominio con TLD
  ambiguo **solo con ruta** (`youtu.be/abc`); sin esa distinción, prosa española sin
  espacio tras el punto ("no me gusta.me da igual") se leería como "enlace".
- **La cola FIFO vive en el frontend** (`stores/tts-queue.js`) y **no descarta
  nunca**: no hay ningún `MAX_` ahí (a diferencia del store de chat, que recorta a
  500 mensajes en pantalla). Semántica de los controles, que conviene no cambiar:
  `skipCurrent()` corta y pasa al siguiente; `clearQueue()` es "silencio ya" (corta
  el actual **y** tira lo pendiente); `pause()`/`resume()` pausan lo que suena y
  dejan de arrancar nuevos, pero lo pendiente **sigue acumulándose**. El indicador
  cuenta pendientes + el que se está leyendo.
- **Motores de cliente (`frontend/src/tts/engine.js`).** Contraparte que reproduce:
  `{ name, isSupported(), speak(item, { onEnd, onError }) -> handle }` con
  `handle = { cancel(), pause?(), resume?(), voice? }`. `speak()` debe llamar
  **exactamente una vez** a `onEnd` o `onError` (la cola tolera que sea sincrónico).
  T-009/T-010 solo tienen que `registerTtsEngine({ name: 'edge', ... })` y
  reproducir `item.audio`; **la cola no cambia** y el orden FIFO entre motores
  mezclados sale gratis.
- **Quirks de Web Speech que ya están encapsulados** (`tts/browser-engine.js`): el
  catálogo llega tarde (`getVoices()` vacío en el primer tick), hay que **retener
  la utterance** o Chrome corta la frase a medias, `cancel()` también dispara `end`
  (guard para no avanzar dos veces), y hay un **watchdog de 4 s**: si la síntesis no
  arranca (sin voces instaladas, o headless) la cola avanza en vez de quedarse
  bloqueada para siempre. `cancel()` corta **antes** de resolver: al revés, el
  `onEnd` arrancaría el siguiente y el propio `cancel()` lo mataría.
- **Indicador de bloqueo:** si el navegador responde `not-allowed`, la cola marca
  `blocked` y el chip pasa a rojo con la explicación ("haz clic en la página…").
  Sin eso, el síntoma sería una cola que avanza en silencio sin pista alguna.
- **Enganches en la UI, mínimos:** `App.vue` solo **coloca**
  `components/tts/TtsQueueControls.vue` en el app bar; ese componente es el dueño
  del ciclo de vida de la cola (se suscribe al hub al montarse, la limpia al
  desmontarse), así que el layout de T-005 no se toca. El indicador de "leyéndose"
  va en el **contenido por defecto** del slot `trailing` de `ChatMessageItem.vue`
  (así `ChatPanel.vue` no tiene que pasar nada); quien pase el slot lo sustituye.
- **Diagnóstico en `window.__ttsHub`** (solo con `import.meta.env.DEV`): estado de
  la cola, registro ordenado de lo que se pidió hablar, los controles y
  `registerEngine()`. Es lo que permite verificar el TTS sin oírlo, y sirve también
  para probar el motor de T-009/T-010 sin credenciales.
- **Interacción con T-006, observada tras el merge (decisión para el operador):** el
  mensaje que el streamer envía con `POST /api/chat/send` vuelve por EventSub como
  cualquier otro, así que **pasa por el pipeline y se lee en voz alta** con la voz
  global. Verificado de punta a punta con los dos imitadores: `"hola chat, soy el
  streamer"` → `tts = { engine: 'browser', voiceId: null, pitch: 1, volume: 1 }`, y
  `"!comandos desde el streamer"` → `tts = null` (el filtro de comandos también le
  aplica). El canal recibe su fila en `users` como cualquier usuario, así que **ya se
  puede silenciar a uno mismo** poniéndole `muted` (la UI para hacerlo llega con
  T-011). **No se ha cambiado el comportamiento** porque el plan no lo especifica: si
  el operador prefiere no oír sus propios mensajes, lo más limpio es que T-011 marque
  `muted` al broadcaster por defecto, o que el pipeline compare el `userId` con
  `getChannel().id`. Queda como decisión del operador.
- **Huecos deliberados:**
  - **T-009 / T-010:** registrar el motor y, cuando `tts.engine !== 'browser'`,
    llamar a `engine.synthesize(tts)` y añadir `audio: { format, base64 }` a la
    instrucción antes de publicarla (o caer a `{ engine: 'browser', voiceId: null }`
    si falla). El shape de 5 claves no cambia: solo se le suma `audio`. `GET
    /api/voices` sale de `registry.listVoices()`, que ya agrega catálogos y aísla al
    motor que falle. El motor `browser` del backend devuelve `[]` a propósito: su
    catálogo real solo se conoce en el navegador (`listBrowserVoices()`).
  - **T-011:** todo cabe en `resolveVoiceParams()` de `src/tts/pipeline.js`. Hoy
    resuelve `user.voiceId ?? global_voice_id` y usa el `pitch`/`volume` guardados;
    falta leer `user.voiceSource` para la prioridad `override > command > global` y
    asignar el pitch aleatorio persistente (0.8–1.4) en el primer mensaje con
    `users.updatePreferences()`. Ojo: `users.pitch` y `users.volume` son NOT NULL en
    el esquema de T-002.
  - **T-012:** no cuelga del pipeline; los comandos siguen llegando por
    `relay.onMessage()` aunque no se lean.
- **Verificado en Chrome real** (imitador en puerto libre, backend 3008, frontend
  5181, 24 comprobaciones): ráfaga de 10 mensajes → los 10 encolados en orden FIFO
  con `enqueuedTotal = 10` y **cero descartes**, indicador a "10", el mensaje en
  curso marcado en su línea; fin de enunciado → entra el siguiente en orden;
  saltar → pasa al siguiente y el motor recibe `cancel()`; pausar → nada suena, no
  se arranca nada nuevo y los 7 pendientes siguen ahí; reanudar → continúa por
  donde iba; vaciar → 0 y silencio, y la cola sigue admitiendo mensajes después.
  Filtros con el imitador de EventSub: `!comandos` y Nightbot visibles y no
  leídos, `https://twitch.tv/alguien` leído como "mira esto enlace ahora" (en
  pantalla la URL se ve tal cual), usuario `muted` visible y no leído, usuario
  `ignored` **ausente del DOM**. Sin scroll horizontal a 1280×720, 1920×1080 ni
  414×800. Único aviso de consola: los `not-allowed` esperados sin audio.
- **Detalle de layout medido:** a 414 px los cuatro elementos nuevos aprietan el
  app bar y el título pasa de 112 px a 35 (nada se sale ni deja de funcionar; los
  controles van compactos bajo el breakpoint `md`). Si otra tarea añade más
  controles al app bar, toca agruparlos en un menú.
- **Confirmación en vivo (pendiente, la hace el operador — hace falta audio real):**
  1. Con `backend/.env` completo (pasos de T-003) y sesión iniciada, `npm start` y
     abrir `http://localhost:5173` **con altavoces o auriculares**.
  2. Escribir en el chat del canal: el mensaje debe **oírse** en español leyendo
     solo el texto. Si el chip de la cola aparece rojo, hacer clic en cualquier
     parte de la página (Chrome puede exigir una interacción antes de hablar).
  3. macOS trae voces en español instaladas; en **Windows 11** puede que no:
     Configuración → Hora e idioma → Voz → añadir voces de español. Sin ninguna voz
     en español, Web Speech leerá con la voz del sistema (o no leerá y el chip lo
     dirá) hasta que T-009 traiga edge-tts.
  4. Ráfaga real: pedir a varias personas que escriban a la vez y comprobar que se
     oyen todas, en orden, y que el número del chip baja de uno en uno.
  5. Probar los tres botones mientras suena algo: saltar corta y pasa al
     siguiente, vaciar deja silencio, pausar/reanudar corta y retoma.

### T-009: Motor edge-tts

**Description:** Implementar `EdgeTtsEngine` en el backend usando un paquete
npm de edge-tts: sintetiza el texto a audio con la voz/pitch indicados, y el
frontend reproduce ese audio dentro de la misma cola FIFO (un solo flujo de
audio mezclando motores). El catálogo de voces del motor (filtrado a español
por default) se expone junto con las demás en `GET /api/voices`. La voz global
default pasa a ser `edge:es-MX-DaliaNeural`.

**Acceptance Criteria:**

- [x] Un mensaje con voz `edge:*` se sintetiza en el backend y se reproduce en el navegador dentro de la misma cola que las voces del navegador (orden FIFO intacto entre motores mezclados).
- [x] `GET /api/voices` lista las voces de edge-tts en español con sus IDs namespaced (`edge:es-MX-DaliaNeural`, ...).
- [x] El pitch y el volumen por usuario se aplican a la síntesis/reproducción.
- [x] Si edge-tts falla (sin internet), el mensaje cae de vuelta al motor del navegador y se registra el error en logs sin romper la cola.
- [x] Quality checks pass.
- [x] Verify in browser.

**Notas de implementación (T-009):** el primer motor de servidor. Lo importante para
T-010 es la **capa de reproducción de audio de servidor** y la forma **genérica** de
`GET /api/voices`: las dos están escritas sin mencionar edge-tts y se reutilizan tal
cual registrando el motor de Piper.

- **Paquete elegido: `edge-tts-universal`, fijado en `1.4.0`** (sin `^`). Frente a
  `node-edge-tts` (la otra opción del plan) gana por tres razones concretas: (1)
  devuelve el audio **en memoria** (`Communicate.stream()` entrega buffers), mientras
  que `node-edge-tts` solo sabe escribir un archivo, lo que obligaría a gestionar
  temporales para algo que va a viajar por HTTP; (2) trae `listVoices()`, así que el
  catálogo de `GET /api/voices` es el **real** del servicio (322 voces, 45 en español)
  y no una lista copiada a mano; (3) va a la par del `edge-tts` de Python (rany2), la
  implementación de referencia del protocolo —incluida la firma `Sec-MS-GEC`/DRM que
  Microsoft exige—, que es lo que decide si el motor sigue funcionando el mes que
  viene. **Requiere internet en tiempo de ejecución** (es un servicio online, no pide
  credenciales).
- **Gate nuevo:** `npm --prefix backend run test:edge-tts` (`scripts/smoke-edge-tts.js`,
  **31 comprobaciones**). Los cuatro bloques: puro (pitch→Hz, ids, catálogo, almacén),
  registro+pipeline, rutas sobre Express real con motores falsos, y **red real**
  (MP3 de verdad contra Microsoft). Con `SKIP_NETWORK=1` corre solo lo determinista
  (25/25) y sirve en una máquina sin internet. Los seis gates anteriores siguen
  intactos (25/16/16/16/36/15).
- **La capa de audio de servidor es genérica (`src/tts/server-audio.js`) y sirve una
  URL, no base64.** T-008 había apuntado la vía directa —esperar la síntesis y
  publicar `audio: { format, base64 }`—, pero eso rompía dos criterios: (a) el **orden
  FIFO entre motores mezclados** (si la trama de un mensaje edge espera ~1 s y la de
  uno del navegador sale al instante, la segunda se lee antes), y (b) la **latencia
  del chat**, porque la trama es una sola para mostrar *y* para leer, así que retenerla
  retrasaría el mensaje en pantalla y un corte de internet congelaría el chat durante
  todo el timeout. La forma implementada:
  - `decide()` sigue siendo sincrónico; llama a `serverAudio.attach(messageId, tts)`,
    que **solo actúa si el motor resuelto es `kind: 'server'`**, **arranca** la síntesis
    sin esperarla y devuelve la instrucción con **una clave más**:
    `tts.audio = { url: '/api/tts/audio/<messageId>' }` (la decisión durable del plan
    admite «base64 o URL servida»). Las 5 claves de T-008 no cambian.
  - Efecto buscado: la síntesis va **por delante** (prefetch) y ocurre en paralelo con
    el enunciado anterior, así que cuando la cola llega al mensaje el audio ya está;
    y un fallo también se conoce por adelantado, sin gastar el timeout en serie.
  - El audio vive **en memoria**, indexado por id de mensaje, con tope (100 entradas)
    y TTL (10 min); no se persiste nada. `GET /api/tts/audio/:messageId` responde
    `200` + `Content-Type` del formato (`audio/mpeg`) y `Cache-Control: no-store`,
    `404` si no hay (o caducó) y `503` si la síntesis falló.
  - **Para T-010 el contrato es: registrar el motor con `kind: 'server'` y un
    `synthesize()` que devuelva `{ format, base64 }` o lance. Nada más.** No hay que
    tocar el pipeline, ni el relay, ni la ruta, ni la cola.
- **La reproducción en el frontend también es genérica**
  (`frontend/src/tts/server-audio-engine.js`): `createServerAudioEngine(name)` descarga
  `item.audio.url` (con `AbortSignal.timeout`), lo reproduce con un `HTMLAudioElement`
  sobre un `blob:` y avisa a la cola al terminar. Registrarlo es **una línea** en
  `ensureEngines()` de `stores/tts-queue.js` (`registerServerAudioEngine('edge')`); T-010
  añade `'piper'` ahí y ya. **La cola no se tocó**: `enqueueTts` ya copiaba `audio`
  desde T-008, y el orden FIFO entre motores sale del orden de llegada de las tramas.
- **Respaldo al motor del navegador, en el cliente y por enunciado.** Cualquier fallo
  —`503`, red caída, audio ilegible, o el navegador negándose a reproducir— hace que
  el motor de servidor delegue en el `BrowserEngine` **con la misma instrucción y sin
  perder el turno en la cola**. No hace falta reescribir el `voiceId`: `pickVoice()`
  ignora un id de otro namespace y elige la mejor voz en español. El error se registra
  **una sola vez, en el backend**, al arrancar la síntesis (`tts: el motor "edge" no
  pudo sintetizar el mensaje X (...); se leerá con el navegador`), y el cliente deja un
  `console.warn`. Deliberadamente **no** hay circuit breaker: si edge está caído, cada
  mensaje paga un `fetch` que falla rápido (la síntesis ya había fallado por
  adelantado). Si algún día molesta, el sitio es `attach()`.
- **Pitch en la síntesis, volumen en la reproducción.** El SSML de edge-tts quiere el
  pitch como desplazamiento en **Hz** (`/^[+-]\d+Hz$/`), así que `pitchToEdgeHz()`
  traduce el pitch 0–2 de Web Speech a 50 Hz por unidad, recortado a ±50 Hz (el rango
  0.8–1.4 que reparte T-011 cae en −10…+20 Hz: audible sin volverse metálico). El
  volumen **no** se manda en el SSML a propósito: se aplica exacto en el cliente
  (`audio.volume`), y mandarlo dos veces atenuaría dos veces. Un `<audio>` no puede
  cambiar el tono, de ahí el reparto.
- **`GET /api/voices` no menciona ningún motor**: sale de `registry.listVoices()`, que
  ya agrega catálogos y aísla al que falle. Respuesta
  `{ voices: [{ id, name, engine, language, label }], engines: [{ name, kind }] }`,
  ordenada **español primero**, luego por motor (orden de registro) y por id, para que
  el selector de T-011 la pinte tal cual. **Cuando T-010 registre Piper, sus voces
  aparecen solas** (comprobado en el gate: se registra un motor a mitad de la prueba y
  sus dos voces salen sin tocar la ruta); si Piper no está instalado, su catálogo sale
  vacío y el resto sigue. El catálogo de edge se filtra a español por default
  (`TTS_EDGE_VOICE_LANGS=es`, `*` para todas) y se **cachea** 6 h, devolviendo el último
  catálogo bueno si una recarga falla (mejor un catálogo viejo que un selector vacío).
- **La voz global default ya resuelve a edge:** `edge:es-MX-DaliaNeural` (sembrada por
  T-002) deja de caer al navegador en cuanto el motor se registra —una línea en
  `getTtsRegistry()`—. Verificado en el gate y en el navegador.
- **Variables nuevas, documentadas en `backend/.env.example`:** `TTS_EDGE_ENABLED`
  (default `true`; con `false` el motor **no se registra** y todo vuelve al
  comportamiento de T-008, que es lo que permite trabajar sin red),
  `TTS_EDGE_TIMEOUT_MS` (8000), `TTS_EDGE_PROXY` y `TTS_EDGE_VOICE_LANGS` (`es`).
  `TTS_EDGE_ENABLED: 'false'` se añadió al entorno del backend hijo en
  `smoke-eventsub`, `smoke-chat-send` y `smoke-chatters`: esos tres gates deben seguir
  siendo **herméticos** (sin red) y sus aserciones fijan `engine: 'browser'`.
- **Trampa pagada (importante para T-010):** el `connectionTimeout` del paquete **no
  cubre todos los caminos** — con un proxy inalcanzable la promesa se queda colgada
  **para siempre**. Por eso cada llamada va envuelta en un timeout propio que
  **rechaza**; y ese temporizador **no** se hace `unref()`, porque si no hay nada más
  pendiente en el bucle de eventos un temporizador sin referencia no llega a disparar
  (el apagado del backend fuerza la salida a los 5 s, así que no puede colgar nada).
- **Control negativo del gate (tres, uno de ellos encontró un falso verde):** (1)
  romper `pitchToEdgeHz` → fallan 2 comprobaciones; (2) que `attach()` no adjunte la
  URL → fallan 5; (3) no mandar el pitch al servicio → falla la comprobación del SSML.
  El control (1) reveló que la comprobación original «con otro pitch el audio no puede
  ser idéntico» **pasaba igual con el pitch roto**: el servicio devuelve bytes distintos
  en dos síntesis idénticas. Se sustituyó por una aserción determinista sobre lo que se
  le manda al servicio (`pitch: '+20Hz'`, y `volume: undefined`).
- **Verificado en Chrome real** (imitador de EventSub, backend 3009, frontend 5182, CDP
  9232, 9 comprobaciones, cero errores de consola): `GET /api/voices` desde la página
  devuelve **45 voces edge en español** (`edge:es-AR-ElenaNeural`, …) y los motores
  `browser/client` + `edge/server`; una ráfaga de 6 mensajes **alternando voz edge y
  voz del navegador** se encola en el orden exacto de llegada (`enqueuedTotal: 6`, cero
  descartes); el item de voz edge trae `audio.url` y el del navegador no; ese audio,
  pedido desde la página, son **13 104 bytes con `Content-Type: audio/mpeg` y cabecera
  `fff364`** (frame MPEG real, no un placeholder); con los motores reales un mensaje de
  voz edge **se reproduce hasta el evento `ended`** y la cola avanza (0 respaldos); el
  `<audio>` recibe `volume = 0.25`, la preferencia del usuario; y con una voz edge
  inexistente el backend loguea `no pudo sintetizar el mensaje … (No audio was
  received.)`, el cliente avisa `el backend respondió 503; se leerá con el navegador`,
  **el mensaje lo lee el navegador y la cola queda vacía**, leyendo el siguiente
  mensaje con edge otra vez. Sin scroll horizontal a 1280×720, 1920×1080 ni 414×800.
- **Límite honesto de la verificación:** en Chrome headless no hay audio audible (y Web
  Speech reporta 0 voces con `not-allowed`, ver notas de T-008). Lo comprobado
  programáticamente es que el backend sintetiza **bytes MP3 válidos**, que el
  `<audio>` los reproduce hasta `ended` con el volumen correcto y que el orden y el
  respaldo son los pedidos. **Que suene bien lo tiene que confirmar el operador con
  altavoces** (ver abajo). Nota práctica: la reproducción headless necesitó
  `--autoplay-policy=no-user-gesture-required`; en un Chrome normal el primer clic en
  la página desbloquea el audio, y el chip rojo de la cola (T-008) ya lo explica.
- **Huecos deliberados que quedan:**
  - **T-010:** registrar Piper (`kind: 'server'`) y `registerServerAudioEngine('piper')`
    en el frontend. Nada más de esta capa.
  - **T-011:** sigue todo en `resolveVoiceParams()`; el catálogo que necesita el
    selector ya existe en `GET /api/voices`, agrupable por `engine` y con `label` listo.
  - **T-013:** cambiar la voz global es escribir `app_settings.global_voice_id` con un
    id del catálogo; el registro lo resuelve al vuelo, sin reiniciar.
- **Confirmación en vivo (pendiente, la hace el operador — hace falta audio real):**
  1. Con `backend/.env` completo (T-003), `npm start` y abrir `http://localhost:5173`
     **con altavoces o auriculares**, e internet disponible.
  2. Escribir en el chat: debe oírse la voz **es-MX-DaliaNeural de Microsoft** (mucho
     más natural que la del navegador). Si suena la voz del sistema en vez de esa, casi
     seguro es que no hay internet: mirar el log (`npm run logs`), donde saldrá `no pudo
     sintetizar el mensaje …; se leerá con el navegador`.
  3. Comprobar el catálogo: `curl http://localhost:3000/api/voices | jq '.voices[0:5]'`.
  4. Prueba del respaldo sin desconectar nada:
     `sqlite3 backend/data/app.sqlite "UPDATE users SET voice_id='edge:es-XX-NoExiste', voice_source='override' WHERE username='<login>';"`
     → ese usuario debe seguir oyéndose, pero con la voz del navegador.
  5. Para trabajar sin internet: `TTS_EDGE_ENABLED=false` en `backend/.env`.

### T-010: Motor Piper

**Description:** Implementar `PiperEngine`: integración con el binario de Piper
y al menos dos modelos de voz en español (es_ES y es_MX), con detección de
plataforma (binario macOS para dev, Windows para producción) y un script de
setup documentado que descarga binario+modelos a una carpeta ignorada por git.
Las voces Piper aparecen en `GET /api/voices` y se reproducen por la misma
cola.

**Acceptance Criteria:**

- [x] Un script npm documentado (`npm run setup:piper`) descarga el binario correcto para el SO actual y al menos 2 modelos de voz en español a una ruta git-ignorada.
- [x] Un mensaje con voz `piper:*` se sintetiza localmente sin internet y se reproduce en la cola compartida.
- [x] `GET /api/voices` incluye las voces Piper instaladas; si Piper no está instalado, el resto del sistema funciona igual y las voces Piper simplemente no aparecen.
- [x] Funciona en macOS (verificado) y el mecanismo de selección de binario contempla Windows 11 (win_amd64).
- [x] Quality checks pass.
- [x] Verify in browser.

**Notas de implementación (T-010):** el cableado fue de dos líneas, como dejó
previsto T-009; el contenido real de la tarea es el **empaquetado
multiplataforma** y la **degradación limpia**.

- **Cableado, literalmente dos líneas** (nada de `pipeline.js`, `relay.js`,
  `server-audio.js`, `router.js` ni la cola): `registry.register(createPiperEngine())`
  en `getTtsRegistry()` y `registerServerAudioEngine('piper')` en `ensureEngines()`
  del store. `GET /api/voices` y `GET /api/tts/audio/:id` recogieron el motor solos.
  El registro va envuelto en `isPiperEnabled()` para que `TTS_PIPER_ENABLED=false`
  quite el motor del todo, igual que hace T-009 con edge.
- **Módulos nuevos:** `src/tts/piper-engine.js` (motor `kind: 'server'`),
  `src/tts/piper-install.js` (plataformas, rutas y qué hay instalado),
  `scripts/setup-piper.js` (el instalador) y `scripts/smoke-piper.js` (el gate).
- **Gate nuevo:** `npm --prefix backend run test:piper`. **45 comprobaciones con
  Piper instalado y 41 sin él** (las 4 del bloque real se omiten con un aviso y el
  gate pasa): eso es justo lo que hay que garantizar, porque el operador puede no
  correr nunca `setup:piper`. Con `SKIP_PIPER_REAL=1` se omite a mano. No necesita
  `.env`, red ni puertos fijos. Los siete gates anteriores siguen intactos
  (25/16/16/16/15/36/31).
- **El instalador: `npm --prefix backend run setup:piper`** (desde `backend/`,
  `npm run setup:piper`). Descarga a `backend/vendor/` —git-ignorado desde T-001— el
  binario de la plataforma actual y **dos voces en español**:
  `es_ES-davefx-medium` y `es_MX-ald-medium` (~60 MB cada una). Es idempotente
  (cada archivo se baja a `<nombre>.part` y se renombra al final; lo que ya está no
  se rebaja salvo `--force`), reporta porcentaje, tiene tope de tiempo por archivo,
  acepta `--voice=es_MX-claude-high` / `--only=…` (la ruta remota se **deriva** del
  nombre del modelo, así que vale cualquier voz del catálogo oficial) y **termina
  sintetizando una frase de verdad** para no dar por bueno un binario que no
  arranca. Descomprime con `tar`, que existe en macOS **y** en Windows 10/11
  (`System32\tar.exe`, bsdtar, que también abre `.zip`), con `Expand-Archive` de
  PowerShell como respaldo: cero dependencias npm nuevas y ningún comando de Unix.
- **Trampa gorda que hubo que resolver: los artefactos de macOS de la release están
  incompletos.** `piper_macos_aarch64.tar.gz` y `piper_macos_x64.tar.gz` (release
  `2023.11.14-2`, la última con binarios) **no traen las bibliotecas dinámicas**
  —`libespeak-ng.1.dylib`, `libpiper_phonemize.1.dylib`,
  `libonnxruntime.1.14.1.dylib`—: solo viene el `dSYM` de símbolos. `./piper --help`
  muere con `dyld: Library not loaded`. El instalador lo arregla descargando las
  mismas bibliotecas de la release del proyecto hermano `piper-phonemize`
  (`2023.11.14-4`) y copiándolas al lado del ejecutable (recreando los enlaces
  simbólicos en vez de seguirlos: si no, se duplicarían 46 MB de onnxruntime).
  **El artefacto de Windows sí trae sus DLL** (`espeak-ng.dll`, `onnxruntime.dll`,
  `piper_phonemize.dll`), así que la máquina de producción no necesita este paso.
- **Segunda trampa: el binario no tiene `LC_RPATH`.** Aun con las dylib al lado, dyld
  solo mira `/usr/local/lib` y `/usr/lib` (comprobado con `otool -l`). El motor lanza
  Piper con `DYLD_LIBRARY_PATH` = directorio del binario (`LD_LIBRARY_PATH` en Linux;
  en Windows no hace falta, el cargador mira junto al `.exe`). La alternativa
  (`install_name_tool -add_rpath`) exigiría Xcode y **volver a firmar** el binario en
  arm64: una variable de entorno no toca el artefacto descargado.
- **`--output_raw` + cabecera WAV propia.** Piper entrega PCM 16 bits mono por su
  salida estándar y el motor le pone los 44 bytes de cabecera; así no hay archivos
  temporales para algo que va a viajar por HTTP. `wav` ya estaba en
  `AUDIO_MIME_TYPES`, así que la ruta lo sirve como `audio/wav` sin cambios.
- **El pitch se consigue con la frecuencia de muestreo, compensando la velocidad.**
  Piper **no** tiene control de tono (a diferencia del SSML de edge-tts). Declarar
  `sampleRate × f` en la cabecera sube el tono un factor `f` pero acelera la voz;
  pedirle a Piper `length_scale × f` la devuelve a su ritmo. Recortado a
  0.75–1.35 (el rango 0.8–1.4 de T-011 cabe). Medido con Piper real: pitch 1.3 →
  frecuencia ×1.3 y duración a 0.89× de la original (el silencio final entre frases
  no se estira, de ahí el ~10 %). Barato, determinista y hace distinguibles a los
  usuarios; el volumen sigue aplicándose en el `<audio>` del cliente.
- **Degradación limpia (el criterio más importante), verificada de tres formas:**
  `listVoices()` devuelve `[]` si falta el binario **o** los modelos **o** si el
  motor está apagado —no lanza—, así que las voces `piper:*` no aparecen en
  `GET /api/voices` y todo lo demás sigue igual; solo `synthesize()` lanza (su
  contrato) nombrando `setup:piper`, y ese fallo hace que el enunciado lo lea el
  motor del navegador por el respaldo genérico de T-009. Comprobado en el gate
  (motor suelto, catálogo agregado y la ruta real) y **en el navegador** apuntando el
  backend a una carpeta de voces vacía.
- **El catálogo se reescanea cada 30 s**: correr `setup:piper` con el backend ya
  arriba hace aparecer las voces sin reiniciar nada.
- **IDs namespaced `piper:<modelo>`** (`piper:es_MX-ald-medium`), con `label` listo
  para el selector de T-011 (`ald (es-MX, medium)`). Una voz por archivo de modelo:
  los modelos multi-locutor se exponen solo con su locutor por defecto, porque el
  plan fija el id como `piper:<model>`.
- **Variables nuevas, documentadas en `backend/.env.example`:** `TTS_PIPER_ENABLED`
  (default `true`), `TTS_PIPER_DIR`, `TTS_PIPER_BIN` (para un Piper instalado por
  otra vía), `TTS_PIPER_VOICES_DIR` y `TTS_PIPER_TIMEOUT_MS` (20 000; la síntesis
  local de una frase tarda ~0.5 s). **Se leen en `src/tts/piper-install.js` y no en
  `src/config.js`**: T-010 corrió en paralelo con T-011 y `config.js` no era suyo.
  Es una desviación consciente de la convención de T-002; moverlas a `config.js`
  cuando no haya tareas en paralelo es un cambio mecánico.
- **Control negativo del gate (tres):** (1) quitar el factor de pitch de la
  frecuencia → fallan 2 comprobaciones (la del Piper falso y la del real); (2)
  anunciar voces sin binario → falla la de "con modelos pero sin binario"; (3)
  romper `piperSpawnEnv()` → fallan 6, **incluidas las 4 del bloque real**, que es
  la prueba de que ese bloque ejecuta el binario de verdad y no un placebo.
  Siguiendo la lección de T-009, lo que se fija del proceso externo son **los
  argumentos y la entrada** (un Piper de mentira los captura), no los bytes de audio.
- **Verificado en Chrome real** (imitador de EventSub, backend 3010, frontend 5183,
  CDP 9233, 9 comprobaciones, cero errores de consola inesperados): `GET /api/voices`
  desde la página devuelve **las dos voces piper en español** y el motor
  `piper/server`; una ráfaga de 6 mensajes **alternando voz Piper y voz del
  navegador** se encola en el orden exacto de llegada (`enqueuedTotal: 6`, cero
  descartes); los items de Piper traen `audio.url` y los del navegador no; ese audio,
  pedido desde la página, son **112 800 bytes `audio/wav` con cabecera RIFF/WAVE, 16
  bits y 26 460 Hz** (= 22 050 × el pitch 1.2 del usuario), 2.13 s reales; con los
  motores reales el enunciado **se reproduce hasta el final** y la cola queda vacía
  **sin un solo respaldo al navegador**; el volumen 0.3 del usuario llega a la
  reproducción. Sin scroll horizontal a 1280×720, 1920×1080 ni 414×800. En la fase de
  degradación (voces vacías) el catálogo pierde las voces piper, el mensaje **se ve**
  y lo lee el navegador, y el backend loguea una sola vez `no pudo sintetizar el
  mensaje … ; se leerá con el navegador`.
- **Límite honesto de la verificación:** en Chrome headless no hay audio audible. Lo
  comprobado programáticamente es que Piper produce **WAV válido y con contenido**,
  que el `<audio>` lo reproduce hasta `ended` con el volumen correcto y que el orden
  y el respaldo son los pedidos. **Que la voz suene bien lo confirma el operador con
  altavoces** (ver abajo). Tampoco se pudo ejecutar en Windows 11: lo verificado ahí
  es la **selección** del artefacto (`piper_windows_amd64.zip` + `piper.exe`) y que
  no hay rutas POSIX ni comandos de Unix; la corrida real la hace el operador.
- **Huecos deliberados:** T-011 y T-013 no cambian por esto (el catálogo ya trae las
  voces piper agrupables por `engine`); si alguna vez se quiere elegir locutor dentro
  de un modelo multi-locutor, el sitio es `pickPiperModel()` + `--speaker`.
- **Confirmación en vivo (la hace el operador — hace falta audio real):**
  1. `npm --prefix backend run setup:piper` (~150 MB; en macOS baja además las
     bibliotecas que le faltan al artefacto). Debe terminar con "síntesis de prueba".
  2. `npm start`, abrir `http://localhost:5173` **con altavoces**, y asignarse una voz
     Piper: `sqlite3 backend/data/app.sqlite "UPDATE users SET voice_id='piper:es_MX-ald-medium', voice_source='override' WHERE username='<login>';"`
  3. Escribir en el chat: debe oírse la voz **local** (sin internet). Prueba real de
     que es local: desconectar la red y volver a escribir.
  4. `curl http://localhost:3000/api/voices | jq '[.voices[] | select(.engine=="piper")]'`.
  5. **En Windows 11**, los pasos exactos: (a) `npm install` y
     `npm --prefix backend run setup:piper` en PowerShell —usa `tar.exe` del sistema,
     no hace falta 7-Zip ni build tools—; (b) si Defender/SmartScreen bloquea
     `vendor\piper\piper.exe`, permitirlo una vez (es un binario descargado y sin
     firmar) o excluir la carpeta `backend\vendor`; (c) `npm start` y comprobar
     `http://localhost:3000/api/voices`; (d) si el antivirus no deja ejecutarlo,
     `TTS_PIPER_ENABLED=false` en `backend/.env` devuelve el sistema al estado
     anterior sin tocar código.

### T-011: Modelo de voz/pitch y acciones por usuario

**Description:** Implementar el modelo completo de resolución de voz (prioridad
`override` → `command` → global) y las acciones por usuario en la UI: en el
primer mensaje de un usuario se le asigna pitch aleatorio persistente
(0.8–1.4); el panel de usuario (de T-007) gana controles funcionales de mutear
TTS, volumen individual, ignorar, asignar voz (selector alimentado por `GET
/api/voices`, agrupado por motor, español primero) y ajustar pitch. Asignar
voz desde este panel marca `voice_source = override`. Todos los cambios
persisten en SQLite y aplican al siguiente mensaje del usuario.

**Acceptance Criteria:**

- [x] El primer mensaje de un usuario nuevo le fija un pitch aleatorio en [0.8, 1.4] que persiste entre reinicios y es audiblemente estable en sus mensajes.
- [x] La resolución de voz respeta la prioridad: override del streamer > voz de comando > voz global; verificable con un usuario en cada estado.
- [x] Cambiar la voz global afecta solo a usuarios sin override ni voz de comando, y el pitch individual de todos se conserva.
- [x] Mutear, volumen, ignorar, voz y pitch desde el panel de usuario persisten en SQLite y aplican al siguiente mensaje sin reiniciar.
- [x] Quality checks pass.
- [x] Verify in browser.

**Notas de implementación (T-011):** el modelo de voz/pitch queda cerrado y con un
solo dueño; lo que sigue (T-012 y T-013) solo **escribe** en él por los enganches de
más abajo.

- **Todo el modelo vive en `src/tts/voice-model.js`** (nuevo). Es la única fuente de
  la prioridad y del pitch, y no depende de Express ni de SQLite: `resolveUserVoice`,
  `voiceLevelOf`, `randomUserPitch`, `isRandomPitchInRange`, `canAssignVoice` y
  `assignUserVoice`. `resolveVoiceParams()` del pipeline —el hueco que dejó T-008—
  ahora es una línea que llama a `resolveUserVoice(user, settings.getGlobalVoiceId())`.
- **Lectura de la voz:** si el usuario tiene `voice_id`, se usa esa; si no, la global.
  `voice_source` distingue los niveles (`override` = 1, `command` = 2, NULL = 3) y es
  lo que gobierna las **escrituras**. Una fila con `voice_id` pero sin `voice_source`
  (solo alcanzable editando SQLite a mano, p. ej. el paso 4 de la confirmación en vivo
  de T-009) se respeta y se trata como nivel 2, así que un override la puede pisar.
- **El pitch se asigna al INSERTAR la fila, no en el pipeline.** T-008 había apuntado
  a `updatePreferences()` dentro de `resolveVoiceParams()`, pero eso no se puede hacer
  bien: `users.pitch` es `NOT NULL DEFAULT 1`, así que **no existe ningún valor que
  signifique "todavía sin asignar"** y sería imposible distinguir "nunca se le asignó"
  de "el streamer lo dejó en 1.00". Como `users.upsert()` de T-002 aplica el `pitch`
  **solo en la inserción**, basta pasarlo ahí: el relay lo hace en el primer mensaje
  (una línea en `handleMessage`) y el panel en `users.ensure()` si la fila nace antes
  de que el usuario escriba. El pipeline sigue siendo **de solo lectura**.
  - Consecuencia para bases anteriores a esta tarea: las filas ya creadas se quedaron
    con `pitch = 1`. Se arreglan desde la UI con el **dado** («rodar un tono nuevo»),
    que es también el motivo de que ese botón exista.
  - Ojo al escribir pruebas: **1.00 es un resultado legítimo** del sorteo (61 valores
    posibles con 2 decimales), así que ninguna aserción puede exigir `pitch !== 1`
    para un solo usuario; el gate lo comprueba sobre un grupo de ocho.
- **`users.ensure()`** (nuevo en el repositorio de T-002) crea la fila de un presente
  que **nunca ha escrito** —la columna de T-007 los trae con `known: false`— sin pisar
  nada si ya existía y con `last_active_at = 0`, para no inventarle actividad (la UI
  lo sigue mostrando como "todavía no ha escrito"). Para el camino de un mensaje el
  correcto sigue siendo `upsert()`, que **sí** refresca la actividad.
- **Ruta nueva: `PATCH /api/users/:userId/preferences`** (`src/users/router.js`, con la
  lógica en `src/users/preferences.js` para poder probarla sin HTTP). Acepta cualquier
  subconjunto de `{ muted, ignored, volume, pitch, voiceId, rerollPitch, username,
  displayName }` y devuelve `200 { user }` con **las mismas claves con las que cada
  usuario viaja en `users:list`**, para que el frontend lo mezcle sin esperar el poll.
  Decisiones que conviene no cambiar:
  - **`voiceSource` no se acepta del cliente**: esta ruta es el panel del streamer, así
    que el servidor escribe `override` (o NULL al quitar la voz). Mandarlo da 400.
  - **El `voiceId` no se valida contra el catálogo**: el registro ya cae al navegador si
    la voz no existe (garantía de T-008), y así guardar una preferencia no depende de
    que `GET /api/voices` responda.
  - `volume`/`pitch` se redondean a 3 decimales (los pasos del slider producen
    `0.8999999999999999`) y **`null` en esos dos es un error**, no "sin valor":
    ambas columnas son `NOT NULL` (la advertencia de T-008, confirmada).
  - Aplica al siguiente mensaje **sin reiniciar** porque el pipeline lee `users` en cada
    mensaje: no hay caché que invalidar.
- **Enganche para T-012:** `assignUserVoice(users, id, { voiceId, source: 'command' })`.
  Devuelve `{ applied, reason, user }` y ya respeta la regla del plan: con
  `voice_source = 'override'` responde `applied: false, reason: 'override_wins'` y no
  escribe nada. Si el usuario no tiene fila, `reason: 'unknown_user'` (hay que
  `users.ensure()` antes). El nivel `command` está implementado y cubierto por el gate,
  así que T-012 solo tiene que detectar el comando y llamar a esta función.
- **Enganche para T-013:** cambiar la voz global sigue siendo escribir
  `app_settings.global_voice_id` (`settings.set(SETTING_KEYS.globalVoiceId, id)`); no
  hay nada más que tocar, y el efecto está fijado por el gate y verificado en el
  navegador: solo se mueven los usuarios de nivel 3 y **ningún pitch cambia**.
- **Frontend:** `stores/voices.js` (catálogo, nuevo) y
  `components/users/UserActions.vue` (nuevo) dentro del `v-card-text` del
  `UserDetailDialog.vue` de T-007. El componente no guarda estado propio: pinta desde
  `props.user` y escribe con `saveUserPreferences()` del store de usuarios, que mezcla
  la fila devuelta (`applyStoredPreferences`) y deja que la trama siguiente —la
  autoridad— confirme. Si una escritura falla, el control **vuelve** al valor guardado
  y el aviso queda a la vista.
  - **Selector de voz:** sale tal cual de `GET /api/voices` (español primero), agrupado
    por motor con cabeceras `v-list-subheader` y "Voz global del canal" como primer
    item; **no hay ninguna lista de voces escrita a mano**, así que las voces de Piper
    aparecerán solas cuando T-010 registre el motor. Al catálogo del servidor se le
    suman las voces locales de Web Speech (`listBrowserVoices()`), que el backend no
    puede conocer y devuelve `[]` a propósito. Si el usuario tiene una voz que no está
    en el catálogo, se añade un item para que el selector no quede en blanco.
  - **Trampa de Vuetify pagada:** `v-slider` emite `end` **solo con ratón o dedo**, así
    que con `@end` como única vía mover el slider con el **teclado** no guardaba nada.
    Se guarda con `@end` (inmediato) **y** con `@update:model-value` tras 350 ms, que
    además colapsa el arrastre en una sola petición.
  - El slider de pitch va de 0.5 a 1.5 (paso 0.05) para no llegar a lo irreconocible,
    aunque la API acepta el 0–2 de Web Speech; el rango del sorteo sigue siendo
    0.8–1.4. A menos de ~760 px de alto la tarjeta del diálogo **scrollea por dentro**
    (comportamiento normal de `v-dialog`), así que el botón «Cerrar» se alcanza
    bajando; a 414×800 entra completa.
- **Gate nuevo:** `npm --prefix backend run test:voice-model`
  (`scripts/smoke-voice-model.js`, **43 comprobaciones**, hermético: base SQLite
  temporal, hub y provider falsos, Express en el puerto 0; sin `.env`, sin red y sin
  puertos fijos). Cubre los cuatro criterios, incluido un **reinicio de verdad** (se
  cierra y se reabre el archivo SQLite) y el enganche de T-012. Los siete gates
  anteriores siguen intactos (25/16/16/16/15/36/31).
  - **Control negativo (tres):** (1) que `resolveUserVoice` ignore la prioridad → fallan
    8; (2) que el relay no reparta pitch aleatorio → fallan 2; (3) que el panel no
    marque `voice_source = 'override'` → fallan 3.
- **Verificado en Chrome real** (imitadores en puertos libres, backend 3011, frontend
  5184, CDP 9234, **19 comprobaciones**, cero errores de consola): `GET /api/voices`
  devuelve **45 voces edge en español** y el selector las pinta agrupadas bajo la
  cabecera del motor con «Voz global del canal» primero; los tres usuarios que
  escriben reciben **pitch distintos dentro de [0.8, 1.4]** en su primer mensaje
  (0.9 / 1.15 / 1.07 en esa corrida); elegir «Marcelo (es-BO, hombre)» deja la fila
  «Voz» en `edge:es-BO-MarceloNeural (asignada por ti)` y **el mensaje siguiente se lee
  con esa voz**; mutear deja el mensaje visible y **sin leer**, y desmutear lo vuelve a
  leer; bajar el volumen **con el teclado** llega al audio (90 % → `volume 0.9`); el
  dado cambia el tono (0.90 → 1.20) y así se lee; ignorar lo saca del chat y de la
  cola; todo eso queda escrito en SQLite (lo comprueba otro proceso); y **cambiar
  `global_voice_id` mueve solo al usuario de nivel 3** (a `edge:es-CO-SalomeNeural`)
  dejando el override intacto y **los tres pitch iguales**. Sin scroll horizontal a
  1280×720, 1920×1080 ni 414×800.
- **Interacción con T-010 (Piper), verificada tras el merge de `main`:** con los tres
  motores registrados, `GET /api/voices` devuelve **47 voces** (`edge: 45, piper: 2`;
  el catálogo de `browser` solo existe en el navegador) y el selector las agrupa **sin
  tocar código**, solo con lo que informa el backend: cabeceras «Microsoft edge-tts ·
  45» y «Piper (local) · 2», con `piper:es_ES-davefx-medium` y
  `piper:es_MX-ald-medium` bajo la suya. T-010 normaliza el idioma de Piper (`es_ES` →
  `es-ES`), así que entra igual en el orden "español primero" del backend. Comprobado
  de punta a punta en Chrome real (**8 comprobaciones**, con los artefactos de Piper
  presentes): asignar `piper:es_ES-davefx-medium` desde el panel lo guarda con
  `voice_source = 'override'`, **el mensaje siguiente se lee con Piper**, su audio sale
  por la ruta genérica de T-009 (`200 audio/wav`) y la cola avanza hasta terminar el
  enunciado; el usuario sin voz propia sigue con la voz global de edge.
  - **Detalle de UI que conviene saber:** el menú de `v-select` **virtualiza**, así que
    con 47 voces el grupo del último motor (Piper) no está en la ventana inicial y se
    alcanza **scrolleando** el menú hasta el final. Se probó cambiarlo por
    `v-autocomplete` para poder filtrar y **se revirtió**: su caja de texto contiene el
    título de la voz ya elegida y lo que se escribe **se añade** a ese texto
    («Voz global del canalpiper»), así que el filtro no encuentra nada hasta que el
    usuario borra a mano. Hacerlo bien pide `v-model:search` vaciándose en
    `@update:menu`; es la mejora natural si el catálogo sigue creciendo, y no se hizo
    ahora para no dejar un control a medias sin verificar.
- **Límite honesto:** como en T-008 y T-009, en Chrome headless no hay audio audible;
  lo comprobado es que la **instrucción** (voz, pitch, volumen) es la correcta en cada
  mensaje. Que dos usuarios con la misma voz suenen distinto por el pitch lo confirma
  el operador con altavoces (paso 3 de abajo).
- **Dos comportamientos que NO se cambiaron** (siguen esperando decisión del operador,
  como los dejaron T-007 y T-008): el streamer **sí** se oye a sí mismo (no se marca
  `muted` al broadcaster por defecto) y un usuario `ignored` que escribe **sigue
  apareciendo como activo** en la columna. Con esta tarea las dos cosas ya se pueden
  cambiar desde la UI en un clic, que era lo que faltaba para decidir con la app
  delante.
- **Pendiente deliberado (fuera del territorio de esta tarea):** tras un `PATCH` la
  columna se actualiza con la fila que devuelve la respuesta, no con una trama nueva;
  el enganche que T-007 dejó para eso (`presence.refresh()`) vive en la instancia que
  crea `src/server.js`, y llegar a ella pedía tocar `server.js`/`presence.js`, ajenos a
  esta tarea. Efecto práctico: otro navegador abierto a la vez vería el cambio en el
  poll siguiente (≤60 s) o en cuanto alguien escriba. Si se quiere inmediato, es
  registrar la instancia de presencia en un accesor de módulo y llamar a `refresh()`
  al final del handler del router.
- **Confirmación en vivo (pendiente, la hace el operador — hace falta audio real):**
  1. Con `backend/.env` completo (T-003) y sesión iniciada, `npm start` y abrir
     `http://localhost:5173` con altavoces.
  2. Clic en un usuario de la columna: mover **Volumen** y **Pitch**, y elegir una voz
     del selector. Su siguiente mensaje debe sonar con eso, sin reiniciar nada.
  3. Que escriban dos personas distintas sin voz asignada: deben oírse con la **misma
     voz** (la global) pero con **tono distinto**; el panel muestra el pitch de cada una.
  4. Activar «Silenciar el TTS» en alguien: su mensaje siguiente se ve y no se oye.
     Activar «Ignorar»: no se ve ni se oye.
  5. El **dado** junto al pitch rueda un tono nuevo en [0.8, 1.4]; útil para los
     usuarios que ya existían antes de esta versión (todos tenían pitch 1.00).

### T-012: Comando !cambia-mi-voz

**Description:** Implementar el comando de chat `!cambia-mi-voz`: cuando
cualquier usuario lo escribe, el backend le asigna una voz aleatoria en español
del catálogo completo (todos los motores), persistida con `voice_source =
command`, sin cooldown. El comando no se lee por TTS (ya filtrado por empezar
con `!`) y no debe pisar un override del streamer.

**Acceptance Criteria:**

- [x] Un usuario que escribe `!cambia-mi-voz` recibe una voz aleatoria en español distinta a su voz actual, aplicada desde su siguiente mensaje y persistida.
- [x] Repetir el comando vuelve a rodar la voz sin límite de frecuencia.
- [x] Si el streamer le había fijado un override, el comando NO lo cambia (el override gana).
- [x] El mensaje del comando aparece en el chat pero no se lee por TTS.
- [x] Quality checks pass.
- [x] Verify in browser.

**Notas de implementación (T-012):** el comando quedó en **un módulo propio** y no
tocó ni el pipeline ni el frontend; los enganches que dejaron T-004, T-008 y T-011
alcanzaron tal cual.

- **Todo vive en `src/chat/commands.js`** (nuevo): `parseChatCommand`,
  `pickRandomSpanishVoice`, `isSpanishVoice`, `VOICE_ROLL_COMMAND`,
  `COMMAND_OUTCOMES` y `createChatCommands({ repositories, registry, random })`.
  Añadir un comando nuevo es una entrada más en el `Map` de `handlers`.
- **Escribe la voz solo por `assignUserVoice()`** (T-011): la regla "el override del
  streamer gana" no se reimplementa. Antes de salir a pedir el catálogo se consulta
  `canAssignVoice(user.voiceSource, 'command')`, así que con un override el comando
  **no toca la base y ni siquiera pide el catálogo** (solo lo registra en el log).
- **El sorteo sale del registro de motores** (`registry.listVoices()`, la misma
  fuente que `GET /api/voices`), filtrando por `isPreferredLanguage` (español) — se
  reutiliza el helper de T-009, no hay ninguna lista de voces escrita a mano. En la
  verificación el catálogo real fueron **47 voces** (45 edge + 2 Piper) y una de las
  tiradas cayó justamente en una voz `piper:`, así que "todos los motores" es real.
- **La voz nueva se excluye de la actual** (`resolveUserVoice(user, global).voiceId`:
  la suya si tiene, la global si no), para que la tirada siempre se note. Si el
  catálogo no ofrece alternativa en español no se escribe nada (`no_voices`).
- **Sin cooldown**, que es lo que pide el plan: no hay estado por usuario, así que
  repetir el comando siempre rueda. Si algún día se quiere limitar, el sitio es
  `rollVoice()` en ese módulo.
- **Enganche en el relay:** `createChatRelay()` construye los comandos con sus
  mismos `repositories` y los invoca **después** de publicar la trama, sin esperar
  la promesa (el catálogo puede tocar red). Consecuencias:
  - un comando **nunca retrasa** lo que se ve en el chat;
  - `commands: false` desactiva el enganche (lo usan las pruebas), y `getStatus()`
    suma `commandsApplied`;
  - construir el relay **no** construye motores TTS: `getTtsRegistry()` se resuelve
    en el primer comando, así que los gates herméticos siguen sin red.
- **El mensaje del comando no se lee y no hizo falta código**: el filtro de T-008 lo
  salta por empezar con `!` (`TTS_SKIP_REASONS.command`), y como `relay.onMessage()`
  entrega igual, también funciona para un usuario `muted` o `ignored`. Ambas cosas
  están fijadas por el gate.
- **Si el usuario no tiene fila** (su primer mensaje es el comando), se crea con
  `users.ensure()` y pitch aleatorio del modelo, igual que hace el relay al insertar.
- **Nada de rutas HTTP nuevas ni cambios en el frontend.** El panel del usuario ya
  sabía pintar `voice_source = 'command'` («elegida con !cambia-mi-voz», de T-011).
  Detalle observado: la fila de la columna de usuarios se actualiza con el siguiente
  `users:list` (poll de Get Chatters o el mensaje siguiente), no en el instante del
  comando; no se publica ninguna trama extra a propósito, para no tocar `presence.js`.
- **Gate nuevo:** `npm --prefix backend run test:chat-command`
  (`scripts/smoke-chat-command.js`, **35 comprobaciones**, hermético: base SQLite
  temporal, hub/provider falsos y registro de motores de juguete; sin `.env`, sin red
  y sin puertos). Cubre los cuatro criterios, incluido un reinicio real de la base.
  - **Control negativo (cuatro):** (1) no excluir la voz actual → fallan 6; (2)
    escribir `voice_source = 'override'` en vez de `'command'` → fallan 13; (3) meter
    un cooldown de 10 s → fallan 7; (4) quitar el filtro de español → fallan 3.
  - Los nueve gates anteriores siguen verdes (25/16/16/16/15/36/31/45/43).
- **Verificado en Chrome real** (imitadores en puertos libres, backend 3012, frontend
  5185, CDP 9235, **20 comprobaciones**, 2 mensajes de consola y ningún error): el
  mensaje `!cambia-mi-voz` **se ve en el chat y no entra en la cola de lectura** (9
  comandos en pantalla, 0 leídos); Rita pasa de la voz global a
  `edge:es-CU-BelkysNeural` y su **mensaje siguiente** se lee con ella; el panel
  muestra «Belkys (es-CU, mujer) · elegida con !cambia-mi-voz»; cuatro tiradas
  seguidas dan cuatro voces distintas (Belkys → Mateo → Catalina → Alonso) y una
  ráfaga de tres comandos se atiende entera (sin rate limit); con un override puesto
  desde el panel (`edge:es-AR-TomasNeural`) el comando **no cambia nada** y el
  mensaje siguiente se sigue leyendo con esa voz; al quitar el override, el comando
  vuelve a rodar (le salió `piper:es_ES-davefx-medium`). Sin scroll horizontal a
  1280×720 ni a 414×800 (esta tarea no añade UI).
- **Confirmación en vivo (pendiente, la hace el operador — hace falta audio real):**
  con `backend/.env` y sesión iniciada, escribir `!cambia-mi-voz` en el chat de
  Twitch y comprobar que el mensaje siguiente **se oye con otra voz**; repetirlo
  varias veces seguidas (no hay límite); y con una voz fijada desde el panel,
  comprobar que el comando no la cambia.

### T-013: Ajustes globales y toggle de tema

**Description:** Crear el panel de ajustes globales: selector de la voz global
(catálogo completo agrupado por motor, español primero), volumen maestro del
TTS, y toggle claro/oscuro (oscuro default) — todo persistido en
`app_settings` y aplicado en vivo sin recargar.

**Acceptance Criteria:**

- [x] El selector de voz global cambia la voz de los usuarios sin override/comando desde el siguiente mensaje, sin reiniciar.
- [x] El volumen maestro escala el volumen de toda la reproducción TTS.
- [x] El toggle claro/oscuro cambia el tema en vivo y la preferencia sobrevive recargas y reinicios (persistida en `app_settings`).
- [x] Quality checks pass.
- [x] Verify in browser.

**Notas de implementación (T-013):** la última tarea del plan. No hubo que tocar
nada del modelo de voz ni de la cola: los tres ajustes se montaron sobre los
enganches que dejaron T-009 y T-011, y el único cálculo nuevo del sistema es la
multiplicación del volumen maestro.

- **Los ajustes son una ruta REST nueva y nada más** (`src/settings/`):
  `GET /api/settings` y `PATCH /api/settings`, montadas con **una línea** en
  `app.js`. La lógica vive en `src/settings/settings.js` (sin Express, para poder
  probarla sin HTTP, como hizo T-011 con `users/preferences.js`) y el router solo
  traduce a códigos de estado. Respuesta de las dos:
  `{ settings: { globalVoiceId, theme, masterVolume } }`; los fallos de validación
  son `400 { error, code }` con `code` ∈ `invalid | out_of_range | unknown_key |
  empty`. **No pide sesión de Twitch**: el tema tiene que valer también en la
  pantalla de login.
- **Clave nueva en `app_settings`: `tts_master_volume`** (número 0–1, redondeado a
  3 decimales). **No se siembra** en `migrations.js` a propósito: su default vive
  en `src/settings/settings.js` (`DEFAULT_MASTER_VOLUME = 1`), así que una base
  creada antes de esta versión funciona sin migración de datos. Las otras dos
  claves son las que ya sembraba T-002 (`global_voice_id`, `theme`), leídas por los
  accesores del repositorio. **No se añadió ninguna variable de entorno**, así que
  `.env.example` no cambia.
- **Cambiar la voz global es escribir `global_voice_id`, exactamente como dijo
  T-011.** El pipeline la relee en cada mensaje, así que el cambio aplica **desde
  el mensaje siguiente y sin reiniciar**, mueve solo a los usuarios de nivel 3 y no
  toca ningún pitch. Aquí no se duplicó nada de `voice-model.js`. El `voiceId`
  **no** se valida contra el catálogo (misma razón que T-011: el registro ya cae al
  navegador si la voz no existe, y guardar no debe depender de `GET /api/voices`);
  lo que **sí** se rechaza es `null`, porque siempre hay una voz global.
- **Leer nunca falla:** un valor imposible en la base (editada a mano, o de una
  versión anterior) se lee como su default en vez de reventar. Un `theme` corrupto
  no puede dejar la UI sin tema.
- **El volumen maestro se aplica en la cola, no en el backend**
  (`frontend/src/stores/tts-queue.js`): el backend manda el volumen **individual**
  en la instrucción y la cola lo multiplica por el maestro al **arrancar cada
  enunciado** (`effectiveVolume()`), no al encolar. Consecuencias buscadas: un
  cambio del maestro se nota en vivo desde el enunciado siguiente sin recargar ni
  vaciar la cola, y lo que ya está sonando conserva su volumen (los motores fijan
  el volumen del `<audio>` o de la utterance al empezar; cambiarlo a media
  reproducción pediría tocar los motores, que son de T-009/T-010). El registro de
  diagnóstico de cada enunciado ahora lleva `volume` (el efectivo), `userVolume` y
  `masterVolume`, y `window.__ttsHub.state` expone `masterVolume`.
- **El tema no toca `plugins/vuetify.js`:** `defaultTheme: 'dark'` sigue siendo el
  arranque (el mismo default del backend, para que no parpadee mientras responde
  `GET /api/settings` ni cambie de aspecto si esa petición falla) y `App.vue` lo
  aplica en vivo con `theme.change(name)` mirando el store. Añadir un tema nuevo
  implica ampliar `THEMES` en los dos lados (backend y store).
- **Acceso desde el app bar: un menú de overflow**, como pidió T-008 al medir que
  sus cuatro controles dejaban el título en 35 px a 414 px. El botón nuevo
  (`mdi-dots-vertical`) **sustituye** al de la columna de usuarios por debajo del
  breakpoint `md` (ahí la columna se abre desde el menú), así que en pantalla
  pequeña el app bar **no gana ancho**: medido, el título sigue en 35 px a 414 px y
  el app bar no desborda (`scrollWidth === clientWidth`). A `md` y más el botón de
  usuarios sigue siendo directo.
- **El selector de la voz global es un `v-select`, igual que el del panel de
  usuario, y por la misma razón.** Se evaluó la receta del autocomplete que dejó
  anotada T-011 y **no se implementó**: el estado con `v-select` está verificado y
  es aceptable, y dejar un filtro a medias sería peor. Lo medido en esta corrida:
  el menú **virtualiza** (320 px de ventana sobre 2357 px de contenido) y, aun así,
  scrolleando se llega a las **47 voces** y a las dos cabeceras
  («Microsoft edge-tts · 45», «Piper (local) · 2»); elegir una voz de Piper del
  menú funciona con `el.click()`. Si el catálogo crece más, la mejora natural sigue
  siendo `v-autocomplete` + `v-model:search` vaciándose en `@update:menu`.
- **El slider del maestro guarda con `@end` y con `@update:model-value` tras 350 ms**,
  copiando la lección de T-011: Vuetify emite `end` solo con ratón o dedo, así que
  sin la segunda vía moverlo con el **teclado** no guardaría nada. Verificado con el
  teclado en el navegador: 10 flechas → la UI muestra 50 % y `app_settings` dice 0.5.
- **Gate nuevo:** `npm --prefix backend run test:settings`
  (`scripts/smoke-settings.js`, **29 comprobaciones**). Dos mitades: una hermética
  en proceso (defaults, normalización de valores imposibles, validación, la ruta
  sobre un Express en el puerto 0, el efecto en vivo de la voz global con el
  pipeline y el relay construidos **antes** de la escritura, la convivencia con el
  comando de T-012 y el tema sobreviviendo a cerrar y reabrir el archivo SQLite); y
  otra que levanta **el backend real** como proceso hijo —lo que prueba que la ruta
  está montada en `app.js`— y comprueba que los tres ajustes **sobreviven a un
  SIGTERM y un arranque nuevo**. No necesita red ni credenciales
  (`TTS_EDGE_ENABLED=false`, `TTS_PIPER_ENABLED=false` y sin sesión de Twitch), usa
  `DB_FILE` en el tmpdir y un puerto libre. Los diez gates anteriores siguen
  intactos (25/16/16/16/15/36/31/45/43/35).
  - **Control negativo (cuatro):** (1) quitar la línea que monta el router en
    `app.js` → fallan las 4 comprobaciones del backend real, 25/29; (2) que el
    patch no escriba la voz global → fallan 6, incluidas las dos del efecto en
    vivo; (3) que la lectura ignore el volumen guardado y devuelva el default →
    fallan 6, incluidas las del reinicio real; (4) que la voz global pise el nivel
    `command` en `resolveUserVoice` → fallan 4, **dos de ellas las de la
    interacción con T-012**, que es la prueba de que ese bloque mide de verdad la
    prioridad y no la repite de memoria.
- **Interacción con T-012 (`!cambia-mi-voz`), verificada tras el merge de `main`:**
  las dos tareas de esta ola conviven sin cambiar código. Fijado en el gate con el
  **comando real** pasando por el relay (no escribiendo `voice_source` a mano):
  quien rueda su voz con el comando queda en nivel 2, y **cambiar la voz global
  desde el panel no le toca la voz, ni el origen, ni el pitch**; en el mismo cambio
  el `override` del streamer sigue intacto y solo se mueve el nivel 3. Además el
  comando puede volver a rodar después del cambio de global, y su mensaje se ve sin
  leerse (filtro de T-008). Era lo esperado —el selector solo escribe
  `global_voice_id` y la prioridad vive en `voice-model.js`, que ninguna de las dos
  tareas modificó— pero ahora está fijado por un gate.
- **Verificado en Chrome real** (imitador de EventSub, backend 3013, frontend 5186,
  CDP 9236, **21 comprobaciones**, cero errores de consola inesperados, con los
  tres motores registrados y los artefactos de Piper presentes): el panel se abre
  desde el menú de overflow con los tres controles; el catálogo llega a 47 voces
  agrupadas por motor; **un mensaje antes y otro después de cambiar la voz global
  desde el selector** se leen con `edge:es-MX-DaliaNeural` y con
  `piper:es_ES-davefx-medium` respectivamente, **con el mismo pitch** y sin
  reiniciar nada, mientras el usuario con override sigue con
  `edge:es-AR-ElenaNeural`; con el volumen individual del usuario en 0.4 y el
  maestro al 100 % la reproducción recibe 0.4, y bajando el maestro al 50 % **con
  el teclado** recibe 0.2 (`masterVolume` 0.5 en el hub); el switch pasa la UI a
  claro al instante (fondo `rgb(255,255,255)`, clase `v-theme--light`) y la
  preferencia **sobrevive una recarga y un reinicio del backend con SIGTERM**
  (sin `cierre forzado`), igual que la voz global y el volumen maestro; volver a
  oscuro también se aplica y se guarda. Layout sin scroll horizontal a 1280×720,
  1920×1080 y 414×800, y a 414 px el menú abre la columna de usuarios.
- **Límite honesto de la verificación:** como en T-008…T-011, en Chrome headless no
  hay audio audible; lo comprobado es que la **instrucción** que recibe el motor
  lleva el volumen escalado correcto (individual × maestro). **Que el maestro se
  oiga más bajo lo confirma el operador con altavoces** (paso 3 de abajo).
- **Detalle de UI conocido:** al abrir el panel por primera vez el selector muestra
  el **id** de la voz global (`edge:es-MX-DaliaNeural`) durante el segundo que tarda
  `GET /api/voices` en responder, y pasa a la etiqueta legible
  («davefx (es-ES, medium)») en cuanto llega el catálogo. Es el mismo item de
  respaldo "fuera del catálogo" que evita que el selector quede en blanco si el
  motor de esa voz está apagado.
- **Confirmación en vivo (la hace el operador — hace falta audio real):**
  1. Con `backend/.env` completo (T-003) y sesión iniciada, `npm start` y abrir
     `http://localhost:5173` con altavoces.
  2. Menú de los tres puntos (arriba a la derecha) → **Ajustes globales**. Elegir
     otra voz: el mensaje siguiente de cualquier usuario **sin voz asignada** debe
     oírse con ella, y quien tenga voz propia no debe cambiar.
  3. Bajar el **volumen maestro** a la mitad: los mensajes siguientes deben oírse
     más bajo, conservando la diferencia relativa entre usuarios (el volumen
     individual de cada uno se multiplica por este).
  4. Mover el **toggle de tema**: la UI cambia al instante. Recargar la página y
     reiniciar con `pm2 restart all` (o `npm stop` + `npm start`): debe seguir en el
     tema elegido.
  5. Comprobar la persistencia:
     `sqlite3 backend/data/app.sqlite "SELECT key, value FROM app_settings WHERE key IN ('global_voice_id','theme','tts_master_volume');"`.

## Functional Requirements

1. **FR-1:** Autenticación OAuth con Twitch con tokens persistidos y refresh automático (T-003).
2. **FR-2:** Lectura del chat en tiempo real vía EventSub con reconexión automática (T-004).
3. **FR-3:** Panel de chat con auto-scroll inteligente (T-005).
4. **FR-4:** Envío de mensajes al chat como el broadcaster con Enter (T-006).
5. **FR-5:** Columna de usuarios híbrida: presentes (Get Chatters) + activos (mensajes) (T-007).
6. **FR-6:** Lectura TTS de mensajes con filtros (`!`, bots, URLs, muted/ignored) y cola FIFO sin límite con skip/vaciar/pausa (T-008).
7. **FR-7:** Tres motores TTS intercambiables — navegador, edge-tts, Piper — bajo una interfaz común con catálogo de voces agregado (T-008, T-009, T-010).
8. **FR-8:** Modelo de voz por prioridad (override → comando → global) con pitch aleatorio persistente por usuario (T-011).
9. **FR-9:** Acciones locales por usuario: mute TTS, volumen, ignorar, voz, pitch — persistidas en SQLite (T-011).
10. **FR-10:** Comando de chat `!cambia-mi-voz` sin cooldown (T-012).
11. **FR-11:** Ajustes globales (voz, volumen maestro, tema) persistidos (T-013).
12. **FR-12:** Encendido/apagado con PM2 multiplataforma (macOS dev, Windows 11 prod) y secretos en `.env` (T-001).

## Non-Goals (Out of Scope)

- Acciones de moderación de Twitch (ban, timeout, warn, borrar mensaje, VIP, mod, bloquear, shoutout) — fase 2.
- Proveedores de chat YouTube y TikTok — fase 2 (la interfaz `ChatProvider` queda lista).
- Historial de chat persistente, búsquedas o analíticas — el chat vive solo en memoria.
- Multi-tenant / múltiples streamers / hosting público — un solo usuario local.
- Cooldown o anti-spam del comando `!cambia-mi-voz` — decisión consciente, revisable.
- TypeScript, tests exhaustivos de UI, CI/CD.

## Implementation Order

1. **T-001** (scaffold + PM2) — sin dependencias, base de todo.
2. **T-002** (SQLite + config) — depende de T-001.
3. **T-003** (OAuth Twitch) — depende de T-002.
4. **T-004** (EventSub + relay) — depende de T-003.
5. **T-005** (shell UI + panel de chat) — depende de T-001; en paralelo con T-002–T-004 si se desea.
6. **T-006** (enviar mensajes) — depende de T-004 y T-005. **← fin del tracer bullet: chat vivo end-to-end.**
7. **T-007** (columna de usuarios) — depende de T-004 y T-005.
8. **T-008** (núcleo TTS + motor navegador + cola/filtros) — depende de T-004 y T-005.
9. **T-009** (edge-tts) — depende de T-008.
10. **T-010** (Piper) — depende de T-008.
11. **T-011** (modelo voz/pitch + acciones por usuario) — depende de T-007 y T-008 (idealmente tras T-009 para tener catálogo real).
12. **T-012** (`!cambia-mi-voz`) — depende de T-011.
13. **T-013** (ajustes globales + tema) — depende de T-011.

## Success Metrics

- Un mensaje escrito en el chat de Twitch aparece en la UI en < 2 s y comienza a leerse (si la cola está vacía) en < 4 s.
- Con los tres motores instalados, `GET /api/voices` lista voces en español de los tres namespaces (`browser:`, `edge:`, `piper:`).
- Tras reiniciar con PM2, todos los ajustes por usuario (voz, pitch, mute, volumen, ignore) y globales (voz global, tema) se conservan.
- El sistema completo arranca con un solo comando PM2 tanto en macOS como en Windows 11, sin editar código (solo `.env`).
- Cero secretos commiteados en el repositorio.
