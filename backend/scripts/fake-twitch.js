/**
 * Imitador local de los endpoints de Twitch usados por el OAuth (T-003).
 *
 * Habla el **mismo contrato HTTP** que Twitch:
 * - `GET  /oauth2/authorize` → 302 al `redirect_uri` con `code` y `state`
 *   (aprueba automáticamente; con `&fake_deny=1` simula que el usuario cancela).
 * - `POST /oauth2/token`     → `authorization_code` y `refresh_token` grants,
 *   respondiendo `{ access_token, refresh_token, expires_in, scope, token_type }`.
 * - `GET  /helix/users`      → `{ data: [{ id, login, display_name }] }`.
 * - `GET  /_fake/stats`      → contadores del imitador (solo para las pruebas).
 *
 * Sirve para ejercitar el flujo completo —incluido el refresh automático— sin
 * credenciales reales. Lo usa `npm --prefix backend run test:oauth`, y también
 * se puede levantar a mano para probar la app en el navegador:
 *
 *     node backend/scripts/fake-twitch.js --port 4100
 *
 * y arrancar el backend con `TWITCH_AUTH_BASE_URL=http://localhost:4100`
 * y `TWITCH_API_BASE_URL=http://localhost:4100`.
 *
 * Los "tokens" que emite son cadenas opacas aleatorias sin ningún valor: no son
 * secretos y no sirven contra Twitch real.
 */
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

import express from 'express';

/** Canal que el imitador reporta en `/helix/users`. */
export const FAKE_CHANNEL = Object.freeze({
  id: '900100200',
  login: 'canal_de_prueba',
  display_name: 'CanalDePrueba',
});

const opaque = (prefix) => `${prefix}-${crypto.randomBytes(12).toString('hex')}`;

const twitchError = (res, status, message) => res.status(status).json({ status, message });

/**
 * App Express del imitador. `clientId`/`clientSecret` son los valores dummy que
 * el backend bajo prueba tiene configurados: el imitador los exige igual que
 * Twitch exigiría los reales.
 */
export function createFakeTwitchApp({
  clientId,
  clientSecret,
  channel = FAKE_CHANNEL,
  accessTokenTtlSeconds = 14_400,
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false }));

  /** `code` emitidos y sin canjear → datos de la autorización. */
  const codes = new Map();
  /** Access tokens vivos → scopes concedidos. */
  const accessTokens = new Map();
  /** Refresh tokens vivos → scopes concedidos. */
  const refreshTokens = new Map();

  const stats = {
    authorize: 0,
    denied: 0,
    codeGrants: 0,
    refreshGrants: 0,
    rejectedGrants: 0,
    userLookups: 0,
  };

  const issueTokens = (scopes) => {
    const accessToken = opaque('fake-access');
    const refreshToken = opaque('fake-refresh');
    accessTokens.set(accessToken, scopes);
    refreshTokens.set(refreshToken, scopes);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: accessTokenTtlSeconds,
      scope: scopes,
      token_type: 'bearer',
    };
  };

  app.get('/oauth2/authorize', (req, res) => {
    const { client_id: id, redirect_uri: redirectUri, response_type: responseType, scope, state } = req.query;

    if (id !== clientId) {
      return twitchError(res, 400, 'invalid client');
    }
    if (responseType !== 'code') {
      return twitchError(res, 400, 'unsupported response type');
    }
    if (typeof redirectUri !== 'string' || redirectUri === '') {
      return twitchError(res, 400, 'missing redirect_uri');
    }

    const target = new URL(redirectUri);
    if (typeof state === 'string' && state !== '') {
      target.searchParams.set('state', state);
    }

    // El usuario pulsa "Cancelar" en la pantalla de consentimiento.
    if (req.query.fake_deny === '1') {
      stats.denied += 1;
      target.searchParams.set('error', 'access_denied');
      target.searchParams.set('error_description', 'The user denied you access');
      return res.redirect(target.toString());
    }

    stats.authorize += 1;
    const code = opaque('fake-code');
    codes.set(code, {
      redirectUri,
      scopes: String(scope ?? '').split(' ').filter(Boolean),
    });
    target.searchParams.set('code', code);

    return res.redirect(target.toString());
  });

  app.post('/oauth2/token', (req, res) => {
    const body = req.body ?? {};

    if (body.client_id !== clientId || body.client_secret !== clientSecret) {
      stats.rejectedGrants += 1;
      return twitchError(res, 403, 'invalid client');
    }

    if (body.grant_type === 'authorization_code') {
      const granted = codes.get(body.code);
      if (!granted) {
        stats.rejectedGrants += 1;
        return twitchError(res, 400, 'Invalid authorization code');
      }
      if (granted.redirectUri !== body.redirect_uri) {
        stats.rejectedGrants += 1;
        return twitchError(res, 400, 'Parameter redirect_uri does not match registered URI');
      }
      // Un `code` es de un solo uso.
      codes.delete(body.code);
      stats.codeGrants += 1;
      return res.json(issueTokens(granted.scopes));
    }

    if (body.grant_type === 'refresh_token') {
      const scopes = refreshTokens.get(body.refresh_token);
      if (!scopes) {
        stats.rejectedGrants += 1;
        return twitchError(res, 400, 'Invalid refresh token');
      }
      // Twitch rota el refresh token: el anterior deja de servir.
      refreshTokens.delete(body.refresh_token);
      stats.refreshGrants += 1;
      return res.json(issueTokens(scopes));
    }

    stats.rejectedGrants += 1;
    return twitchError(res, 400, 'unsupported grant type');
  });

  app.get('/helix/users', (req, res) => {
    const authorization = req.get('authorization') ?? '';
    const token = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7) : '';

    if (!accessTokens.has(token)) {
      return twitchError(res, 401, 'Invalid OAuth token');
    }
    if (req.get('client-id') !== clientId) {
      return twitchError(res, 401, 'Client ID and OAuth token do not match');
    }

    stats.userLookups += 1;
    return res.json({ data: [{ ...channel }] });
  });

  app.get('/_fake/stats', (req, res) => {
    res.json({ ...stats, liveAccessTokens: accessTokens.size, liveRefreshTokens: refreshTokens.size });
  });

  app.use((req, res) => twitchError(res, 404, `el imitador no implementa ${req.method} ${req.path}`));

  return app;
}

/**
 * Levanta el imitador. `port = 0` toma un puerto libre del SO (lo que usan las
 * pruebas). Devuelve `{ url, port, close() }`.
 */
export function startFakeTwitch({ port = 0, ...options } = {}) {
  const app = createFakeTwitchApp(options);

  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1');
    server.once('error', reject);
    server.once('listening', () => {
      const actualPort = server.address().port;
      resolve({
        port: actualPort,
        url: `http://localhost:${actualPort}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** Modo CLI: `node backend/scripts/fake-twitch.js [--port 4100]`. */
const isCli = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  const portFlag = process.argv.indexOf('--port');
  const port = Number.parseInt(
    portFlag !== -1 ? process.argv[portFlag + 1] : (process.env.FAKE_TWITCH_PORT ?? '4100'),
    10,
  );

  const clientId = process.env.TWITCH_CLIENT_ID ?? 'dummy-client-id';
  const clientSecret = process.env.TWITCH_CLIENT_SECRET ?? 'dummy-client-secret';

  const fake = await startFakeTwitch({ port, clientId, clientSecret });
  console.log(`[fake-twitch] escuchando en ${fake.url}`);
  console.log(`[fake-twitch] canal simulado: ${FAKE_CHANNEL.display_name} (${FAKE_CHANNEL.login})`);
  console.log('[fake-twitch] arranca el backend con TWITCH_AUTH_BASE_URL y TWITCH_API_BASE_URL apuntando aquí');

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      void fake.close().then(() => process.exit(0));
    });
  }
}
