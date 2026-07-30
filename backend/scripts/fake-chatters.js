/**
 * Imitador local de Get Chatters (T-007).
 *
 * Habla el mismo contrato que Twitch
 * (https://dev.twitch.tv/docs/api/reference/#get-chatters):
 *
 * - `GET /helix/chat/chatters?broadcaster_id=&moderator_id=&first=&after=`
 *   → `{ data: [{ user_id, user_login, user_name }], pagination: { cursor }, total }`.
 *   Exige bearer y `client-id`, y que `moderator_id` sea el usuario del token
 *   (en la fase 1, el propio broadcaster), igual que el endpoint real.
 *
 * Como `fake-eventsub.js`, **no edita** `fake-twitch.js`: lo monta como fallback
 * (o reenvía a otro imitador con `forwardBaseUrl`), así un solo
 * `TWITCH_API_BASE_URL` sirve OAuth, `/helix/users`, las suscripciones de
 * EventSub y los chatters.
 *
 * Mandos para las pruebas (no existen en Twitch, van bajo `/_fake/`):
 *
 * - `POST /_fake/chatters/set`   `{ chatters: ["login", { user_id, user_login, user_name }] }`
 *   → reemplaza el roster; así se simulan entradas y salidas entre polls.
 * - `POST /_fake/chatters/fail`  `{ status, times, message }` → las próximas
 *   `times` consultas fallan con ese código (401 = scope revocado).
 * - `GET  /_fake/chatters/stats` → `{ requests, pages, lastQuery, roster }`.
 *
 * Uso a mano:
 *
 *     node backend/scripts/fake-chatters.js --port 4120
 *     # backend: TWITCH_AUTH_BASE_URL=http://localhost:4120 \
 *     #          TWITCH_API_BASE_URL=http://localhost:4120
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';

import express from 'express';

import { FAKE_CHANNEL, createFakeTwitchApp } from './fake-twitch.js';

/** Roster inicial: cuatro presentes, ninguno ha escrito todavía. */
export const FAKE_CHATTERS = Object.freeze([
  Object.freeze({ user_id: '555000111', user_login: 'espectadora_uno', user_name: 'EspectadoraUno' }),
  Object.freeze({ user_id: '555000222', user_login: 'lurker_dos', user_name: 'LurkerDos' }),
  Object.freeze({ user_id: '555000333', user_login: 'mirona_tres', user_name: 'MironaTres' }),
  Object.freeze({ user_id: '555000444', user_login: 'silenciosa_cuatro', user_name: 'SilenciosaCuatro' }),
]);

const twitchError = (res, status, message) => res.status(status).json({ status, message });

const bearer = (req) => {
  const header = req.get('authorization') ?? '';
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
};

/** Acepta `"login"` o `{ user_id, user_login, user_name }` y normaliza. */
const toEntry = (raw, index) => {
  if (typeof raw === 'string') {
    return { user_id: `900${String(index).padStart(6, '0')}`, user_login: raw, user_name: raw };
  }
  const login = String(raw?.user_login ?? raw?.username ?? `chatter_${index}`);
  return {
    user_id: String(raw?.user_id ?? raw?.userId ?? `900${String(index).padStart(6, '0')}`),
    user_login: login,
    user_name: String(raw?.user_name ?? raw?.displayName ?? login),
  };
};

/** Cursor opaco (Twitch usa base64); aquí codifica el índice de continuación. */
const encodeCursor = (index) => Buffer.from(`offset:${index}`, 'utf8').toString('base64url');
const decodeCursor = (cursor) => {
  const decoded = Buffer.from(String(cursor), 'base64url').toString('utf8');
  const match = /^offset:(\d+)$/.exec(decoded);
  return match ? Number.parseInt(match[1], 10) : null;
};

/**
 * Rutas de chatters como una app de Express **sin** catch-all, para poder
 * montarlas antes de otro imitador.
 */
export function createFakeChattersApp({ clientId = 'dummy-client-id', channel = FAKE_CHANNEL, chatters = FAKE_CHATTERS, pageSize = 0 } = {}) {
  const app = express();
  app.disable('x-powered-by');

  let roster = chatters.map((entry, index) => toEntry(entry, index));
  const failures = { remaining: 0, status: 401, message: 'Missing scope: moderator:read:chatters' };
  const stats = { requests: 0, pages: 0, rejected: 0, lastQuery: null };

  app.get('/helix/chat/chatters', (req, res) => {
    stats.requests += 1;
    stats.lastQuery = { ...req.query };

    if (failures.remaining > 0) {
      failures.remaining -= 1;
      stats.rejected += 1;
      return twitchError(res, failures.status, failures.message);
    }
    if (bearer(req) === '') {
      stats.rejected += 1;
      return twitchError(res, 401, 'Missing OAuth token');
    }
    if (req.get('client-id') !== clientId) {
      stats.rejected += 1;
      return twitchError(res, 401, 'Client ID and OAuth token do not match');
    }

    const { broadcaster_id: broadcasterId, moderator_id: moderatorId, first, after } = req.query;

    if (!broadcasterId || !moderatorId) {
      stats.rejected += 1;
      return twitchError(res, 400, 'Missing required parameter');
    }
    if (String(broadcasterId) !== String(channel.id)) {
      stats.rejected += 1;
      return twitchError(res, 401, 'The broadcaster_id is not the user of the OAuth token');
    }
    if (String(moderatorId) !== String(channel.id)) {
      // Contrato real: el moderator_id tiene que ser el usuario del token.
      stats.rejected += 1;
      return twitchError(res, 401, "The ID in moderator_id must match the user ID found in the request's OAuth token");
    }

    const requested = Number.parseInt(String(first ?? '100'), 10);
    if (!Number.isFinite(requested) || requested < 1 || requested > 1_000) {
      stats.rejected += 1;
      return twitchError(res, 400, 'The parameter "first" was malformed');
    }

    const offset = after === undefined ? 0 : decodeCursor(after);
    if (offset === null) {
      stats.rejected += 1;
      return twitchError(res, 400, 'The cursor is malformed');
    }

    // `pageSize` fuerza páginas cortas para ejercitar la paginación del cliente.
    const limit = pageSize > 0 ? Math.min(pageSize, requested) : requested;
    const page = roster.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    stats.pages += 1;

    return res.json({
      data: page,
      pagination: nextOffset < roster.length ? { cursor: encodeCursor(nextOffset) } : {},
      total: roster.length,
    });
  });

  app.post('/_fake/chatters/set', express.json(), (req, res) => {
    const list = Array.isArray(req.body?.chatters) ? req.body.chatters : [];
    roster = list.map((entry, index) => toEntry(entry, index));
    res.json({ roster, total: roster.length });
  });

  app.post('/_fake/chatters/fail', express.json(), (req, res) => {
    failures.remaining = Math.max(0, Number.parseInt(String(req.body?.times ?? '1'), 10) || 0);
    failures.status = Number.parseInt(String(req.body?.status ?? '401'), 10) || 401;
    if (typeof req.body?.message === 'string' && req.body.message !== '') {
      failures.message = req.body.message;
    }
    res.json({ ...failures });
  });

  app.get('/_fake/chatters/stats', (req, res) => {
    res.json({ ...stats, roster, failuresPending: failures.remaining });
  });

  return app;
}

/**
 * Middleware que reenvía a otro imitador lo que este no implementa (OAuth,
 * `/helix/users`, las suscripciones de EventSub de `fake-eventsub.js`), para que
 * un solo `TWITCH_API_BASE_URL` cubra todo el contrato.
 */
function createForwarder(baseUrl) {
  return async (req, res) => {
    const target = new URL(req.originalUrl, baseUrl);
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];
    delete headers['accept-encoding'];

    const init = { method: req.method, headers, redirect: 'manual' };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.body !== undefined && req.body !== null && req.is('application/json')) {
        init.body = JSON.stringify(req.body);
      } else {
        init.body = req;
        init.duplex = 'half';
      }
    }

    try {
      const upstream = await fetch(target, init);
      res.status(upstream.status);
      for (const [name, value] of upstream.headers) {
        if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(name)) {
          res.setHeader(name, value);
        }
      }
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      res.status(502).json({ error: `el imitador no pudo reenviar a ${baseUrl} (${error.message})` });
    }
  };
}

/**
 * Levanta el imitador en `port` (`0` = puerto libre).
 *
 * @param {object} [options]
 * @param {string} [options.forwardBaseUrl] imitador al que delegar lo demás
 *   (p. ej. el de EventSub); si no se pasa, monta `fake-twitch.js`.
 * @param {number} [options.pageSize] tamaño de página forzado (0 = honrar `first`).
 */
export function startFakeChatters({
  port = 0,
  clientId = 'dummy-client-id',
  clientSecret = 'dummy-client-secret',
  channel = FAKE_CHANNEL,
  chatters = FAKE_CHATTERS,
  pageSize = 0,
  forwardBaseUrl = null,
} = {}) {
  const app = express();
  app.disable('x-powered-by');

  const chattersApp = createFakeChattersApp({ clientId, channel, chatters, pageSize });
  app.use(chattersApp);

  if (forwardBaseUrl) {
    app.use(createForwarder(forwardBaseUrl));
  } else {
    // `createFakeTwitchApp` trae su propio 404 final: va al último.
    app.use(createFakeTwitchApp({ clientId, clientSecret, channel }));
  }

  const server = http.createServer(app);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      const url = `http://localhost:${actualPort}`;

      const command = async (pathname, body) => {
        const response = await fetch(`${url}${pathname}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        });
        return response.json();
      };

      resolve({
        port: actualPort,
        url,
        /** Reemplaza el roster (entradas y salidas entre polls). */
        setChatters: (list) => command('/_fake/chatters/set', { chatters: list }),
        /** Hace fallar las próximas consultas. */
        failNext: (options) => command('/_fake/chatters/fail', options),
        stats: async () => (await fetch(`${url}/_fake/chatters/stats`)).json(),
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** Modo CLI: `node backend/scripts/fake-chatters.js [--port 4120]`. */
const isCli = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  const portFlag = process.argv.indexOf('--port');
  const cliPort = Number.parseInt(portFlag !== -1 ? process.argv[portFlag + 1] : (process.env.FAKE_CHATTERS_PORT ?? '4120'), 10);
  const forwardFlag = process.argv.indexOf('--forward');
  const forwardBaseUrl = forwardFlag !== -1 ? process.argv[forwardFlag + 1] : (process.env.FAKE_CHATTERS_FORWARD ?? null);

  const fake = await startFakeChatters({
    port: cliPort,
    clientId: process.env.TWITCH_CLIENT_ID ?? 'dummy-client-id',
    clientSecret: process.env.TWITCH_CLIENT_SECRET ?? 'dummy-client-secret',
    forwardBaseUrl,
  });

  console.log(`[fake-chatters] HTTP en ${fake.url} (Get Chatters + mandos /_fake/chatters)`);
  console.log(`[fake-chatters] ${forwardBaseUrl ? `el resto se reenvía a ${forwardBaseUrl}` : 'OAuth y /helix/users los sirve fake-twitch.js'}`);
  console.log(`[fake-chatters] canal simulado: ${FAKE_CHANNEL.display_name} (${FAKE_CHANNEL.login})`);
  console.log('[fake-chatters] cambia el roster con: curl -X POST -H "content-type: application/json" \\');
  console.log(`  -d '{"chatters":["nueva_persona"]}' ${fake.url}/_fake/chatters/set`);

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      void fake.close().then(() => process.exit(0));
    });
  }
}
