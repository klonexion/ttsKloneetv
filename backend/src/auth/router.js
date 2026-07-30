/**
 * Rutas del OAuth de Twitch (T-003), montadas en `/auth`:
 *
 * - `GET /auth/login`    → 302 a la pantalla de consentimiento de Twitch.
 * - `GET /auth/callback` → canjea el `code`, persiste la sesión y devuelve el
 *   navegador al frontend. Es el redirect URI registrado en dev.twitch.tv
 *   (`http://localhost:3000/auth/callback`).
 *
 * El `state` es un nonce de un solo uso guardado en memoria: la app es local y
 * de un solo usuario, así que no necesita almacenamiento compartido, y perderlo
 * en un reinicio solo obliga a volver a pulsar el botón de login.
 */
import crypto from 'node:crypto';

import express from 'express';

import { config } from '../config.js';
import { logger } from '../logger.js';
import { buildAuthorizeUrl, exchangeCodeForTokens } from '../twitch/oauth.js';
import { establishSession } from './session.js';

/** Vida del `state` pendiente: lo que puede tardar el consentimiento. */
export const STATE_TTL_MS = 10 * 60 * 1000;

/** Códigos de error que el frontend puede recibir en `?auth_error=`. */
export const AUTH_ERROR_CODES = Object.freeze({
  denied: 'denied',
  state: 'state',
  missingCode: 'missing_code',
  exchange: 'exchange',
});

/** URL del frontend a la que volver, con `?auth_error=` si algo falló. */
function frontendRedirect(errorCode = null) {
  const url = new URL(`${config.frontendUrl}/`);
  if (errorCode) {
    url.searchParams.set('auth_error', errorCode);
  }
  return url.toString();
}

export function createAuthRouter() {
  const router = express.Router();

  /** `state` emitidos y todavía sin usar → instante de emisión. */
  const pendingStates = new Map();

  const pruneStates = (now = Date.now()) => {
    for (const [state, createdAt] of pendingStates) {
      if (now - createdAt > STATE_TTL_MS) {
        pendingStates.delete(state);
      }
    }
  };

  router.get('/login', (req, res) => {
    pruneStates();

    const state = crypto.randomBytes(16).toString('hex');
    pendingStates.set(state, Date.now());

    logger.info('auth: redirigiendo a Twitch para autorizar');
    res.redirect(buildAuthorizeUrl({ state }));
  });

  router.get('/callback', async (req, res) => {
    const { code, state, error, error_description: errorDescription } = req.query;

    // El usuario canceló o Twitch rechazó la autorización.
    if (typeof error === 'string' && error !== '') {
      logger.warn(`auth: Twitch no autorizó (${error}${errorDescription ? `: ${errorDescription}` : ''})`);
      pruneStates();
      return res.redirect(frontendRedirect(AUTH_ERROR_CODES.denied));
    }

    // CSRF: el `state` tiene que ser uno que emitió este proceso, y se consume.
    if (typeof state !== 'string' || !pendingStates.delete(state)) {
      logger.warn('auth: callback con `state` desconocido o repetido, descartado');
      return res.redirect(frontendRedirect(AUTH_ERROR_CODES.state));
    }

    if (typeof code !== 'string' || code === '') {
      logger.warn('auth: callback sin `code`');
      return res.redirect(frontendRedirect(AUTH_ERROR_CODES.missingCode));
    }

    try {
      const tokenSet = await exchangeCodeForTokens(code);
      const session = await establishSession(tokenSet);
      logger.info(`auth: sesión iniciada para el canal ${session.channel?.login ?? '(desconocido)'}`);
      return res.redirect(frontendRedirect());
    } catch (failure) {
      // `failure.message` ya viene saneado por el cliente OAuth (sin secretos).
      logger.error(`auth: no se pudo completar el login (${failure.message})`);
      return res.redirect(frontendRedirect(AUTH_ERROR_CODES.exchange));
    }
  });

  return router;
}
