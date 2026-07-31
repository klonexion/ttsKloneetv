# Decisiones de diseño — Multi-Chat Streamer Hub con TTS (fase 1: Twitch)

> Resultado de la sesión de grill sobre `pitch-grill-me.md` (2026-07-24).
> Este documento es la fuente de verdad del alcance de la fase 1.

## Arquitectura

- **Backend como relay**: el backend (Node) sostiene la conexión EventSub
  WebSocket con Twitch, guarda los tokens y hace todas las llamadas a la API
  Helix. El frontend habla solo con el backend (WebSocket propio + REST).
- **El backend también hospeda los motores TTS locales**; el audio generado se
  envía al frontend y **todo el audio suena en el navegador** (una sola cola de
  audio, un solo punto de control de volumen; OBS captura como browser source).
- Diseño tipo **adapter/plugin** en dos ejes: proveedores de chat (Twitch hoy;
  YouTube/TikTok después) y motores TTS.
- **Un solo usuario (el streamer), corriendo local.** Sin multi-tenant.
- **Desarrollo en macOS, producción en Windows 11** → todo debe ser
  multiplataforma.

## Stack

| Capa | Elección |
|---|---|
| Frontend | Vue 3 + Vite + **Vuetify 3** (Material Design) |
| Tema | Conmutable claro/oscuro, **oscuro por default**, preferencia guardada |
| Backend | Node + **Express** (REST/OAuth) + **ws** (WebSocket al frontend) |
| Persistencia | **SQLite** (ajustes por usuario, tokens); mensajes de chat **solo en memoria** |
| Procesos | **PM2** con `ecosystem.config.js` (mismo en Mac y Windows): start/stop/logs |
| Config | `.env` (Client ID/Secret de Twitch, puertos, etc.), nunca commiteado |

## Twitch (fase 1)

- Login OAuth (authorization code flow vía backend). El usuario **ya tiene una
  app registrada** en dev.twitch.tv; solo falta agregar el redirect URI
  `http://localhost:3000/auth/callback` y poner credenciales en `.env`.
- Scopes: leer chat (`user:read:chat`), enviar mensajes (`user:write:chat`),
  lista de presentes (`moderator:read:chatters`).
- Leer chat por **EventSub WebSocket** (`channel.chat.message`); enviar
  mensajes y demás por **Helix** (IRC para comandos está muerto desde 2023).
- **Sin acciones de moderación de Twitch en fase 1** (ban/timeout/VIP/etc.
  quedan para fase 2). Solo acciones locales.

## UI

- **Izquierda**: mensajes en tiempo real con auto-scroll hacia abajo.
- **Derecha**: columna de usuarios, construida en **híbrido**: polling de
  Get Chatters cada ~60 s (presentes aunque no escriban) + marca de actividad
  al escribir.
- **Abajo**: input para enviar mensajes al chat con Enter.
- Controles globales de cola TTS: **saltar el actual, vaciar cola, pausar/reanudar**.

## Acciones locales por usuario (columna derecha)

- Mutear su TTS / des-mutear.
- Volumen individual.
- Ignorar (sus mensajes no aparecen ni se leen).
- **Asignar voz** (de la lista agregada de todos los motores) y **pitch**.
- Todo persiste en SQLite y sobrevive reinicios.

## TTS

- **Motores fase 1 (los tres)**: Web Speech API (navegador), **edge-tts**
  (voces neuronales Microsoft vía npm, requiere internet) y **Piper**
  (neuronal, offline, binario + modelos es_ES/es_MX).
- La lista de voces que ve el streamer agrega las de todos los motores;
  **preferencia y default: español**.
- **Cola FIFO sin límite** (nunca descarta sola) + controles manuales globales.
- **Filtro de lectura**: se lee solo el texto del mensaje (sin “usuario dice”),
  saltando mensajes que empiezan con `!`, bots conocidos (Nightbot,
  StreamElements) y usuarios ignorados/muteados. URLs se leen como “enlace”.

### Modelo de voz/pitch por usuario

- Primer mensaje de un usuario: voz = **GLOBAL** (default `es-MX-Dalia`),
  pitch = **aleatorio persistente** (p. ej. 0.8–1.4) para distinguirlos.
- Prioridad de voz al leer un mensaje:
  1. **Override del streamer** (se conserva; asignarlo NO cambia la global).
  2. **Voz de `!cambia-mi-voz`** (el usuario rodó una voz aleatoria en español).
  3. **Voz GLOBAL**.
- Cambiar la GLOBAL afecta solo a los usuarios del nivel 3; el pitch individual
  se conserva siempre.
- `!cambia-mi-voz`: **sin cooldown** (el comando no se lee por TTS porque
  empieza con `!`).

## Fase 2 (fuera de alcance ahora)

- Moderación de Twitch (ban, timeout, warn, borrar, VIP, mod, bloquear, shoutout).
- Proveedores YouTube y TikTok.
- Más motores TTS.
- Historial de chat persistente / analíticas.

## `!configura-mi-voz` — sesión de grill 2026-07-30

Plan completo en `docs/exec-plans/active/configura-mi-voz.md`. Decisiones:

- **Servicio público separado y mínimo**, nunca el backend admin entero: lo
  único expuesto a internet es un proceso nuevo (`viewer/`) que solo sabe
  loguear a un viewer, mostrarle la pantalla y guardar su propia fila. El
  backend admin (moderación, enviar chat como el streamer, ajustes) sigue
  100% `localhost`.
- **Salida a internet: túnel de Cloudflare con nombre fijo** sobre un dominio
  propio (`kloneetv.lol`), no un túnel efímero — Twitch exige match exacto de
  `redirect_uri`, y una URL que cambia cada sesión obligaría a re-registrarla
  en dev.twitch.tv cada vez que se prende el sistema. Se había planeado DDNS
  (DuckDNS) + certificado real (win-acme) + port-forward, y de hecho se armó
  esa ruta completa (certificado real emitido, DuckDNS funcionando), pero el
  router del streamer resultó tener un bug de firmware que solo aplicaba la
  primera regla de port-forward — el túnel de Cloudflare no depende del
  router en absoluto, así que se usó eso en su lugar. La ruta DDNS queda
  documentada como alternativa por si se cambia de router.
- **La voz que el viewer se elige entra al mismo nivel que el override del
  streamer** (nivel 1 de la prioridad de arriba): gana el último que la
  toque, sea el streamer desde su panel o el viewer desde esta pantalla nueva.
  No se agrega un nivel de prioridad nuevo.
- El viewer puede tocar **voz + volumen + pitch/timbre** de sí mismo. Mutear/
  ignorar sigue siendo exclusivo del panel del streamer.
