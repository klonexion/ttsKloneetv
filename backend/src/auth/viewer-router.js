/**
 * Rutas del login de viewers (T-014), montadas en `/viewer-auth` — deliberadamente
 * separadas de `/auth` (eso es el bot, ver `./router.js`):
 *
 * - `GET  /viewer-auth/login`    → 302 a la pantalla de consentimiento de Twitch.
 * - `GET  /viewer-auth/callback` → canjea el `code`, crea la sesión del viewer
 *   (cookie `viewer_session`, tabla `viewer_sessions`) y vuelve a `return_to`.
 * - `GET  /viewer-auth/me`       → `{ authenticated, user }` para que la pantalla
 *   de turno sepa quién está logueado.
 * - `POST /viewer-auth/logout`   → cierra la sesión del viewer.
 *
 * Si `TWITCH_VIEWER_REDIRECT_URI` no está configurada, todo el router responde
 * 404 (`isViewerAuthEnabled() === false`): mejor eso que arrancar un flujo que
 * no tiene a dónde volver.
 *
 * El `state` es un nonce de un solo uso en memoria, igual que en `./router.js`
 * — instancia propia, no comparte mapa con el login del bot.
 *
 * **Los redirects son siempre relativos** (`res.redirect(returnTo)`, nunca
 * `new URL(returnTo, algo)`): este router vive en `viewer/server.js` (T-015),
 * un proceso propio y sin relación con `config.frontendUrl` (esa es la URL del
 * frontend *admin*, un origen totalmente distinto). Un redirect relativo
 * vuelve al mismo origen desde el que se abrió el login sin importar si ese
 * origen es `localhost:3100` en dev o el hostname público en producción.
 */
import crypto from 'node:crypto';

import express from 'express';

import { config } from '../config.js';
import { logger } from '../logger.js';
import { TwitchOAuthError } from '../twitch/oauth.js';
import {
  buildViewerAuthorizeUrl,
  completeViewerLogin,
  destroyViewerSession,
  getViewerSession,
  isViewerAuthEnabled,
} from './viewer-session.js';

/** Nombre de la cookie de sesión del viewer. Separada de la del bot (no hay tal cookie hoy). */
export const VIEWER_SESSION_COOKIE = 'viewer_session';

/** Vida del `state` pendiente: lo que puede tardar el consentimiento. */
export const STATE_TTL_MS = 10 * 60 * 1000;

/** Códigos de error que `return_to` puede recibir en `?viewer_auth_error=`. */
export const VIEWER_AUTH_ERROR_CODES = Object.freeze({
  denied: 'denied',
  state: 'state',
  missingCode: 'missing_code',
  exchange: 'exchange',
});

/** Lee una cookie del header `Cookie` a mano (el backend no usa cookie-parser). */
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (typeof header !== 'string') {
    return null;
  }
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      continue;
    }
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Solo rutas relativas propias (`/lo-que-sea`), nunca `//host` (ese es un
 * open-redirect: el navegador lo trata como protocol-relative a otro host).
 */
function isSafeReturnTo(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//');
}

export function createViewerAuthRouter() {
  const router = express.Router();

  /** `true` si el login de viewers está habilitado; si no, el router entero es un 404. */
  router.use((req, res, next) => {
    if (!isViewerAuthEnabled()) {
      res.status(404).json({ error: 'el login de viewers no está habilitado en esta instalación' });
      return;
    }
    next();
  });

  /** `state` emitidos y todavía sin usar → `{ createdAt, returnTo }`. */
  const pendingStates = new Map();

  const pruneStates = (now = Date.now()) => {
    for (const [state, entry] of pendingStates) {
      if (now - entry.createdAt > STATE_TTL_MS) {
        pendingStates.delete(state);
      }
    }
  };

  const redirectWithError = (res, returnTo, errorCode) => {
    const separator = returnTo.includes('?') ? '&' : '?';
    res.redirect(`${returnTo}${separator}viewer_auth_error=${encodeURIComponent(errorCode)}`);
  };

  router.get('/login', (req, res) => {
    pruneStates();

    const returnTo = isSafeReturnTo(req.query.return_to) ? req.query.return_to : '/';
    const state = crypto.randomBytes(16).toString('hex');
    pendingStates.set(state, { createdAt: Date.now(), returnTo });

    logger.info('viewer-auth: redirigiendo a Twitch para autorizar');
    res.redirect(buildViewerAuthorizeUrl({ state }));
  });

  router.get('/callback', async (req, res) => {
    const { code, state, error, error_description: errorDescription } = req.query;

    pruneStates();
    const pending = typeof state === 'string' ? pendingStates.get(state) : null;
    const returnTo = pending?.returnTo ?? '/';

    if (typeof error === 'string' && error !== '') {
      logger.warn(`viewer-auth: Twitch no autorizó (${error}${errorDescription ? `: ${errorDescription}` : ''})`);
      if (pending) {
        pendingStates.delete(state);
      }
      redirectWithError(res, returnTo, VIEWER_AUTH_ERROR_CODES.denied);
      return;
    }

    if (!pending || !pendingStates.delete(state)) {
      logger.warn('viewer-auth: callback con `state` desconocido o repetido, descartado');
      redirectWithError(res, returnTo, VIEWER_AUTH_ERROR_CODES.state);
      return;
    }

    if (typeof code !== 'string' || code === '') {
      logger.warn('viewer-auth: callback sin `code`');
      redirectWithError(res, returnTo, VIEWER_AUTH_ERROR_CODES.missingCode);
      return;
    }

    let session;
    try {
      session = await completeViewerLogin(code);
    } catch (err) {
      const message = err instanceof TwitchOAuthError ? err.message : 'fallo inesperado';
      logger.error(`viewer-auth: no se pudo completar el login (${message})`);
      redirectWithError(res, returnTo, VIEWER_AUTH_ERROR_CODES.exchange);
      return;
    }

    res.cookie(VIEWER_SESSION_COOKIE, session.sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.https.enabled,
      maxAge: config.viewerAuth.sessionTtlMs,
      path: '/',
    });

    res.redirect(returnTo);
  });

  router.get('/me', (req, res) => {
    const sessionId = readCookie(req, VIEWER_SESSION_COOKIE);
    const session = getViewerSession(sessionId);

    if (!session) {
      res.json({ authenticated: false, user: null });
      return;
    }

    res.json({
      authenticated: true,
      user: { id: session.twitchUserId, login: session.username, displayName: session.displayName },
      expiresAt: session.expiresAt,
    });
  });

  router.post('/logout', (req, res) => {
    const sessionId = readCookie(req, VIEWER_SESSION_COOKIE);
    if (sessionId) {
      destroyViewerSession(sessionId);
    }
    res.clearCookie(VIEWER_SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  return router;
}

/**
 * Middleware para rutas que necesitan saber qué viewer está logueado (p. ej.
 * guardar su elección de voz). Deja `req.viewerSession` puesta, o responde 401
 * si no hay sesión vigente.
 */
export function requireViewerSession(req, res, next) {
  const sessionId = readCookie(req, VIEWER_SESSION_COOKIE);
  const session = getViewerSession(sessionId);

  if (!session) {
    res.status(401).json({ error: 'sin sesión de viewer; iniciá sesión de nuevo' });
    return;
  }

  req.viewerSession = session;
  next();
}
