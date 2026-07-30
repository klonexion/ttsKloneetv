/**
 * Relay de chat: del `ChatProvider` al frontend (T-004).
 *
 * Hace tres cosas, en este orden, por cada mensaje:
 *
 * 1. Upsert del autor en `users` (refresca `last_active_at` sin pisar
 *    preferencias ni el pitch/timbre: eso lo garantiza `users.upsert()` de T-002).
 *    En la **primera** vez es también donde el usuario recibe su pitch y timbre
 *    aleatorios persistentes de [0.8, 1.4] (T-011, ver `../tts/voice-model.js`).
 * 2. Pasa el mensaje por el pipeline TTS (T-008), que decide si se muestra, si se
 *    lee y con qué parámetros.
 * 3. `hub.broadcast('chat:message', { ...message, tts })` — el único canal push al
 *    frontend, **una sola trama por mensaje**. Un mensaje de un usuario `ignored`
 *    no se publica (no se muestra ni se lee); uno de un usuario `muted` se publica
 *    con `tts: null` (se muestra, no se lee).
 * 4. Avisa a los suscriptores de `onMessage()` y pasa el mensaje por los comandos
 *    de chat (T-012, `./commands.js`): `!cambia-mi-voz` rueda una voz nueva para
 *    quien lo escribe. Va **después** de publicar la trama, así que un comando
 *    nunca retrasa lo que se ve en pantalla, y su efecto se nota en el mensaje
 *    siguiente del usuario.
 * 5. Nada más: el chat no se persiste (no hay historial, por decisión de diseño).
 *
 * Además supervisa el ciclo de vida del provider: solo tiene sentido conectarse
 * a EventSub si hay sesión de Twitch, así que sondea la sesión y arranca o para
 * el provider según aparezca o se pierda. Así un login (o un token revocado) se
 * refleja sin reiniciar el backend.
 *
 * Para T-007: publica tus tramas con el mismo `hub.broadcast(tipo, payload)`
 * (`hub` es el de `../ws/hub.js`); no hace falta otro WebSocket ni tocar este
 * módulo. Para reaccionar a cada mensaje de chat en el backend,
 * `relay.onMessage(handler)` entrega el mensaje ya normalizado — y lo entrega
 * **también** cuando el pipeline TTS decide no mostrarlo ni leerlo, así que un
 * comando de un usuario silenciado sigue procesándose. Los comandos del propio
 * proyecto (T-012) no necesitan suscribirse: viven en `./commands.js` y este
 * módulo los invoca por cada mensaje.
 */
import { getChannel, getSession } from '../auth/session.js';
import { config } from '../config.js';
import { getRepositories } from '../db/index.js';
import { logger } from '../logger.js';
import { getTtsPipeline } from '../tts/pipeline.js';
import { randomUserPitch, randomUserTimbre } from '../tts/voice-model.js';
import { createChatCommands } from './commands.js';
import { CHAT_MESSAGE_FIELDS, CHAT_PROVIDER_EVENTS, isNormalizedChatMessage } from './provider.js';
import { createTwitchProvider } from './twitch-provider.js';

/**
 * Tipo de trama de un mensaje de chat. El frontend lo espera exactamente así
 * (`CHAT_MESSAGE_TYPE` en `frontend/src/stores/chat-messages.js`).
 */
export const CHAT_MESSAGE_TYPE = 'chat:message';

/**
 * Claves del payload de la trama `chat:message`: el mensaje normalizado de T-004
 * **más** `tts`, la instrucción de lectura que añadió T-008 (`{ engine, voiceId,
 * pitch, volume, text }`, o `null` si el mensaje no se lee).
 *
 * El store de chat del frontend ignora las claves que no conoce, así que la cola
 * TTS lee `payload.tts` suscribiéndose al mismo tipo de trama.
 */
export const CHAT_MESSAGE_FRAME_FIELDS = Object.freeze([...CHAT_MESSAGE_FIELDS, 'tts']);

/** Espera antes de reintentar cuando la credencial fue rechazada. */
const AUTH_RETRY_MS = 30_000;

/**
 * @param {object} options
 * @param {{ broadcast: (type: string, payload: unknown) => void }} options.hub
 * @param {object} [options.provider]      provider ya construido (pruebas).
 * @param {object|false} [options.commands] comandos de chat (T-012); `false` los
 *        desactiva. Por default se construyen sobre los mismos `repositories`.
 * @param {Function} [options.isSessionReady] override del sondeo de sesión.
 */
export function createChatRelay({
  hub,
  provider = null,
  sessionPollMs = null,
  authRetryMs = AUTH_RETRY_MS,
  repositories = getRepositories,
  tts = null,
  commands = null,
  isSessionReady = () => getSession().authenticated && getChannel() !== null,
} = {}) {
  if (!hub || typeof hub.broadcast !== 'function') {
    throw new TypeError('createChatRelay necesita el hub de WebSocket');
  }

  const chatProvider = provider ?? createTwitchProvider();
  const messageHandlers = new Set();
  const ttsPipeline = tts ?? getTtsPipeline();
  // Construirlos no cuesta nada: no toca la base ni construye motores TTS hasta
  // que llega un comando de verdad (ver `./commands.js`).
  const chatCommands = commands === false ? null : (commands ?? createChatCommands({ repositories }));

  let running = false;
  let providerRunning = false;
  let sessionTimer = null;
  let authBlockedUntil = 0;
  let unsubscribers = [];
  let messagesRelayed = 0;
  let messagesHidden = 0;
  let commandsApplied = 0;

  const handleMessage = (message) => {
    if (!isNormalizedChatMessage(message)) {
      logger.warn('chat: mensaje descartado por no cumplir el shape normalizado');
      return;
    }

    try {
      repositories().users.upsert({
        twitchUserId: message.userId,
        username: message.username,
        displayName: message.displayName,
        // Pitch y timbre aleatorios persistentes (T-011): el upsert de T-002 solo
        // los aplica en la **inserción**, así que estos valores son los del primer
        // mensaje del usuario y los siguientes no los pisan. Ver `../tts/voice-model.js`.
        pitch: randomUserPitch(),
        timbre: randomUserTimbre(),
        timestamp: Date.parse(message.timestamp) || Date.now(),
      });
    } catch (error) {
      // Un fallo de la base no debe impedir que el mensaje se vea en pantalla.
      logger.error(`chat: no se pudo registrar al usuario (${error.message})`);
    }

    // El pipeline TTS nunca lanza, pero el relay no puede quedarse sin publicar
    // por un fallo inesperado: sin decisión, el mensaje se muestra y no se lee.
    let decision = { visible: true, tts: null };
    try {
      decision = ttsPipeline.decide(message);
    } catch (error) {
      logger.error(`tts: el pipeline falló, el mensaje se mostrará sin voz (${error.message})`);
    }

    if (decision.visible) {
      messagesRelayed += 1;
      hub.broadcast(CHAT_MESSAGE_TYPE, { ...message, tts: decision.tts ?? null });
    } else {
      messagesHidden += 1;
    }

    for (const handler of messageHandlers) {
      try {
        handler(message);
      } catch (error) {
        logger.error(`chat: un handler de mensaje falló (${error.message})`);
      }
    }

    // Comandos de chat (T-012). `handle()` es asíncrono (el catálogo de voces
    // puede tocar red) y nunca rechaza, así que no se espera: el mensaje ya está
    // en pantalla y el efecto del comando se ve en el mensaje siguiente.
    if (chatCommands !== null) {
      chatCommands.handle(message).then((result) => {
        if (result.matched && result.applied) {
          commandsApplied += 1;
        }
      });
    }
  };

  const stopProvider = () => {
    if (!providerRunning) {
      return;
    }
    providerRunning = false;
    chatProvider.stop();
  };

  const pollSession = () => {
    let ready = false;
    try {
      ready = isSessionReady();
    } catch (error) {
      logger.error(`chat: no se pudo leer la sesión (${error.message})`);
      return;
    }

    if (!ready) {
      if (providerRunning) {
        logger.info('chat: sin sesión de Twitch, se detiene la lectura del chat');
        stopProvider();
      }
      return;
    }

    if (providerRunning || Date.now() < authBlockedUntil) {
      return;
    }

    providerRunning = true;
    logger.info('chat: hay sesión de Twitch, conectando a EventSub');
    chatProvider.start();
  };

  return {
    provider: chatProvider,

    /** Arranca el supervisor. Idempotente. */
    start() {
      if (running) {
        return;
      }
      running = true;

      unsubscribers = [
        chatProvider.on(CHAT_PROVIDER_EVENTS.message, handleMessage),
        chatProvider.on(CHAT_PROVIDER_EVENTS.authInvalid, (reason) => {
          logger.warn(`chat: credencial de Twitch no válida (${reason}); se reintentará`);
          authBlockedUntil = Date.now() + authRetryMs;
          stopProvider();
        }),
      ];

      const intervalMs = Math.max(sessionPollMs ?? config.twitch.chatSessionPollMs, 100);
      sessionTimer = setInterval(pollSession, intervalMs);
      sessionTimer.unref?.();
      pollSession();
    },

    /** Detiene el supervisor y el provider. Idempotente. */
    stop() {
      running = false;
      if (sessionTimer !== null) {
        clearInterval(sessionTimer);
        sessionTimer = null;
      }
      for (const off of unsubscribers) {
        off();
      }
      unsubscribers = [];
      stopProvider();
    },

    /** Suscripción al flujo de mensajes normalizados; devuelve la baja. */
    onMessage(handler) {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },

    /** Estado para diagnóstico (lo usan los logs y las pruebas de humo). */
    getStatus: () => ({
      running,
      providerRunning,
      provider: chatProvider.name,
      connection: chatProvider.getStatus(),
      messagesRelayed,
      messagesHidden,
      commandsApplied,
    }),
  };
}
