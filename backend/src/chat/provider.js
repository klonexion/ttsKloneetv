/**
 * Interfaz adapter `ChatProvider` (T-004).
 *
 * Un provider es la fuente de mensajes de una plataforma de chat. La fase 1 solo
 * trae `TwitchProvider` (`./twitch-provider.js`); la fase 2 añadirá YouTube y
 * TikTok **sin tocar el frontend**, porque todos emiten el mismo shape
 * normalizado y agnóstico de plataforma:
 *
 *     { id, userId, username, displayName, text, timestamp }
 *
 * Contrato que debe cumplir cualquier implementación:
 *
 * - `name`                     identificador corto (`'twitch'`).
 * - `start()`                  abre la conexión y se suscribe; idempotente.
 * - `stop()`                   cierra todo y deja de reconectar; idempotente.
 * - `getStatus()`              uno de `CHAT_PROVIDER_STATUS`.
 * - `on(event, handler)`       suscripción a `CHAT_PROVIDER_EVENTS`; devuelve la
 *                              función de baja.
 *
 * Eventos:
 *
 * - `message`      un mensaje normalizado (ya deduplicado por `id`).
 * - `status`       cambió el estado de la conexión.
 * - `error`        fallo recuperable (ya logueado); informativo.
 * - `auth-invalid` la credencial no sirve: el supervisor (`./relay.js`) para el
 *                  provider y espera a que haya sesión otra vez.
 *
 * Reconectar es responsabilidad del provider: quien lo consume solo llama a
 * `start()` una vez.
 */

/** Eventos que emite un `ChatProvider`. */
export const CHAT_PROVIDER_EVENTS = Object.freeze({
  message: 'message',
  status: 'status',
  error: 'error',
  authInvalid: 'auth-invalid',
});

/** Estados posibles de la conexión de un provider. */
export const CHAT_PROVIDER_STATUS = Object.freeze({
  /** Creado, todavía sin `start()`. */
  idle: 'idle',
  /** Abriendo el WebSocket. */
  connecting: 'connecting',
  /** Conectado, pendiente de suscribirse. */
  connected: 'connected',
  /** Suscrito: los mensajes están fluyendo. */
  subscribed: 'subscribed',
  /** Se perdió la conexión y hay un reintento agendado. */
  reconnecting: 'reconnecting',
  /** Detenido por `stop()`. */
  stopped: 'stopped',
});

/** Claves exactas del mensaje normalizado (sin campos crudos de la plataforma). */
export const CHAT_MESSAGE_FIELDS = Object.freeze(['id', 'userId', 'username', 'displayName', 'text', 'timestamp']);

/**
 * `true` si el valor cumple el shape normalizado. Lo usa el relay como red de
 * seguridad: al frontend nunca debe llegar una trama a medias.
 */
export function isNormalizedChatMessage(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (Object.keys(value).length !== CHAT_MESSAGE_FIELDS.length) {
    return false;
  }
  return CHAT_MESSAGE_FIELDS.every((field) => typeof value[field] === 'string' && value[field] !== '');
}

/**
 * Filtro de ids ya vistos, con capacidad acotada (FIFO).
 *
 * Hace falta porque durante una migración de sesión (`session_reconnect`) las
 * dos conexiones pueden solapar unos instantes y entregar el mismo evento: sin
 * esto, un mensaje haría dos veces upsert del usuario.
 */
export function createSeenIdFilter({ capacity = 500 } = {}) {
  const ids = new Set();
  const order = [];

  return {
    /** Registra el id; `true` si es nuevo, `false` si ya se había visto. */
    add(id) {
      if (ids.has(id)) {
        return false;
      }
      ids.add(id);
      order.push(id);
      while (order.length > capacity) {
        ids.delete(order.shift());
      }
      return true;
    },
    has: (id) => ids.has(id),
    clear() {
      ids.clear();
      order.length = 0;
    },
    get size() {
      return ids.size;
    },
  };
}
