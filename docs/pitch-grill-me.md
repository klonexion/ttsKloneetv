# Pitch: Multi-Chat Streamer Hub con TTS (fase 1: Twitch)

## Contexto

Soy streamer y quiero construir un pequeño sistema web que unifique los chats de
varias plataformas (Twitch, YouTube, TikTok) en una sola interfaz. La fase 1 se
limita **exclusivamente a Twitch**, pero la arquitectura debe dejar la puerta
abierta para agregar más proveedores de chat y más motores de TTS después
(diseño tipo plugin/adapter).

## Objetivo de la fase 1 (MVP)

Una app web donde:

1. **Autenticación**: al abrir la página aparece un botón "Iniciar sesión con
   Twitch" (OAuth). Con eso se obtiene el token necesario para leer y escribir
   en el chat de mi canal.
2. **Panel de chat (lado izquierdo)**: los mensajes del chat se despliegan en
   tiempo real con auto-scroll hacia abajo.
3. **Panel de usuarios (columna derecha)**: lista de usuarios conectados/activos
   en el chat. Cada usuario tiene acciones:
   - **Locales (de mi app)**: mutear su TTS, bajar/subir el volumen de su TTS,
     ignorar sus mensajes.
   - **De Twitch (vía API Helix)**: ban, timeout, warn, borrar mensaje,
     dar/quitar VIP, dar/quitar mod, bloquear. (Nota técnica: Twitch eliminó
     los comandos de moderación por IRC en 2023; hoy se usa la API Helix para
     moderar y EventSub WebSocket para leer el chat.)
4. **Enviar mensajes**: input en la parte inferior; al presionar Enter se envía
   el mensaje al chat de Twitch como yo.
5. **TTS por mensaje**: cada mensaje entrante puede ser leído en voz alta.
   Fase 1: Web Speech API del navegador. La interfaz de TTS debe ser
   intercambiable para acoplar otros servicios después (p. ej. algún servicio
   gratuito/local instalable).

## Restricciones técnicas ya decididas

- **Lenguaje**: JavaScript.
- **Frontend**: Vue.js, UI con Material Design (librería a elegir, p. ej.
  Vuetify).
- **Backend separado** del frontend (repos/carpetas separadas dentro del mismo
  proyecto).
- **Configuración y secretos** (tokens, client ID/secret, etc.) separados del
  código, en archivos de entorno (.env) nunca commiteados.
- **Scripts de encendido/apagado**: poder levantar y tumbar todo el sistema
  fácilmente (p. ej. `start.sh` / `stop.sh`).

## Puntos que sé que están abiertos (grillame aquí)

- Qué hace exactamente el backend vs. qué vive en el frontend (¿quién sostiene
  la conexión EventSub? ¿quién guarda el token? ¿el TTS del navegador implica
  que el frontend recibe los mensajes directo o vía el backend?).
- Cómo se define "usuario conectado": Twitch ya no expone una lista confiable
  de espectadores; ¿la lista derecha se construye con quienes escriben en el
  chat?
- Cola de TTS: ¿qué pasa cuando llegan 20 mensajes seguidos? ¿se encolan, se
  descartan, se puede saltar el actual?
- Persistencia: ¿los ajustes por usuario (muteado, volumen) sobreviven un
  reinicio? ¿dónde se guardan?
- Alcance real del MVP vs. lo que puede esperar: ¿moderación completa de Twitch
  en fase 1 o solo acciones locales primero?
- Un solo usuario (yo, el streamer) o pensado para que lo use más gente.
