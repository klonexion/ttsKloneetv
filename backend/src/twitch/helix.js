/**
 * Cliente HTTP mínimo de la API Helix de Twitch (T-004).
 *
 * Todas las llamadas a Helix del backend pasan por aquí: añade los headers
 * obligatorios (`Authorization: Bearer` + `Client-Id`), normaliza los errores y
 * distingue lo permanente (credencial rechazada) de lo transitorio (red, 5xx).
 *
 * Punto de enganche para T-006 (enviar mensajes) y T-007 (Get Chatters):
 *
 *     import { getValidAccessToken } from '../auth/session.js';
 *     import { helixRequest } from '../twitch/helix.js';
 *
 *     const accessToken = await getValidAccessToken();          // null = sin sesión
 *     await helixRequest('/helix/chat/messages', { method: 'POST', accessToken, body });
 *
 * La URL base es `config.twitch.apiBaseUrl` (default: el endpoint real de
 * Twitch), configurable para apuntar al imitador local de `scripts/`.
 *
 * Regla del proyecto: ni el token ni el `client_secret` aparecen nunca en un log
 * ni en el mensaje de un error.
 */
import { config } from '../config.js';

/** Error de una llamada a Helix, sin datos sensibles en el mensaje. */
export class TwitchApiError extends Error {
  /**
   * @param {string} message  descripción segura (sin tokens ni secretos).
   * @param {object} [options]
   * @param {number} [options.status]     código HTTP (0 si no hubo respuesta).
   * @param {boolean} [options.permanent] `true` si reintentar no sirve.
   */
  constructor(message, { status = 0, permanent = false } = {}) {
    super(message);
    this.name = 'TwitchApiError';
    this.status = status;
    this.permanent = permanent;
  }
}

/** Códigos en los que reintentar la misma petición no cambia nada. */
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 422]);

/** Mensaje de error de Twitch (campo `message`), saneado a una línea. */
const describeFailure = (status, body) => {
  const detail = typeof body?.message === 'string' && body.message ? body.message : `HTTP ${status}`;
  return detail.replace(/\s+/g, ' ').slice(0, 200);
};

const parseJsonSafely = async (response) => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

/**
 * Petición a Helix. Devuelve `{ status, body }` (body `null` si no hubo JSON).
 *
 * @param {string} pathname          ruta absoluta, p. ej. `/helix/eventsub/subscriptions`.
 * @param {object} options
 * @param {string} options.accessToken  access token de usuario (de `getValidAccessToken()`).
 * @param {string} [options.method]     verbo HTTP (default `GET`).
 * @param {object} [options.query]      query string; los arrays se repiten.
 * @param {object} [options.body]       cuerpo JSON (se serializa).
 * @param {object} [options.twitch]     override de `config.twitch` (pruebas).
 */
export async function helixRequest(pathname, { accessToken, method = 'GET', query = null, body = null, twitch = config.twitch } = {}) {
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new TwitchApiError('no hay access token para llamar a Helix', { permanent: true });
  }

  const url = new URL(`${twitch.apiBaseUrl}${pathname}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, String(item));
      }
    } else if (value !== null && value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = {
    authorization: `Bearer ${accessToken}`,
    'client-id': twitch.clientId,
  };
  if (body !== null) {
    headers['content-type'] = 'application/json';
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    // Fallo de red/DNS: transitorio, conviene reintentar más tarde.
    throw new TwitchApiError(`no se pudo contactar la API de Twitch (${error.message})`, { permanent: false });
  }

  const payload = response.status === 204 ? null : await parseJsonSafely(response);

  if (!response.ok) {
    throw new TwitchApiError(`Twitch rechazó ${method} ${pathname}: ${describeFailure(response.status, payload)}`, {
      status: response.status,
      permanent: PERMANENT_STATUSES.has(response.status),
    });
  }

  return { status: response.status, body: payload };
}
