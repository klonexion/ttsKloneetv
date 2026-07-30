/**
 * Envío de mensajes al chat (T-006): Helix **Send Chat Message**.
 *
 * Publica como el broadcaster con el access token de la sesión (scope
 * `user:write:chat`). El mensaje **no** se inyecta en el relay: vuelve por
 * EventSub como cualquier otro y lo renderiza el store del frontend (que
 * deduplica por `id`), así que hay un único camino de render.
 *
 * Los tokens se piden siempre a `auth/session.js` (`getValidAccessToken()`) y
 * las llamadas van por `twitch/helix.js`: aquí no se lee la tabla `tokens` ni se
 * refresca nada a mano.
 *
 * Para T-012 (`!cambia-mi-voz`): `sendChatMessage(texto)` es el punto de entrada
 * si el backend necesita responder en el chat; no hace falta pasar por HTTP.
 */
import { getChannel, getValidAccessToken } from '../auth/session.js';
import { logger } from '../logger.js';
import { TwitchApiError, helixRequest } from '../twitch/helix.js';

/** Ruta de Helix que publica un mensaje en el chat de un canal. */
export const SEND_MESSAGE_PATH = '/helix/chat/messages';

/** Tope de Twitch para un mensaje de chat. */
export const MAX_MESSAGE_LENGTH = 500;

/**
 * Códigos de fallo del envío. El frontend puede distinguirlos sin parsear
 * textos; el `message` ya viene en español y sin datos sensibles.
 */
export const CHAT_SEND_CODES = Object.freeze({
  empty: 'empty',
  tooLong: 'too_long',
  noSession: 'no_session',
  dropped: 'dropped',
  rejected: 'twitch_rejected',
  unavailable: 'twitch_unavailable',
  failed: 'failed',
});

/** Fallo de un envío, ya traducido a algo que se le puede mostrar al usuario. */
export class ChatSendError extends Error {
  /**
   * @param {string} code     uno de `CHAT_SEND_CODES`.
   * @param {string} message  texto en español, sin tokens ni secretos.
   * @param {number} status   código HTTP con el que responder.
   */
  constructor(code, message, status) {
    super(message);
    this.name = 'ChatSendError';
    this.code = code;
    this.status = status;
  }
}

/** Motivo por el que Twitch descartó un mensaje aceptado (`drop_reason`). */
const describeDropReason = (dropReason) => {
  const detail = typeof dropReason?.message === 'string' && dropReason.message ? dropReason.message : dropReason?.code;
  return typeof detail === 'string' && detail ? detail.replace(/\s+/g, ' ').slice(0, 200) : '';
};

/** Traduce un fallo de Helix (o del refresh) a un `ChatSendError`. */
const translateFailure = (error) => {
  if (error instanceof ChatSendError) {
    return error;
  }

  // `TwitchApiError.permanent` distingue "Twitch dijo no" de "no se pudo llegar".
  // Su mensaje ya viene saneado por el cliente de Helix (sin token ni secreto).
  if (error instanceof TwitchApiError && error.permanent) {
    return new ChatSendError(CHAT_SEND_CODES.rejected, `Twitch rechazó el mensaje (${error.message}).`, 502);
  }
  if (error instanceof TwitchApiError) {
    return new ChatSendError(
      CHAT_SEND_CODES.unavailable,
      'No se pudo contactar a Twitch para enviar el mensaje. Reintentá en unos segundos.',
      503,
    );
  }

  // Cualquier otra cosa (p. ej. un refresh de token que falló de forma
  // transitoria) es un fallo temporal desde el punto de vista de quien envía.
  return new ChatSendError(CHAT_SEND_CODES.unavailable, 'No se pudo enviar el mensaje en este momento.', 503);
};

/**
 * Publica `rawText` en el chat del canal conectado.
 *
 * Devuelve `{ messageId, text }` (`messageId` es el id que asignó Twitch, el
 * mismo con el que el mensaje volverá por EventSub). Lanza `ChatSendError` con
 * `code`/`status` si el texto no es válido, no hay sesión o Twitch no lo aceptó.
 */
export async function sendChatMessage(rawText) {
  const text = typeof rawText === 'string' ? rawText.trim() : '';

  if (text === '') {
    throw new ChatSendError(CHAT_SEND_CODES.empty, 'El mensaje está vacío.', 400);
  }
  if (text.length > MAX_MESSAGE_LENGTH) {
    throw new ChatSendError(
      CHAT_SEND_CODES.tooLong,
      `El mensaje supera los ${MAX_MESSAGE_LENGTH} caracteres que admite Twitch.`,
      400,
    );
  }

  let accessToken;
  try {
    accessToken = await getValidAccessToken();
  } catch (error) {
    throw translateFailure(error);
  }

  const channel = getChannel();
  if (!accessToken || !channel) {
    throw new ChatSendError(
      CHAT_SEND_CODES.noSession,
      'No hay sesión de Twitch activa. Iniciá sesión de nuevo para escribir en el chat.',
      401,
    );
  }

  try {
    const { body } = await helixRequest(SEND_MESSAGE_PATH, {
      method: 'POST',
      accessToken,
      // El broadcaster escribe en su propio canal: emisor y canal son el mismo.
      body: { broadcaster_id: channel.id, sender_id: channel.id, message: text },
    });

    const result = body?.data?.[0] ?? null;

    // Twitch puede aceptar la petición (200) y **descartar** el mensaje: modo
    // solo-seguidores, mensaje repetido, usuario baneado…
    if (result?.is_sent === false) {
      const reason = describeDropReason(result.drop_reason);
      throw new ChatSendError(
        CHAT_SEND_CODES.dropped,
        reason ? `Twitch descartó el mensaje: ${reason}` : 'Twitch descartó el mensaje.',
        422,
      );
    }

    const messageId = typeof result?.message_id === 'string' ? result.message_id : null;
    logger.info(`chat: mensaje publicado en ${channel.login} (${text.length} caracteres)`);

    return { messageId, text };
  } catch (error) {
    throw translateFailure(error);
  }
}
