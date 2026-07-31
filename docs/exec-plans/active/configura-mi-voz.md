# Plan: `!configura-mi-voz` — pantalla pública de auto-configuración de voz

> Sesión de grill + decisiones: 2026-07-30. Continúa T-014 (login de viewer),
> que ya está construido pero necesita reubicarse (ver T-015). Fuente del
> pitch: `docs/pitch-grill-me.md`. Este documento es forward-looking (plan de
> lo que falta), no un registro retrospectivo como
> `docs/exec-plans/active/streamer-chat-tts-hub.md`.

## Qué se pidió

Un espectador escribe `!configura-mi-voz` en el chat de Twitch → el bot le
manda un link → entra, inicia sesión con SU cuenta de Twitch (para probar que
es él) → ve una pantalla con las voces disponibles en la máquina del streamer
+ volumen/pitch/timbre → guarda → se actualiza su fila en la base local del
streamer.

## Decisiones tomadas en el grill de esta sesión

1. **Arquitectura de exposición pública: servicio nuevo y mínimo**, separado
   del backend admin. El backend actual (`backend/`: moderación, enviar chat
   como el streamer, ajustes, TTS) **nunca se expone a internet** — sigue
   escuchando solo en `localhost`, exactamente como hoy. Lo único público es
   un proceso chico aparte que solo sabe hacer tres cosas: login de viewer,
   mostrarle la pantalla, guardar su propia fila.
2. **Salida a internet: hostname DDNS estable + certificado real**, no un
   túnel efímero. Ver la sección "Por qué no un túnel gratis" más abajo — el
   motivo es una restricción dura de Twitch (redirect URI con match exacto),
   no una preferencia estética.
3. **Prioridad de la voz que el viewer se elige**: mismo nivel que el
   `override` que hoy solo podía poner el streamer desde su panel
   (`backend/src/users/preferences.js`). No hace falta un valor nuevo en
   `voice_source` — el viewer escribe por el mismo camino
   (`assignUserVoice(..., VOICE_SOURCES.override)`), y gana el último que
   toque esa fila, sea el streamer o el propio viewer.
4. **Qué puede tocar el viewer**: voz + volumen + pitch/timbre (los mismos
   campos que ya existen por usuario en `users`). **No** puede mutearse ni
   ignorarse a sí mismo — eso sigue siendo una acción exclusiva del panel del
   streamer (no se preguntó explícitamente, pero ninguna opción del grill lo
   incluía; si lo querés agregar después es un campo más en el mismo endpoint).

## Por qué no un túnel gratis tipo Cloudflare Quick Tunnel / ngrok free

Se evaluó porque pedías "lo que necesite instalar o configurar lo mínimo
posible". El problema no es el túnel en sí — es que Twitch exige que
`redirect_uri` haga **match exacto** con lo registrado en dev.twitch.tv, y un
túnel gratuito sin cuenta te da una URL **distinta cada vez que lo reiniciás**
(`https://algo-random.trycloudflare.com`). Eso te obligaría a entrar a
dev.twitch.tv y cambiar el redirect URI registrado **cada vez que prendés el
sistema**, o el login del viewer no funciona nunca. Es más fricción recurrente
que el setup único de DDNS + certificado, que se hace una sola vez y después
no se vuelve a tocar. Si en algún momento preferís aceptar esa fricción
recurrente a cambio de cero setup inicial, el túnel sigue siendo una opción
válida — queda anotado como alternativa, no descartado para siempre.

## Piezas nuevas

### T-014 — Login de viewer (hecho esta noche, pendiente de mover)

Ya construido y con gate propio:

- `backend/src/db/repositories/viewer-sessions.js` + tabla `viewer_sessions`
  (migración en `backend/src/db/migrations.js`).
- `backend/src/auth/viewer-session.js` — la lógica: intercambia el `code` de
  Twitch por un token, lo usa una vez contra `GET /helix/users` y lo
  descarta. Nunca toca la tabla `tokens` del bot.
- `backend/src/auth/viewer-router.js` — rutas `/viewer-auth/{login,callback,me}`
  y `POST /viewer-auth/logout`, con su propio nonce CSRF y su propia cookie
  (`viewer_session`).
- `backend/scripts/smoke-viewer-auth.js` (`npm --prefix backend run
  test:viewer-auth`) — 14 comprobaciones, incluida la garantía central: loguear
  a un viewer no cambia ni un bit de la sesión del bot.

**Pendiente**: hoy estas rutas están montadas en `backend/src/app.js` (el
backend admin). Con la decisión 1 de arriba, **hay que sacarlas de ahí** y
montarlas en el proceso nuevo de T-015 en su lugar — el backend admin no debe
tener ninguna ruta pública, ni siquiera una tan acotada como el login de
viewer.

### T-015 — Servicio `viewer/` (proceso nuevo, mínimo)

Nuevo paquete en la raíz del repo, sibling de `backend/` y `frontend/`.

- `viewer/server.js`: Express standalone, puerto propio
  (`VIEWER_SERVICE_PORT`, sugerido default `3100`). Importa directamente
  módulos de `backend/src/` (mismo repo, sin necesidad de workspaces npm):
  `db/index.js` (misma base SQLite que el backend — un solo archivo, dos
  procesos leyéndolo/escribiéndolo, WAL ya está activado así que esto es
  seguro), `auth/viewer-session.js`, `auth/viewer-router.js` (movidos acá, no
  en `backend/src/app.js`), `tts/registry.js` (para el catálogo de voces,
  solo lectura), `tts/voice-model.js` (`assignUserVoice`,
  `randomUserPitch/Timbre`).
- Nuevo módulo `viewer/preferences.js` (o
  `backend/src/users/viewer-preferences.js` si preferís que viva del lado de
  `backend/` por cercanía al resto de la lógica de usuarios): función que
  actualiza voz/volumen/pitch/timbre **de un solo `twitch_user_id`**, resuelto
  **siempre** desde `req.viewerSession.twitchUserId` (la cookie autenticada) —
  el body de la petición nunca debe poder decir "actualizame a este otro
  usuario". Reusa los límites de `PREFERENCE_LIMITS` de
  `backend/src/users/preferences.js` en vez de duplicarlos.
- Rutas nuevas montadas junto a las de T-014:
  - `GET /viewer/catalog` → `getTtsRegistry().listVoices()` (mismo catálogo
    que ya usa `GET /api/voices` del backend admin).
  - `GET /viewer/preferences` → la fila propia (voice_id/volume/pitch/timbre
    actuales), protegida con `requireViewerSession`.
  - `PATCH /viewer/preferences` → guarda, protegida con
    `requireViewerSession`.
- `viewer/public/index.html` + `app.js` + `styles.css`: página única, sin
  framework ni build step (no vale la pena arrastrar Vuetify para una
  pantalla). Flujo: si `GET /viewer-auth/me` dice `authenticated: false`,
  botón "Iniciar sesión con Twitch" (`href="/viewer-auth/login"`); si
  `true`, formulario con selector de voz (agrupado por motor, igual que hace
  el panel del streamer), tres sliders (volumen/pitch/timbre) y "Guardar".
- `backend/src/app.js`: **revertir** el montaje de `/viewer-auth` que se
  agregó hoy — el backend admin vuelve a ser exactamente como antes de esta
  sesión, cero rutas públicas.

**Acceptance criteria — hecho la noche del 2026-07-30, verificado:**

- [x] `node viewer/server.js` levanta un Express separado del backend admin,
      en su propio puerto (`VIEWER_SERVICE_PORT`, default 3100), y
      `backend/src/app.js` ya no monta `/viewer-auth` en ningún lado.
- [x] Un viewer sin sesión que abre la página ve el botón de login; tras
      loguearse ve su voz/volumen/pitch/timbre actuales precargados.
      Verificado en Chrome real contra el imitador de Twitch: login → catálogo
      completo de edge-tts cargado (46 voces en español) → cambiar voz a
      "Jorge (es-MX, hombre)" y volumen a 0.35 → "Guardado." → confirmado en
      `users` con `voice_source = 'override'`.
- [x] Guardar actualiza `users.voice_id/volume/pitch/timbre` **solo** de ese
      `twitch_user_id`, con `voice_source = 'override'`.
- [x] Un viewer no puede editar la fila de otro: `PATCH /viewer/preferences`
      rechaza con 400 cualquier clave fuera de
      `{voiceId,volume,pitch,timbre,rerollPitch,rerollTimbre}` — `userId` no es
      una clave aceptada, así que no hay forma de pedir "actualizame a otro".
- [x] `npm --prefix viewer test` (`smoke-viewer-service.js`, reemplaza al viejo
      `test:viewer-auth` de `backend/`): 19/19, levantando el backend admin Y
      `viewer/server.js` como dos procesos reales sobre la misma base.
- [x] Quality checks (lint) pasan en `viewer/` y en `backend/`.

**Incidente durante la construcción (2026-07-30, corregido la misma noche):**
la primera versión de la prueba de humo de `!configura-mi-voz`
(`backend/scripts/smoke-chat-command.js`) invocaba el comando sin inyectar un
doble de `sendChatMessage()` — esa función habla con la sesión de Twitch
**global** del proceso (no con el `repositories` inyectado que sí aísla el
resto de la prueba), así que terminó publicando un mensaje real en el chat
en vivo del canal (`@chelo configurá tu voz acá: http://localhost:3100`).
Arreglado sumándole a `createChatCommands()` un parámetro `sendMessage`
inyectable (default: el real) — la prueba ahora pasa siempre un doble y hay un
comentario en el propio código de `commands.js` explicando por qué no se debe
quitar. Ver el `git log` de esa noche para el detalle exacto del cambio.

### T-016 — Hostname estable + certificado + salida a internet

Esto es mayormente **trabajo manual del streamer** (vos), con algún script de
apoyo de mi lado.

**Estado (2026-07-30, en curso):**

- [x] Cuenta DuckDNS creada, dominio `kloneetv.duckdns.org` registrado y
      resolviendo a la IP pública real (verificado con `nslookup`).
- [x] `scripts/duckdns-update.mjs` (proceso `tts-duckdns` en
      `ecosystem.config.js`): pinguea `duckdns.org/update` cada 5 min para que
      el hostname siga la IP si cambia. Token en `.env` (git-ignorado, nunca en
      `.env.example`), nunca se loguea.
- [x] `viewer/server.js` ahora sabe servir HTTPS con un certificado real
      (`VIEWER_HTTPS=true` + `VIEWER_TLS_CERT_FILE`/`VIEWER_TLS_KEY_FILE`,
      default `certs/duckdns/{fullchain,privkey}.pem`), separado del `mkcert`
      local del backend admin.
- [ ] **Falta**: emitir el certificado de verdad (win-acme), el port-forward
      en el router, y registrar el redirect URI público en dev.twitch.tv.
      Estos tres son pasos que solo el streamer puede hacer (elevación de
      Windows, panel del router, cuenta de Twitch) — quedan abajo con las
      instrucciones exactas.

**Lo que hacés vos, una sola vez:**

1. Cuenta gratis en [duckdns.org](https://www.duckdns.org) (login con
   GitHub/Google/etc.) → elegís un subdominio, p. ej. `tuombre.duckdns.org`
   → te da un token.
2. `win-acme` (`https://www.win-acme.com/`, un `.exe`, gratis): lo corrés una
   vez apuntado a `tuombre.duckdns.org`, te deja el certificado Let's Encrypt
   instalado y una tarea programada de Windows que lo renueva solo cada ~60
   días. Necesita el puerto 80 accesible momentáneamente para la validación
   (HTTP-01 challenge).
3. En el router de tu casa: port-forward del puerto público (443 sugerido) a
   la IP interna de tu PC, puerto `VIEWER_SERVICE_PORT`. Vos dijiste que ya
   sabés hacer esto.
4. En dev.twitch.tv, agregar como **segundo** OAuth Redirect URL (no
   reemplazar el del bot): `https://tuombre.duckdns.org/viewer-auth/callback`.
5. `.env`: `TWITCH_VIEWER_REDIRECT_URI=https://tuombre.duckdns.org/viewer-auth/callback`.

**Lo que construyo yo:**

- `viewer/server.js` sirve HTTPS directo con el cert de win-acme (rutas
  configurables por env, mismo patrón que `config.https.certFile/keyFile`
  del backend admin) **o**, más simple, corre HTTP plano detrás de un
  reverse proxy liviano en el propio Windows que sí sabe hablar TLS (a
  decidir según qué te resulte menos fricción cuando lleguemos acá — lo
  reviso con vos en su momento, no hace falta resolverlo esta noche).
- Documentar los 5 pasos de arriba en `WINDOWS.md`, con el mismo nivel de
  detalle que ya tiene esa guía para el resto del setup.

**Acceptance criteria:**

- [ ] Desde un celular con datos móviles (fuera de tu red de casa), abrir
      `https://tuombre.duckdns.org/` carga la pantalla sin advertencia de
      certificado.
- [ ] El login de viewer funciona de punta a punta desde ese celular.
- [ ] Apagar y prender la PC (IP pública nueva) no rompe nada: DuckDNS se
      actualiza solo (el propio router o un cliente DuckDNS liviano) y el
      hostname sigue resolviendo.

### T-017 — Comando `!configura-mi-voz`

- En `backend/src/chat/commands.js`, junto al `VOICE_ROLL_COMMAND` existente
  (`!cambia-mi-voz`): nueva constante `VOICE_CONFIG_COMMAND =
  '${COMMAND_PREFIX}configura-mi-voz'`.
- Al detectarlo, publica en el chat (vía `sendChatMessage()` de
  `backend/src/chat/send.js`, **no** un endpoint HTTP nuevo) un mensaje con el
  link fijo a la pantalla pública (`https://tuombre.duckdns.org/`).
- **Sin cooldown**, mismo criterio ya documentado para `!cambia-mi-voz` ("sin
  cooldown, a propósito" — revisable si se vuelve spam). El mensaje del
  comando se sigue salteando de TTS por el filtro existente
  (`TTS_SKIP_REASONS.command`).
- Config nueva: `VIEWER_SERVICE_PUBLIC_URL` en `.env` (la URL que el bot
  postea; puede derivarse de `TWITCH_VIEWER_REDIRECT_URI` quitándole
  `/viewer-auth/callback`, o ser su propia variable — a decidir al
  implementar, cualquiera de las dos es una línea).

**Acceptance criteria — hecho la noche del 2026-07-30:**

- [x] Escribir `!configura-mi-voz` en el chat hace que el bot responda con el
      link público (`config.viewerService.publicUrl`).
- [x] El mensaje del comando no se lee por TTS (mismo `COMMAND_PREFIX` que
      `!cambia-mi-voz`, ya cubierto por el filtro de T-008 — no hizo falta
      tocar nada ahí).
- [x] `npm --prefix backend run test:chat-command`: 37/37, incluidas dos
      comprobaciones nuevas para este comando (postea con `sendMessage`
      inyectado, y no lanza si `sendMessage` falla).
- [ ] **Pendiente**: confirmación en vivo contra Twitch real y el chat real del
      canal (con `viewer/server.js` corriendo, en un momento tranquilo, no en
      medio de una prueba automática — ver el incidente en T-015 de más
      arriba sobre por qué esto importa).

### T-018 — Integración y arranque

- [x] `ecosystem.config.js` (PM2): `tts-viewer` sumado como tercer proceso,
  mismo patrón que backend/frontend (entrypoint de Node directo, no `npm
  run`). **Sin confirmar todavía con `npm start` real** (T-016 sigue
  pendiente, y arrancarlo hoy intentaría escuchar en el puerto sin nada más
  configurado — inofensivo, pero no probado end-to-end vía PM2 esta noche).
- [x] `.env.example`: `VIEWER_SERVICE_PORT`, `VIEWER_SERVICE_PUBLIC_URL` y
  `TWITCH_VIEWER_REDIRECT_URI` documentados en la sección 10.
- [x] `package.json` raíz: `postinstall`/`setup`/`lint` ya incluyen `viewer/`.
- [x] `docs/decisiones.md` actualizado con las 4 decisiones del grill.
- [ ] **Pendiente**: T-016 (DDNS, certificado, port-forward, registrar el
  redirect URI público en dev.twitch.tv) — trabajo mayormente manual del
  streamer, no se avanzó esta noche.

## Fuera de alcance (a propósito, por ahora)

- Rate limiting o CAPTCHA en `/viewer-auth/login` o en el `PATCH` de
  preferencias — si se vuelve un problema real con audiencia grande, se
  agrega después.
- Que el viewer pueda mutearse/ignorarse a sí mismo.
- Servir la pantalla pública con la SPA Vuetify completa — a propósito es una
  página aparte, mínima, sin bundler.
- Cambiar el modelo de prioridad de voces en general — solo se agrega un
  camino de escritura más al `override` que ya existe, nada más se toca.
