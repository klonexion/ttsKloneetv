/**
 * Identidad de viewers (T-014): flujo de Twitch OAuth separado del bot, para
 * que un espectador pruebe "soy yo" — hoy pensado para la pantalla de
 * "!configura-mi-voz", pero sirve para cualquier acción futura que necesite
 * saber qué viewer de Twitch está del otro lado.
 *
 * Tres garantías que lo distinguen de `./session.js` (la sesión del bot) y que
 * no hay que romper:
 *
 * 1. **Nunca toca la tabla `tokens`.** Esa fila (`provider = 'twitch'`) es la
 *    credencial con la que el bot lee/escribe el chat y modera; es una sola
 *    fila (`PRIMARY KEY`), así que si un viewer pasara por el mismo intercambio
 *    la pisaría. Este módulo pide el access token del viewer, lo usa una vez
 *    para `fetchAuthenticatedUser()` y lo descarta: no se persiste en ningún
 *    lado.
 * 2. **Redirect URI propio.** `config.viewerAuth.redirectUri` es una URL
 *    distinta de `config.twitch.redirectUri` (que apunta a `/auth/callback`,
 *    el del bot). Si no está configurada, el flujo entero queda deshabilitado
 *    (`isViewerAuthEnabled() === false`) en vez de reusar la del bot por
 *    default silenciosamente.
 * 3. **Sin scopes.** La única llamada que se hace con el token del viewer es
 *    `GET /helix/users`, que no exige ningún scope — así que no hace falta
 *    (ni se pide) permiso para leer/escribir chat ni moderar, aunque la app
 *    ya tenga esos scopes habilitados para el bot.
 */
import { config } from '../config.js';
import { getRepositories } from '../db/index.js';
import { logger } from '../logger.js';
import { buildAuthorizeUrl, exchangeCodeForTokens, fetchAuthenticatedUser } from '../twitch/oauth.js';

/** `true` si `TWITCH_VIEWER_REDIRECT_URI` está configurada. */
export const isViewerAuthEnabled = () => config.viewerAuth.enabled;

/**
 * Config de Twitch para el flujo de viewer: mismo client id/secret y mismos
 * endpoints base que el bot, pero con el redirect URI y los scopes del viewer.
 * `buildAuthorizeUrl`/`exchangeCodeForTokens`/`fetchAuthenticatedUser` de
 * `../twitch/oauth.js` ya aceptan un `twitch` de reemplazo, así que no hace
 * falta tocar ese módulo.
 */
function viewerTwitchConfig() {
  return {
    ...config.twitch,
    redirectUri: config.viewerAuth.redirectUri,
    scopes: config.viewerAuth.scopes,
  };
}

/** URL de la pantalla de consentimiento de Twitch para el login de un viewer. */
export function buildViewerAuthorizeUrl({ state }) {
  if (!isViewerAuthEnabled()) {
    throw new Error('el login de viewers no está habilitado (falta TWITCH_VIEWER_REDIRECT_URI)');
  }
  return buildAuthorizeUrl({ state, twitch: viewerTwitchConfig() });
}

/**
 * Canjea el `code` del callback, identifica al viewer y le crea una fila en
 * `viewer_sessions`. El token de Twitch que devuelve el canje se usa una sola
 * vez, acá adentro, y no sale de esta función.
 */
export async function completeViewerLogin(code) {
  const twitch = viewerTwitchConfig();
  const tokenSet = await exchangeCodeForTokens(code, { twitch });
  const identity = await fetchAuthenticatedUser(tokenSet.accessToken, { twitch });

  const session = getRepositories().viewerSessions.create({
    twitchUserId: identity.id,
    username: identity.login,
    displayName: identity.displayName,
    ttlMs: config.viewerAuth.sessionTtlMs,
  });

  logger.info(`viewer-auth: login de ${identity.displayName} (${identity.id})`);
  return session;
}

/** La sesión de viewer vigente, o `null` si no existe o ya expiró. */
export function getViewerSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    return null;
  }
  return getRepositories().viewerSessions.get(sessionId);
}

/** Cierra la sesión del viewer (logout). `true` si había algo que borrar. */
export function destroyViewerSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    return false;
  }
  return getRepositories().viewerSessions.delete(sessionId);
}
