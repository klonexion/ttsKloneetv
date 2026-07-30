/**
 * Get Chatters de Helix (T-007): quién está presente en el chat del canal,
 * incluso si no ha escrito nada.
 *
 *   GET /helix/chat/chatters?broadcaster_id=<canal>&moderator_id=<canal>
 *
 * Requiere el scope `moderator:read:chatters` (ya está en los scopes que pide
 * T-003) y que el `moderator_id` sea el usuario del token: en la fase 1 el
 * streamer es el broadcaster, así que ambos ids son el mismo.
 *
 * Twitch pagina: devuelve hasta 1000 por página y un `pagination.cursor`
 * mientras queden más. Aquí se recorren todas las páginas antes de devolver la
 * lista, porque la columna de usuarios necesita el roster completo.
 *
 * Todas las llamadas pasan por `helixRequest()` (headers, errores normalizados y
 * `config.twitch.apiBaseUrl`), y el token siempre viene de
 * `getValidAccessToken()`: aquí no se lee la tabla `tokens` ni se refresca nada.
 */
import { helixRequest } from './helix.js';

/** Ruta de Get Chatters. */
export const CHATTERS_ENDPOINT = '/helix/chat/chatters';

/** Máximo que admite Twitch en `first` (elementos por página). */
export const CHATTERS_PAGE_SIZE = 1_000;

/** Scope sin el que Twitch responde 401 a Get Chatters. */
export const CHATTERS_SCOPE = 'moderator:read:chatters';

/** Tope de páginas por consulta: cortafuegos contra un cursor que no avanza. */
const MAX_PAGES = 25;

/** Traduce una entrada cruda de Helix al shape que usa el backend. */
const toChatter = (raw) => {
  const userId = raw?.user_id === undefined || raw?.user_id === null ? '' : String(raw.user_id);
  if (userId === '') {
    return null;
  }
  const username = typeof raw.user_login === 'string' && raw.user_login !== '' ? raw.user_login : userId;
  return {
    userId,
    username,
    displayName: typeof raw.user_name === 'string' && raw.user_name !== '' ? raw.user_name : username,
  };
};

/**
 * Espectadores presentes en el chat del canal, ya paginados y normalizados.
 *
 * @param {object} options
 * @param {string} options.accessToken     de `getValidAccessToken()`.
 * @param {string} options.broadcasterId   id del canal (`getChannel().id`).
 * @param {string} [options.moderatorId]   default: el propio broadcaster.
 * @param {number} [options.pageSize]      `first` de Helix (máx. 1000).
 * @returns {Promise<{ chatters: Array, total: number, pages: number }>}
 */
export async function fetchChatters({ accessToken, broadcasterId, moderatorId = broadcasterId, pageSize = CHATTERS_PAGE_SIZE }) {
  const chatters = [];
  const seen = new Set();
  let cursor = null;
  let pages = 0;
  let total = 0;

  do {
    const query = {
      broadcaster_id: String(broadcasterId),
      moderator_id: String(moderatorId),
      first: Math.min(Math.max(pageSize, 1), CHATTERS_PAGE_SIZE),
    };
    if (cursor !== null) {
      query.after = cursor;
    }

    const { body } = await helixRequest(CHATTERS_ENDPOINT, { accessToken, query });
    pages += 1;

    for (const raw of Array.isArray(body?.data) ? body.data : []) {
      const chatter = toChatter(raw);
      // Un usuario repetido entre páginas (el roster cambia mientras se pagina)
      // no debe duplicar la fila de la columna.
      if (chatter !== null && !seen.has(chatter.userId)) {
        seen.add(chatter.userId);
        chatters.push(chatter);
      }
    }

    if (Number.isFinite(body?.total)) {
      total = body.total;
    }

    const next = typeof body?.pagination?.cursor === 'string' && body.pagination.cursor !== '' ? body.pagination.cursor : null;
    cursor = next === cursor ? null : next;
  } while (cursor !== null && pages < MAX_PAGES);

  return { chatters, total: total || chatters.length, pages };
}
