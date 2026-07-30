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
