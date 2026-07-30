/**
 * Sesión de Twitch del backend (T-003): persistencia de tokens, identidad del
 * canal y refresh automático.
 *
 * Es la única puerta a los tokens. Punto de enganche para las tareas
 * siguientes:
 *
 *     import { getValidAccessToken } from '../auth/session.js';
 *     const accessToken = await getValidAccessToken();  // null = sin sesión
 *
 * `getValidAccessToken()` refresca por adelantado si hace falta, así que
 * T-004 (EventSub) y T-006 (Helix send) nunca deben leer la tabla `tokens`
 * directamente ni implementar su propio refresh.
 *
 * El estado vive **solo** en SQLite (nada cacheado en memoria): así un cambio
 * externo en la base —por ejemplo forzar `expires_at` al pasado para probar el
 * refresh— se ve en el siguiente ciclo sin reiniciar el proceso.
 */
import { config } from '../config.js';
import { getRepositories } from '../db/index.js';
import { SETTING_KEYS } from '../db/repositories/settings.js';
import { DEFAULT_PROVIDER } from '../db/repositories/tokens.js';
import { logger } from '../logger.js';
import { TwitchOAuthError, fetchAuthenticatedUser, refreshTokens } from '../twitch/oauth.js';

/** Proveedor de la fase 1: una sola fila en `tokens`. */
export const PROVIDER = DEFAULT_PROVIDER;

/** Refresh en curso, para que varios llamadores compartan una sola llamada. */
let refreshInFlight = null;

/** Timer del ciclo de refresco (`startTokenRefreshLoop`). */
let refreshTimer = null;

/** Tokens guardados del proveedor, o `null` si no hay sesión. */
const readTokens = () => getRepositories().tokens.get(PROVIDER);

/**
 * `true` si el access token ya expiró o expira dentro del margen de refresco.
 * `expiresAt` es ms epoch UTC (convención de la capa de datos, T-002).
 */
export function needsRefresh(tokens, now = Date.now(), marginMs = config.twitch.refreshMarginMs) {
  return !tokens || tokens.expiresAt - now <= marginMs;
}

/** Identidad del canal autenticado, o `null` si no está guardada. */
export function getChannel() {
  const { settings } = getRepositories();
  const id = settings.get(SETTING_KEYS.twitchUserId);
  if (!id) {
    return null;
  }

  const login = settings.get(SETTING_KEYS.twitchLogin, '');
  return {
    id,
    login,
    displayName: settings.get(SETTING_KEYS.twitchDisplayName, login),
  };
}

/** Guarda la identidad del canal (`app_settings`, ver `SETTING_KEYS`). */
export function saveChannel({ id, login, displayName }) {
  getRepositories().settings.setAll({
    [SETTING_KEYS.twitchUserId]: id,
    [SETTING_KEYS.twitchLogin]: login,
    [SETTING_KEYS.twitchDisplayName]: displayName || login,
  });
  return getChannel();
}

/**
 * Estado que consume el frontend por `GET /api/session`. Nunca incluye tokens:
 * solo si hay sesión y de qué canal es.
 */
export function getSession() {
  const tokens = readTokens();
  return {
    authenticated: tokens !== null,
    channel: tokens === null ? null : getChannel(),
  };
}

/**
 * Persiste un juego de tokens recién obtenido de Twitch. `save()` es un upsert
 * por proveedor, así que un refresh actualiza la fila en vez de duplicarla.
 */
export function saveTokens(tokenSet, { previousRefreshToken = null, now = Date.now() } = {}) {
  const refreshToken = tokenSet.refreshToken ?? previousRefreshToken;
  if (!refreshToken) {
    throw new TwitchOAuthError('Twitch no devolvió refresh token y no hay uno previo', { permanent: true });
  }

  return getRepositories().tokens.save({
    provider: PROVIDER,
    accessToken: tokenSet.accessToken,
    refreshToken,
    expiresAt: now + tokenSet.expiresInSeconds * 1000,
    scopes: tokenSet.scopes,
  });
}

/** Borra la sesión: tokens y identidad del canal. */
export function clearSession() {
  const { settings, tokens } = getRepositories();
  const removed = tokens.delete(PROVIDER);
  for (const key of [SETTING_KEYS.twitchUserId, SETTING_KEYS.twitchLogin, SETTING_KEYS.twitchDisplayName]) {
    settings.delete(key);
  }
  return removed;
}

/**
 * Completa el login: guarda los tokens del canje y resuelve la identidad del
 * canal con el access token nuevo. Devuelve la sesión resultante.
 */
export async function establishSession(tokenSet) {
  saveTokens(tokenSet);

  try {
    const channel = await fetchAuthenticatedUser(tokenSet.accessToken);
    saveChannel(channel);
  } catch (error) {
    // Sin identidad la sesión es inútil (T-004 necesita el broadcaster id):
    // no dejar tokens huérfanos a medias.
    clearSession();
    throw error;
  }

  return getSession();
}

async function performRefresh() {
  const stored = readTokens();
  if (!stored) {
    return null;
  }

  try {
    const tokenSet = await refreshTokens(stored.refreshToken);
    const saved = saveTokens(tokenSet, { previousRefreshToken: stored.refreshToken });
    logger.info('twitch: access token refrescado');

    // Si el canal aún no estaba resuelto (base migrada a mano, fallo previo),
    // aprovechar el token nuevo para completarlo.
    if (!getChannel()) {
      try {
        saveChannel(await fetchAuthenticatedUser(saved.accessToken));
      } catch (error) {
        logger.warn(`twitch: no se pudo resolver el canal (${error.message})`);
      }
    }

    return saved;
  } catch (error) {
    if (error instanceof TwitchOAuthError && error.permanent) {
      clearSession();
      logger.error(`twitch: refresh rechazado (${error.message}); hay que volver a iniciar sesión`);
      return null;
    }

    logger.warn(`twitch: refresh fallido, se reintentará (${error.message})`);
    throw error;
  }
}

/**
 * Refresca el access token con el refresh token guardado. Varias llamadas
 * simultáneas comparten la misma petición. Devuelve los tokens nuevos, o `null`
 * si no había sesión o si Twitch rechazó el refresh (en ese caso la sesión se
 * borra: el usuario tiene que volver a autorizar).
 */
export function refreshSession() {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = performRefresh().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

/**
 * Access token válido para llamar a la API de Twitch, refrescando por
 * adelantado si está por expirar. `null` si no hay sesión.
 */
export async function getValidAccessToken() {
  const stored = readTokens();
  if (!stored) {
    return null;
  }
  if (!needsRefresh(stored)) {
    return stored.accessToken;
  }

  const refreshed = await refreshSession();
  return refreshed?.accessToken ?? null;
}

/**
 * Revisa periódicamente la expiración y refresca sin que nadie lo pida: así el
 * token sigue vivo aunque el frontend esté cerrado. Devuelve `{ stop, tick }`
 * (`tick` es la comprobación suelta, útil para pruebas).
 */
export function startTokenRefreshLoop({ intervalMs = config.twitch.tokenCheckIntervalMs } = {}) {
  const tick = async () => {
    const stored = readTokens();
    if (!stored || !needsRefresh(stored)) {
      return;
    }
    try {
      await refreshSession();
    } catch {
      // `performRefresh` ya lo logueó; se reintenta en el siguiente ciclo.
    }
  };

  stopTokenRefreshLoop();
  refreshTimer = setInterval(() => void tick(), Math.max(intervalMs, 100));
  refreshTimer.unref?.();
  void tick();

  return { stop: stopTokenRefreshLoop, tick };
}

/** Detiene el ciclo de refresco (lo llama el shutdown del servidor). */
export function stopTokenRefreshLoop() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
