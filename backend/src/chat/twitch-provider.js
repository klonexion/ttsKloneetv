/**
 * `TwitchProvider`: implementación de `ChatProvider` sobre el WebSocket de
 * EventSub (T-004).
 *
 * Protocolo (https://dev.twitch.tv/docs/eventsub/handling-websocket-events):
 *
 * 1. Se abre el WebSocket (`wss://eventsub.wss.twitch.tv/ws`).
 * 2. Twitch envía `session_welcome` con el `session_id`.
 * 3. Con ese id se crea la suscripción a `channel.chat.message` por Helix
 *    (`../twitch/eventsub.js`). Hay ~10 s de plazo.
 * 4. Llegan `notification` con los mensajes y `session_keepalive` cuando no hay
 *    tráfico. Si pasa el keepalive sin recibir nada, la conexión está muerta.
 * 5. `session_reconnect` trae una `reconnect_url`: hay que conectarse ahí y
 *    **no** volver a suscribirse (las suscripciones viajan con la sesión).
 *    Twitch cierra la conexión vieja cuando la nueva recibe su welcome, así que
 *    manteniendo las dos abiertas un momento no se pierde ningún mensaje.
 *
 * Todo lo que sale de aquí ya está normalizado (`{ id, userId, username,
 * displayName, text, timestamp }`): ningún consumidor ve campos crudos de
 * EventSub.
 */
import { EventEmitter } from 'node:events';

import WebSocket from 'ws';

import { getChannel, getValidAccessToken } from '../auth/session.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { createChatMessageSubscription } from '../twitch/eventsub.js';
import { TwitchApiError } from '../twitch/helix.js';
import { CHAT_PROVIDER_EVENTS, CHAT_PROVIDER_STATUS, createSeenIdFilter } from './provider.js';

/** Backoff de reconexión (ms). El último valor se repite indefinidamente. */
export const RECONNECT_DELAYS_MS = Object.freeze([1_000, 2_000, 5_000, 10_000, 30_000]);

/** Margen sobre el keepalive antes de dar la conexión por muerta. */
const KEEPALIVE_MARGIN_MS = 5_000;

/** Tipos de trama del protocolo de EventSub. */
const MESSAGE_TYPES = Object.freeze({
  welcome: 'session_welcome',
  keepalive: 'session_keepalive',
  notification: 'notification',
  reconnect: 'session_reconnect',
  revocation: 'revocation',
});

const asText = (value) => (typeof value === 'string' ? value.trim() : '');

/** ISO 8601 del timestamp de la trama, o el momento actual si no es válido. */
const toIsoTimestamp = (value) => {
  const parsed = Date.parse(asText(value));
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
};

/**
 * Traduce una `notification` de `channel.chat.message` al shape normalizado del
 * proyecto. Devuelve `null` si la trama no trae lo mínimo (id, autor y texto).
 */
export function normalizeChatMessage(frame) {
  const event = frame?.payload?.event;
  const id = asText(event?.message_id);
  const userId = asText(event?.chatter_user_id);
  const text = typeof event?.message?.text === 'string' ? event.message.text : '';

  if (id === '' || userId === '' || text === '') {
    return null;
  }

  const username = asText(event.chatter_user_login) || userId;

  return {
    id,
    userId,
    username,
    displayName: asText(event.chatter_user_name) || username,
    text,
    timestamp: toIsoTimestamp(frame?.metadata?.message_timestamp),
  };
}

/**
 * Crea el provider de Twitch. Todas las dependencias son inyectables para que
 * las pruebas puedan ejercitarlo sin red (ver `scripts/smoke-eventsub.js`, que
 * en su lugar apunta el backend entero al imitador local).
 */
export function createTwitchProvider({
  wsUrl = null,
  keepaliveSeconds = null,
  reconnectDelaysMs = RECONNECT_DELAYS_MS,
  getAccessToken = getValidAccessToken,
  getChannelInfo = getChannel,
  subscribe = createChatMessageSubscription,
  createSocket = (url) => new WebSocket(url),
} = {}) {
  const emitter = new EventEmitter();
  const seen = createSeenIdFilter();
  /** Conexiones vivas (durante una migración hay dos un instante). */
  const connections = new Set();

  let status = CHAT_PROVIDER_STATUS.idle;
  let stopped = true;
  /** Conexión dueña de la sesión activa. */
  let current = null;
  let attempts = 0;
  let reconnectTimer = null;

  const endpoint = () => wsUrl ?? config.twitch.eventSubWsUrl;
  const keepaliveMs = () => (keepaliveSeconds ?? config.twitch.eventSubKeepaliveSeconds) * 1_000;

  const setStatus = (next) => {
    if (status === next) {
      return;
    }
    status = next;
    emitter.emit(CHAT_PROVIDER_EVENTS.status, next);
  };

  const emitError = (message) => {
    logger.warn(`eventsub: ${message}`);
    emitter.emit(CHAT_PROVIDER_EVENTS.error, message);
  };

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  /** Cierra una conexión sin agendar reconexión por su `close`. */
  const disposeConnection = (connection, { terminate = true } = {}) => {
    if (!connection || connection.disposed) {
      return;
    }
    connection.disposed = true;
    if (connection.keepaliveTimer !== null) {
      clearTimeout(connection.keepaliveTimer);
      connection.keepaliveTimer = null;
    }
    connections.delete(connection);
    if (current === connection) {
      current = null;
    }
    try {
      if (terminate) {
        connection.socket.terminate();
      } else {
        connection.socket.close(1000);
      }
    } catch {
      // El socket ya estaba roto: no hay nada que cerrar.
    }
  };

  const scheduleReconnect = (reason) => {
    if (stopped || reconnectTimer !== null || current !== null) {
      return;
    }

    const delay = reconnectDelaysMs[Math.min(attempts, reconnectDelaysMs.length - 1)];
    attempts += 1;
    setStatus(CHAT_PROVIDER_STATUS.reconnecting);
    logger.warn(`eventsub: reconectando en ${delay} ms (${reason})`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openConnection(endpoint(), { migration: false });
    }, delay);
    reconnectTimer.unref?.();
  };

  /** Watchdog del keepalive: sin tráfico en ese plazo, la conexión está muerta. */
  const armKeepalive = (connection) => {
    if (connection.keepaliveTimer !== null) {
      clearTimeout(connection.keepaliveTimer);
    }
    connection.keepaliveTimer = setTimeout(() => {
      if (connection.disposed) {
        return;
      }
      emitError('sin keepalive de Twitch, se da la conexión por muerta');
      disposeConnection(connection);
      scheduleReconnect('keepalive agotado');
    }, connection.keepaliveMs + KEEPALIVE_MARGIN_MS);
    connection.keepaliveTimer.unref?.();
  };

  async function subscribeChat(connection) {
    const channel = getChannelInfo();
    const accessToken = await getAccessToken();

    if (!channel || !accessToken) {
      emitter.emit(CHAT_PROVIDER_EVENTS.authInvalid, 'no hay sesión de Twitch activa');
      disposeConnection(connection);
      return;
    }

    try {
      const subscription = await subscribe({
        sessionId: connection.sessionId,
        broadcasterUserId: channel.id,
        userId: channel.id,
        accessToken,
      });

      if (connection.disposed) {
        return;
      }

      attempts = 0;
      setStatus(CHAT_PROVIDER_STATUS.subscribed);
      logger.info(
        `eventsub: suscrito a channel.chat.message del canal ${channel.login || channel.id}` +
          `${subscription.alreadyExisted ? ' (la suscripción ya existía)' : ''}`,
      );
    } catch (error) {
      const permanent = error instanceof TwitchApiError && error.permanent;
      disposeConnection(connection);

      if (permanent) {
        logger.error(`eventsub: suscripción rechazada (${error.message})`);
        emitter.emit(CHAT_PROVIDER_EVENTS.authInvalid, error.message);
        return;
      }

      emitError(`no se pudo crear la suscripción (${error.message})`);
      scheduleReconnect('suscripción fallida');
    }
  }

  const handleWelcome = (connection, frame) => {
    const session = frame?.payload?.session;
    const sessionId = asText(session?.id);
    if (sessionId === '') {
      emitError('session_welcome sin session_id');
      disposeConnection(connection);
      scheduleReconnect('welcome inválido');
      return;
    }

    connection.sessionId = sessionId;
    const negotiated = Number(session?.keepalive_timeout_seconds);
    if (Number.isFinite(negotiated) && negotiated > 0) {
      connection.keepaliveMs = negotiated * 1_000;
    }
    armKeepalive(connection);

    const previous = current;
    current = connection;
    setStatus(CHAT_PROVIDER_STATUS.connected);

    // Las conexiones nacidas de un `session_reconnect` heredan las
    // suscripciones: volver a suscribirse daría 409 y gastaría cuota.
    if (connection.migration) {
      attempts = 0;
      setStatus(CHAT_PROVIDER_STATUS.subscribed);
      logger.info('eventsub: migración de sesión completada');
      // Ahora sí sobra la vieja: cierre limpio, ya no llegará nada por ella.
      if (previous && previous !== connection) {
        disposeConnection(previous, { terminate: false });
      }
      return;
    }

    // Conexión nueva: cualquier sesión anterior ya no sirve.
    for (const other of [...connections]) {
      if (other !== connection && other.sessionId !== null) {
        disposeConnection(other, { terminate: false });
      }
    }
    current = connection;

    void subscribeChat(connection);
  };

  const handleNotification = (connection, frame) => {
    if (asText(frame?.metadata?.subscription_type) !== 'channel.chat.message') {
      return;
    }

    const message = normalizeChatMessage(frame);
    if (message === null) {
      emitError('notification de chat sin los campos mínimos, descartada');
      return;
    }

    // Durante una migración las dos conexiones pueden entregar el mismo evento.
    if (!seen.add(message.id)) {
      return;
    }

    emitter.emit(CHAT_PROVIDER_EVENTS.message, message);
  };

  const handleFrame = (connection, raw) => {
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      emitError('trama no-JSON descartada');
      return;
    }

    armKeepalive(connection);
    const type = asText(frame?.metadata?.message_type);

    switch (type) {
      case MESSAGE_TYPES.welcome:
        handleWelcome(connection, frame);
        break;
      case MESSAGE_TYPES.keepalive:
        break;
      case MESSAGE_TYPES.notification:
        handleNotification(connection, frame);
        break;
      case MESSAGE_TYPES.reconnect: {
        const reconnectUrl = asText(frame?.payload?.session?.reconnect_url);
        if (reconnectUrl === '') {
          emitError('session_reconnect sin reconnect_url');
          return;
        }
        logger.info('eventsub: Twitch pidió migrar la sesión (session_reconnect)');
        // La conexión vieja sigue abierta a propósito: Twitch la cierra cuando
        // la nueva recibe su welcome, y así no se pierde ningún mensaje.
        openConnection(reconnectUrl, { migration: true });
        break;
      }
      case MESSAGE_TYPES.revocation: {
        const reason = asText(frame?.payload?.subscription?.status) || 'sin motivo';
        emitError(`Twitch revocó la suscripción (${reason})`);
        disposeConnection(connection);
        scheduleReconnect('suscripción revocada');
        break;
      }
      default:
        // El protocolo puede crecer: ignorar lo desconocido, no romper.
        break;
    }
  };

  function openConnection(url, { migration = false } = {}) {
    if (stopped) {
      return;
    }

    const connection = {
      url,
      migration,
      socket: null,
      sessionId: null,
      keepaliveTimer: null,
      keepaliveMs: keepaliveMs(),
      disposed: false,
    };

    if (!migration) {
      setStatus(status === CHAT_PROVIDER_STATUS.reconnecting ? status : CHAT_PROVIDER_STATUS.connecting);
    }

    try {
      connection.socket = createSocket(url);
    } catch (error) {
      emitError(`no se pudo abrir el WebSocket de EventSub (${error.message})`);
      scheduleReconnect('apertura fallida');
      return;
    }

    connections.add(connection);

    connection.socket.on('open', () => {
      logger.info(`eventsub: conectado${migration ? ' (migración de sesión)' : ''}`);
      armKeepalive(connection);
    });

    connection.socket.on('message', (data) => handleFrame(connection, String(data)));

    connection.socket.on('error', (error) => {
      emitError(`error de WebSocket (${error.message})`);
    });

    connection.socket.on('close', (code) => {
      const wasCurrent = current === connection;
      const alreadyDisposed = connection.disposed;
      disposeConnection(connection);

      if (stopped || alreadyDisposed) {
        return;
      }
      if (!wasCurrent && connection.sessionId !== null) {
        // Sesión vieja cerrada después de migrar: es lo esperado.
        logger.info('eventsub: conexión anterior cerrada tras la migración');
        return;
      }
      scheduleReconnect(`conexión cerrada (código ${code})`);
    });
  }

  return {
    name: 'twitch',

    /** Abre la conexión y se mantiene sola. Idempotente. */
    start() {
      if (!stopped) {
        return;
      }
      stopped = false;
      attempts = 0;
      openConnection(endpoint(), { migration: false });
    },

    /** Cierra todo y deja de reconectar. Idempotente. */
    stop() {
      if (stopped && connections.size === 0) {
        setStatus(CHAT_PROVIDER_STATUS.stopped);
        return;
      }
      stopped = true;
      clearReconnectTimer();
      for (const connection of [...connections]) {
        disposeConnection(connection);
      }
      current = null;
      setStatus(CHAT_PROVIDER_STATUS.stopped);
    },

    getStatus: () => status,

    /** `session_id` de EventSub en uso (lo necesita quien añada suscripciones). */
    getSessionId: () => current?.sessionId ?? null,

    /** Suscripción a los eventos del provider; devuelve la función de baja. */
    on(event, handler) {
      emitter.on(event, handler);
      return () => emitter.off(event, handler);
    },
  };
}
