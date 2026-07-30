/**
 * Imitador local de EventSub (T-004): WebSocket + endpoint de suscripción.
 *
 * Habla el **mismo protocolo** que Twitch
 * (https://dev.twitch.tv/docs/eventsub/handling-websocket-events):
 *
 * - `WS   /ws`                            → `session_welcome`, `session_keepalive`,
 *   `notification` (`channel.chat.message`) y `session_reconnect`.
 * - `POST /helix/eventsub/subscriptions`  → 202 con la suscripción creada;
 *   valida `client-id`, el bearer, el tipo/versión y que el `session_id` exista.
 * - Todo lo demás lo atiende `fake-twitch.js` (OAuth + `/helix/users`), así que
 *   este imitador solo sirve como `TWITCH_API_BASE_URL` **y** `TWITCH_AUTH_BASE_URL`.
 *
 * Mandos para las pruebas (no existen en Twitch, van bajo `/_fake/`):
 *
 * - `POST /_fake/eventsub/say`       `{ text, userId, username, displayName }` →
 *   emite un `notification`; responde `{ id, sessionId }`.
 * - `POST /_fake/eventsub/reconnect` → `session_reconnect` con `reconnect_url`
 *   (la conexión vieja se cierra cuando la nueva recibe su welcome, como Twitch).
 * - `POST /_fake/eventsub/drop`      → `terminate()` de los sockets: caída en seco.
 * - `POST /_fake/eventsub/keepalive` → `session_keepalive` suelto.
 * - `GET  /_fake/eventsub/stats`     → contadores y suscripciones registradas.
 *
 * Acepta cualquier bearer no vacío (las pruebas siembran un token opaco en
 * SQLite en vez de recorrer el OAuth). Nada de lo que emite es un secreto.
 *
 * Uso a mano:
 *
 *     node backend/scripts/fake-eventsub.js --port 4110
 *     # backend: TWITCH_AUTH_BASE_URL=http://localhost:4110 \
 *     #          TWITCH_API_BASE_URL=http://localhost:4110 \
 *     #          TWITCH_EVENTSUB_WS_URL=ws://localhost:4110/ws
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

import express from 'express';
import { WebSocketServer } from 'ws';

import { FAKE_CHANNEL, createFakeTwitchApp } from './fake-twitch.js';

/** Espectador de prueba por default de `/_fake/eventsub/say`. */
export const FAKE_CHATTER = Object.freeze({
  id: '555000111',
  login: 'espectadora_uno',
  display_name: 'EspectadoraUno',
});

/** Ruta del WebSocket del imitador (en Twitch es otro host: `eventsub.wss.twitch.tv/ws`). */
export const FAKE_EVENTSUB_PATH = '/ws';

const opaque = (prefix) => `${prefix}-${crypto.randomBytes(12).toString('hex')}`;

const twitchError = (res, status, message) => res.status(status).json({ status, message });

const bearer = (req) => {
  const header = req.get('authorization') ?? '';
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
};

/**
 * Levanta el imitador completo (HTTP + WebSocket) en `port` (`0` = puerto libre).
 * Devuelve `{ port, url, wsUrl, close() }`.
 */
export function startFakeEventSub({
  port = 0,
  clientId = 'dummy-client-id',
  clientSecret = 'dummy-client-secret',
  channel = FAKE_CHANNEL,
  keepaliveSeconds = 10,
  /** Cada cuánto manda keepalive automático; `0` lo desactiva. */
  keepaliveIntervalMs = 5_000,
  /** Plazo para suscribirse antes de cerrar con 4003, como Twitch. */
  subscriptionGraceMs = 10_000,
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  /** `sessionId` → estado de la sesión de EventSub. */
  const sessions = new Map();
  /** Token de migración pendiente → `sessionId` de origen. */
  const pendingMigrations = new Map();

  const stats = {
    connections: 0,
    welcomes: 0,
    migrations: 0,
    drops: 0,
    keepalives: 0,
    notifications: 0,
    subscriptionsCreated: 0,
    rejectedSubscriptions: 0,
    unusedClosures: 0,
  };

  /** Suscripciones creadas, en orden (las pruebas las inspeccionan). */
  const subscriptions = [];

  const isOpen = (session) => session.socket.readyState === session.socket.OPEN;

  const send = (session, frame) => {
    if (isOpen(session)) {
      session.socket.send(JSON.stringify(frame));
    }
  };

  const metadata = (type, extra = {}) => ({
    message_id: opaque('fake-msg'),
    message_type: type,
    message_timestamp: new Date().toISOString(),
    ...extra,
  });

  /** Sesiones abiertas que ya pueden recibir eventos, la más reciente al final. */
  const activeSessions = () => [...sessions.values()].filter((session) => isOpen(session) && !session.closing);

  /** Sesión que Twitch usaría para entregar: la última que hizo welcome. */
  const deliverySessions = ({ target = 'latest' } = {}) => {
    const ready = activeSessions().filter((session) => session.subscriptions.length > 0);
    if (ready.length === 0) {
      return [];
    }
    if (target === 'all') {
      return ready;
    }
    if (target === 'oldest') {
      return [ready[0]];
    }
    return [ready[ready.length - 1]];
  };

  const closeSession = (session, { code = 1000, reason = '' } = {}) => {
    session.closing = true;
    if (session.keepaliveTimer) {
      clearInterval(session.keepaliveTimer);
      session.keepaliveTimer = null;
    }
    if (session.graceTimer) {
      clearTimeout(session.graceTimer);
      session.graceTimer = null;
    }
    try {
      session.socket.close(code, reason);
    } catch {
      // Ya estaba cerrado.
    }
  };

  // --- Endpoint de suscripción (contrato real de Helix) ----------------------

  app.post('/helix/eventsub/subscriptions', (req, res) => {
    if (bearer(req) === '') {
      stats.rejectedSubscriptions += 1;
      return twitchError(res, 401, 'Missing OAuth token');
    }
    if (req.get('client-id') !== clientId) {
      stats.rejectedSubscriptions += 1;
      return twitchError(res, 401, 'Client ID and OAuth token do not match');
    }

    const { type, version, condition, transport } = req.body ?? {};

    if (type !== 'channel.chat.message') {
      stats.rejectedSubscriptions += 1;
      return twitchError(res, 400, `el imitador no implementa la suscripción ${type}`);
    }
    if (String(version) !== '1') {
      stats.rejectedSubscriptions += 1;
      return twitchError(res, 400, 'unsupported subscription version');
    }
    if (!condition?.broadcaster_user_id || !condition?.user_id) {
      stats.rejectedSubscriptions += 1;
      return twitchError(res, 400, 'Missing required parameter in condition');
    }
    if (transport?.method !== 'websocket') {
      stats.rejectedSubscriptions += 1;
      return twitchError(res, 400, 'Unsupported transport method');
    }

    const session = sessions.get(transport?.session_id);
    if (!session || !isOpen(session)) {
      stats.rejectedSubscriptions += 1;
      return twitchError(res, 400, 'The websocket session is not connected');
    }

    const duplicate = session.subscriptions.some((item) => item.type === type && item.condition.broadcaster_user_id === condition.broadcaster_user_id);
    if (duplicate) {
      stats.rejectedSubscriptions += 1;
      return twitchError(res, 409, 'subscription already exists');
    }

    const subscription = {
      id: opaque('fake-sub'),
      status: 'enabled',
      type,
      version: String(version),
      condition,
      created_at: new Date().toISOString(),
      transport: { method: 'websocket', session_id: session.id, connected_at: session.connectedAt },
      cost: 0,
    };

    session.subscriptions.push(subscription);
    subscriptions.push(subscription);
    stats.subscriptionsCreated += 1;

    if (session.graceTimer) {
      clearTimeout(session.graceTimer);
      session.graceTimer = null;
    }

    return res.status(202).json({ data: [subscription], total: subscriptions.length, total_cost: 0, max_total_cost: 10 });
  });

  // --- Mandos del imitador ---------------------------------------------------

  app.post('/_fake/eventsub/say', (req, res) => {
    const { text, userId, username, displayName, target, repeat } = req.body ?? {};
    const message = typeof text === 'string' && text !== '' ? text : 'hola desde el imitador';
    // `repeat` reenvía la MISMA notification (mismo message_id): así se prueba la
    // deduplicación, igual que cuando Twitch reintenta una entrega.
    const copies = Math.max(1, Number.parseInt(String(repeat ?? '1'), 10) || 1);
    const targets = deliverySessions({ target });

    if (targets.length === 0) {
      return res.status(409).json({ error: 'ninguna sesión suscrita a channel.chat.message' });
    }

    const chatterId = String(userId ?? FAKE_CHATTER.id);
    const chatterLogin = String(username ?? FAKE_CHATTER.login);
    const messageId = opaque('fake-chat');
    const now = new Date().toISOString();

    for (const session of targets) {
      const [subscription] = session.subscriptions;
      for (let copy = 0; copy < copies; copy += 1) {
        send(session, {
          metadata: metadata('notification', {
            subscription_type: subscription.type,
            subscription_version: subscription.version,
          }),
          payload: {
            subscription,
            event: {
              broadcaster_user_id: channel.id,
              broadcaster_user_login: channel.login,
              broadcaster_user_name: channel.display_name,
              chatter_user_id: chatterId,
              chatter_user_login: chatterLogin,
              chatter_user_name: String(displayName ?? FAKE_CHATTER.display_name),
              message_id: messageId,
              message_type: 'text',
              message: { text: message, fragments: [{ type: 'text', text: message }] },
              color: '#9146FF',
              badges: [],
              cheer: null,
              reply: null,
              channel_points_custom_reward_id: null,
            },
          },
        });
        stats.notifications += 1;
      }
    }

    return res.json({ id: messageId, sessionId: targets[targets.length - 1].id, sentTo: targets.length, at: now });
  });

  app.post('/_fake/eventsub/reconnect', (req, res) => {
    const [session] = deliverySessions({ target: 'latest' });
    if (!session) {
      return res.status(409).json({ error: 'no hay sesión activa que migrar' });
    }

    const token = opaque('fake-migration');
    pendingMigrations.set(token, session.id);
    session.migrating = true;

    const url = new URL(`ws://localhost:${actualPort}${FAKE_EVENTSUB_PATH}`);
    url.searchParams.set('reconnect_token', token);

    send(session, {
      metadata: metadata('session_reconnect'),
      payload: {
        session: {
          id: session.id,
          status: 'reconnecting',
          keepalive_timeout_seconds: null,
          reconnect_url: url.toString(),
          connected_at: session.connectedAt,
        },
      },
    });

    return res.json({ sessionId: session.id, reconnectUrl: url.toString() });
  });

  app.post('/_fake/eventsub/drop', (req, res) => {
    const dropped = activeSessions();
    for (const session of dropped) {
      stats.drops += 1;
      session.closing = true;
      if (session.keepaliveTimer) {
        clearInterval(session.keepaliveTimer);
        session.keepaliveTimer = null;
      }
      // `terminate()` corta el socket sin close frame: caída en seco.
      session.socket.terminate();
    }
    return res.json({ dropped: dropped.length });
  });

  app.post('/_fake/eventsub/keepalive', (req, res) => {
    const targets = activeSessions();
    for (const session of targets) {
      send(session, { metadata: metadata('session_keepalive'), payload: {} });
      stats.keepalives += 1;
    }
    return res.json({ sentTo: targets.length });
  });

  app.get('/_fake/eventsub/stats', (req, res) => {
    res.json({
      ...stats,
      openSessions: activeSessions().length,
      subscriptions: subscriptions.map(({ id, type, version, condition, transport }) => ({
        id,
        type,
        version,
        condition,
        transport,
      })),
    });
  });

  // El resto del contrato de Twitch (OAuth, `/helix/users`) y el 404 final.
  app.use(createFakeTwitchApp({ clientId, clientSecret, channel }));

  // --- WebSocket de EventSub ------------------------------------------------

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: FAKE_EVENTSUB_PATH });
  let actualPort = port;

  wss.on('connection', (socket, request) => {
    stats.connections += 1;

    const query = new URL(request.url, 'http://localhost').searchParams;
    const migrationToken = query.get('reconnect_token');
    const origin = migrationToken ? sessions.get(pendingMigrations.get(migrationToken)) : null;

    const session = {
      id: opaque('fake-session'),
      socket,
      connectedAt: new Date().toISOString(),
      // Las suscripciones viajan con la sesión: el cliente no debe re-suscribirse.
      subscriptions: origin ? [...origin.subscriptions] : [],
      closing: false,
      migrating: false,
      keepaliveTimer: null,
      graceTimer: null,
    };
    sessions.set(session.id, session);

    socket.on('close', () => {
      if (session.keepaliveTimer) {
        clearInterval(session.keepaliveTimer);
        session.keepaliveTimer = null;
      }
      if (session.graceTimer) {
        clearTimeout(session.graceTimer);
        session.graceTimer = null;
      }
      sessions.delete(session.id);
    });
    socket.on('error', () => {
      /* el close posterior limpia */
    });

    send(session, {
      metadata: metadata('session_welcome'),
      payload: {
        session: {
          id: session.id,
          status: 'connected',
          connected_at: session.connectedAt,
          keepalive_timeout_seconds: keepaliveSeconds,
          reconnect_url: null,
        },
      },
    });
    stats.welcomes += 1;

    if (origin) {
      stats.migrations += 1;
      pendingMigrations.delete(migrationToken);
      // Igual que Twitch: la conexión vieja se cierra en cuanto la nueva está lista.
      closeSession(origin, { code: 1000, reason: 'session migrated' });
    } else if (subscriptionGraceMs > 0) {
      session.graceTimer = setTimeout(() => {
        if (session.subscriptions.length === 0 && isOpen(session)) {
          stats.unusedClosures += 1;
          closeSession(session, { code: 4003, reason: 'Connection unused' });
        }
      }, subscriptionGraceMs);
      session.graceTimer.unref?.();
    }

    if (keepaliveIntervalMs > 0) {
      session.keepaliveTimer = setInterval(() => {
        if (!isOpen(session)) {
          return;
        }
        send(session, { metadata: metadata('session_keepalive'), payload: {} });
        stats.keepalives += 1;
      }, keepaliveIntervalMs);
      session.keepaliveTimer.unref?.();
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      actualPort = server.address().port;
      resolve({
        port: actualPort,
        url: `http://localhost:${actualPort}`,
        wsUrl: `ws://localhost:${actualPort}${FAKE_EVENTSUB_PATH}`,
        stats: () => ({ ...stats }),
        close: () =>
          new Promise((done) => {
            for (const session of [...sessions.values()]) {
              closeSession(session);
              session.socket.terminate();
            }
            wss.close(() => server.close(() => done()));
          }),
      });
    });
  });
}

/** Modo CLI: `node backend/scripts/fake-eventsub.js [--port 4110]`. */
const isCli = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  const portFlag = process.argv.indexOf('--port');
  const cliPort = Number.parseInt(portFlag !== -1 ? process.argv[portFlag + 1] : (process.env.FAKE_EVENTSUB_PORT ?? '4110'), 10);

  const fake = await startFakeEventSub({
    port: cliPort,
    clientId: process.env.TWITCH_CLIENT_ID ?? 'dummy-client-id',
    clientSecret: process.env.TWITCH_CLIENT_SECRET ?? 'dummy-client-secret',
  });

  console.log(`[fake-eventsub] HTTP en ${fake.url} (OAuth + Helix + mandos /_fake/)`);
  console.log(`[fake-eventsub] WebSocket de EventSub en ${fake.wsUrl}`);
  console.log(`[fake-eventsub] canal simulado: ${FAKE_CHANNEL.display_name} (${FAKE_CHANNEL.login})`);
  console.log('[fake-eventsub] escribe en el chat con: curl -X POST -H "content-type: application/json" \\');
  console.log(`  -d '{"text":"hola"}' ${fake.url}/_fake/eventsub/say`);

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      void fake.close().then(() => process.exit(0));
    });
  }
}
