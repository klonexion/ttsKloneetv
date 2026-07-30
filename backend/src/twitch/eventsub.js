/**
 * Suscripciones de EventSub por Helix (T-004).
 *
 * Leer el chat va por **EventSub WebSocket** (`channel.chat.message`); IRC está
 * deprecado para comandos desde 2023. El transporte `websocket` obliga a este
 * baile: primero se abre el WebSocket, y con el `session_id` que llega en el
 * `session_welcome` se crea la suscripción por HTTP:
 *
 *     POST {apiBaseUrl}/helix/eventsub/subscriptions
 *     { type, version, condition, transport: { method: 'websocket', session_id } }
 *
 * Twitch responde `202 Accepted`. Hay un plazo de ~10 s desde el welcome para
 * suscribirse o cierra la conexión (código 4003).
 *
 * Para T-007/T-008: si necesitan otro evento (p. ej. `channel.chat.notification`),
 * añadan aquí una constante como `CHAT_MESSAGE_SUBSCRIPTION` y llamen a
 * `createEventSubSubscription()` con el `sessionId` que expone el provider
 * (`provider.getSessionId()`), sin abrir otro WebSocket.
 */
import { TwitchApiError, helixRequest } from './helix.js';

/** Suscripción que necesita el chat: mensajes del canal propio. */
export const CHAT_MESSAGE_SUBSCRIPTION = Object.freeze({
  type: 'channel.chat.message',
  version: '1',
});

/** Ruta de EventSub en Helix. */
export const EVENTSUB_SUBSCRIPTIONS_PATH = '/helix/eventsub/subscriptions';

/**
 * Crea una suscripción de EventSub sobre una sesión de WebSocket ya establecida.
 * Devuelve `{ id, status, alreadyExisted }`.
 *
 * @param {object} params
 * @param {string} params.sessionId    `session_id` del `session_welcome`.
 * @param {object} params.condition    condición del evento (ids de Twitch).
 * @param {string} params.accessToken  access token de usuario.
 */
export async function createEventSubSubscription({
  sessionId,
  type,
  version,
  condition,
  accessToken,
  twitch = undefined,
}) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new TwitchApiError('no hay session_id de EventSub para suscribirse', { permanent: true });
  }

  const payload = {
    type,
    version,
    condition,
    transport: { method: 'websocket', session_id: sessionId },
  };

  try {
    const { body } = await helixRequest(EVENTSUB_SUBSCRIPTIONS_PATH, {
      method: 'POST',
      accessToken,
      body: payload,
      ...(twitch ? { twitch } : {}),
    });

    const subscription = Array.isArray(body?.data) ? body.data[0] : null;
    return {
      id: subscription?.id ?? null,
      status: subscription?.status ?? 'unknown',
      alreadyExisted: false,
    };
  } catch (error) {
    // 409 = ya existe una suscripción idéntica para esta sesión: es el estado
    // que queríamos, no un fallo.
    if (error instanceof TwitchApiError && error.status === 409) {
      return { id: null, status: 'enabled', alreadyExisted: true };
    }
    throw error;
  }
}

/**
 * Suscribe la sesión a los mensajes del chat del canal. `user_id` es el usuario
 * que lee (el propio broadcaster: el token es suyo y trae `user:read:chat`).
 */
export function createChatMessageSubscription({ sessionId, broadcasterUserId, userId = broadcasterUserId, accessToken, twitch = undefined }) {
  if (typeof broadcasterUserId !== 'string' || broadcasterUserId === '') {
    throw new TwitchApiError('no se conoce el id del canal para suscribirse al chat', { permanent: true });
  }

  return createEventSubSubscription({
    sessionId,
    type: CHAT_MESSAGE_SUBSCRIPTION.type,
    version: CHAT_MESSAGE_SUBSCRIPTION.version,
    condition: {
      broadcaster_user_id: String(broadcasterUserId),
      user_id: String(userId),
    },
    accessToken,
    twitch,
  });
}
