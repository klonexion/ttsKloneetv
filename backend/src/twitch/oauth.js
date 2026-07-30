/**
 * Cliente HTTP del OAuth de Twitch (T-003): authorization code flow.
 *
 * Endpoints reales (los defaults de `config.twitch`):
 * - `GET  {authBaseUrl}/oauth2/authorize` → pantalla de consentimiento.
 * - `POST {authBaseUrl}/oauth2/token`     → code → tokens y refresh → tokens.
 * - `GET  {apiBaseUrl}/helix/users`       → identidad del broadcaster.
 *
 * Las URLs base son configurables (`TWITCH_AUTH_BASE_URL`/`TWITCH_API_BASE_URL`)
 * para poder ejercitar el flujo entero contra `scripts/fake-twitch.js`.
 *
 * Regla del proyecto: ni los tokens ni el `client_secret` aparecen nunca en un
 * log ni en el mensaje de un error.
 */
import { config } from '../config.js';

/** Error de una llamada al OAuth de Twitch, sin datos sensibles en el mensaje. */
export class TwitchOAuthError extends Error {
  /**
   * @param {string} message  descripción segura (sin tokens ni secretos).
   * @param {object} [options]
   * @param {number} [options.status]     código HTTP (0 si no hubo respuesta).
   * @param {boolean} [options.permanent] `true` si reintentar no sirve (la
   *   credencial fue rechazada); `false` para fallos transitorios (red, 5xx).
   */
  constructor(message, { status = 0, permanent = false } = {}) {
    super(message);
    this.name = 'TwitchOAuthError';
    this.status = status;
    this.permanent = permanent;
  }
}

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

/** Normaliza la respuesta del endpoint de token al vocabulario del proyecto. */
const toTokenSet = (body) => {
  const accessToken = body?.access_token;
  const refreshToken = body?.refresh_token;
  const expiresIn = Number(body?.expires_in);

  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new TwitchOAuthError('la respuesta de Twitch no trae access_token', { permanent: true });
  }

  return {
    accessToken,
    // En un refresh Twitch puede omitir el refresh_token: el llamador conserva el anterior.
    refreshToken: typeof refreshToken === 'string' && refreshToken !== '' ? refreshToken : null,
    expiresInSeconds: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600,
    scopes: Array.isArray(body?.scope) ? body.scope : String(body?.scope ?? '').split(' ').filter(Boolean),
  };
};

/**
 * URL de la pantalla de consentimiento de Twitch. El `state` es obligatorio:
 * es la protección CSRF que valida `/auth/callback`.
 */
export function buildAuthorizeUrl({ state, twitch = config.twitch } = {}) {
  if (typeof state !== 'string' || state === '') {
    throw new TypeError('buildAuthorizeUrl necesita un `state` no vacío');
  }

  const url = new URL(`${twitch.authBaseUrl}/oauth2/authorize`);
  url.searchParams.set('client_id', twitch.clientId);
  url.searchParams.set('redirect_uri', twitch.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', twitch.scopes.join(' '));
  url.searchParams.set('state', state);

  return url.toString();
}

/** POST al endpoint de token con el cuerpo `application/x-www-form-urlencoded`. */
async function requestTokens(params, { twitch = config.twitch } = {}) {
  const endpoint = `${twitch.authBaseUrl}/oauth2/token`;

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: twitch.clientId,
        client_secret: twitch.clientSecret,
        ...params,
      }),
    });
  } catch (error) {
    // Fallo de red/DNS: transitorio, conviene reintentar más tarde.
    throw new TwitchOAuthError(`no se pudo contactar el OAuth de Twitch (${error.message})`, { permanent: false });
  }

  const body = await parseJsonSafely(response);

  if (!response.ok) {
    // 400/401 = credencial rechazada (code usado, refresh token revocado…).
    const permanent = response.status === 400 || response.status === 401 || response.status === 403;
    throw new TwitchOAuthError(`Twitch rechazó la petición de token: ${describeFailure(response.status, body)}`, {
      status: response.status,
      permanent,
    });
  }

  return toTokenSet(body);
}

/** Canjea el `code` del callback por el par access/refresh token. */
export function exchangeCodeForTokens(code, { twitch = config.twitch } = {}) {
  return requestTokens(
    {
      code,
      grant_type: 'authorization_code',
      redirect_uri: twitch.redirectUri,
    },
    { twitch },
  );
}

/** Pide un access token nuevo a partir del refresh token guardado. */
export function refreshTokens(refreshToken, { twitch = config.twitch } = {}) {
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    throw new TwitchOAuthError('no hay refresh token guardado', { permanent: true });
  }

  return requestTokens({ grant_type: 'refresh_token', refresh_token: refreshToken }, { twitch });
}

/**
 * Identidad del dueño del access token (`GET /helix/users` sin parámetros).
 * Devuelve `{ id, login, displayName }`: es el canal del broadcaster.
 */
export async function fetchAuthenticatedUser(accessToken, { twitch = config.twitch } = {}) {
  const endpoint = `${twitch.apiBaseUrl}/helix/users`;

  let response;
  try {
    response = await fetch(endpoint, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        'client-id': twitch.clientId,
      },
    });
  } catch (error) {
    throw new TwitchOAuthError(`no se pudo contactar la API de Twitch (${error.message})`, { permanent: false });
  }

  const body = await parseJsonSafely(response);

  if (!response.ok) {
    const permanent = response.status === 400 || response.status === 401 || response.status === 403;
    throw new TwitchOAuthError(`Twitch rechazó la consulta de usuario: ${describeFailure(response.status, body)}`, {
      status: response.status,
      permanent,
    });
  }

  const user = Array.isArray(body?.data) ? body.data[0] : null;
  if (!user?.id) {
    throw new TwitchOAuthError('la respuesta de /helix/users no trae usuario', { permanent: true });
  }

  return {
    id: String(user.id),
    login: String(user.login ?? ''),
    displayName: String(user.display_name ?? user.login ?? ''),
  };
}
