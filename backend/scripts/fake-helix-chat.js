/**
 * Imitador local de Helix **Send Chat Message** (T-006).
 *
 * Habla el mismo contrato que Twitch
 * (https://dev.twitch.tv/docs/api/reference/#send-chat-message):
 *
 * - `POST /helix/chat/messages` → `200 { data: [{ message_id, is_sent }] }`;
 *   exige el `client-id` y un bearer, y valida `broadcaster_id`, `sender_id`,
 *   `message` y el tope de 500 caracteres como el real.
 * - Todo lo demás lo atiende `fake-twitch.js` (OAuth + `/helix/users`), que se
 *   monta **como fallback** al final —el mismo truco que `fake-eventsub.js`—,
 *   así que un solo proceso sirve de `TWITCH_AUTH_BASE_URL` y `TWITCH_API_BASE_URL`.
 * - Con `eventSubUrl`, además: (1) reenvía
 *   `POST /helix/eventsub/subscriptions` al imitador de EventSub, y (2) **hace
 *   eco** de cada mensaje aceptado por su mando `/_fake/eventsub/say`, igual que
 *   Twitch, que te devuelve tu propio mensaje por EventSub. Así se puede
 *   ejercitar el camino completo input → Helix → EventSub → `/ws` → panel.
 *
 * Mandos para las pruebas (no existen en Twitch, van bajo `/_fake/`):
 *
 * - `GET  /_fake/chat/sent`  → `{ count, messages, rejected, echoFailures }`.
 * - `POST /_fake/chat/fail`  `{ status, message, times }` → los próximos envíos
 *   fallan con ese status (simula 401 de credencial o 500 de Twitch).
 * - `POST /_fake/chat/drop`  `{ code, message, times }` → los próximos envíos
 *   responden 200 con `is_sent: false` y ese `drop_reason` (modo solo-seguidores,
 *   mensaje repetido…).
 * - `POST /_fake/chat/reset` → limpia lo enviado y los mandos pendientes.
 *
 * Acepta cualquier bearer no vacío (las pruebas siembran un token opaco en
 * SQLite en vez de recorrer el OAuth). Nada de lo que emite es un secreto.
 *
 * Uso a mano:
 *
 *     node backend/scripts/fake-helix-chat.js --port 4120
 *     # con eco por EventSub (levantá antes fake-eventsub.js en el 4110):
 *     node backend/scripts/fake-helix-chat.js --port 4120 --eventsub http://localhost:4110
 */
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

import express from 'express';

import { FAKE_CHANNEL, createFakeTwitchApp } from './fake-twitch.js';

/** Tope de Twitch para un mensaje de chat (el real lo rechaza con 400). */
export const FAKE_MAX_MESSAGE_LENGTH = 500;

const opaque = (prefix) => `${prefix}-${crypto.randomBytes(12).toString('hex')}`;

const twitchError = (res, status, message) => res.status(status).json({ status, message });

const bearer = (req) => {
  const header = req.get('authorization') ?? '';
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
};

/**
 * Rutas del imitador (sin catch-all, para poder montarlas dentro de otra app).
 *
 * @param {object} options
 * @param {string} options.clientId       client id que se exige en el header.
 * @param {object} [options.channel]      canal simulado (`FAKE_CHANNEL`).
 * @param {string|null} [options.eventSubUrl]  base del imitador de EventSub para
 *   reenviar suscripciones y hacer eco de los mensajes enviados.
 */
export function createFakeHelixChatRoutes({ clientId, channel = FAKE_CHANNEL, eventSubUrl = null } = {}) {
  const router = express.Router();

  /** Mensajes aceptados, en orden (las pruebas los inspeccionan). */
  const sent = [];
  /**
   * Envíos rechazados por credenciales o parámetros inválidos (los fallos
   * programados con `/_fake/chat/fail` **no** cuentan aquí: así una prueba puede
   * exigir `rejected === 0` para demostrar que el backend manda headers y
   * parámetros válidos en todas sus llamadas).
   */
  let rejected = 0;
  /** Ecos por EventSub que no se pudieron entregar (diagnóstico de las pruebas). */
  const echoFailures = [];
  /** Fallo programado por `/_fake/chat/fail`, o `null`. */
  let pendingFailure = null;
  /** Descarte programado por `/_fake/chat/drop`, o `null`. */
  let pendingDrop = null;

  /** Consume un mando con contador de usos; `null` cuando se agota. */
  const consume = (mando) => {
    if (!mando) {
      return null;
    }
    mando.times -= 1;
    return mando;
  };

  /**
   * Eco por EventSub: Twitch entrega tu propio mensaje como una notification
   * más. El mando `say` del imitador de EventSub le asigna su propio
   * `message_id` (no acepta uno de fuera), así que el id del eco no coincide con
   * el que devuelve este endpoint; el camino de render es el mismo.
   */
  const echoToEventSub = async (text) => {
    if (!eventSubUrl) {
      return;
    }
    try {
      const response = await fetch(`${eventSubUrl}/_fake/eventsub/say`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          userId: channel.id,
          username: channel.login,
          displayName: channel.display_name,
        }),
      });
      if (!response.ok) {
        echoFailures.push(`HTTP ${response.status} al hacer eco por EventSub`);
      }
    } catch (error) {
      echoFailures.push(`no se pudo hablar con fake-eventsub (${error.message})`);
    }
  };

  router.post('/helix/chat/messages', async (req, res) => {
    if (bearer(req) === '') {
      rejected += 1;
      return twitchError(res, 401, 'Missing OAuth token');
    }
    if (req.get('client-id') !== clientId) {
      rejected += 1;
      return twitchError(res, 401, 'Client ID and OAuth token do not match');
    }

    const { broadcaster_id: broadcasterId, sender_id: senderId, message } = req.body ?? {};

    if (!broadcasterId || !senderId || typeof message !== 'string' || message === '') {
      rejected += 1;
      return twitchError(res, 400, 'Missing required parameter');
    }
    if (message.length > FAKE_MAX_MESSAGE_LENGTH) {
      rejected += 1;
      return twitchError(res, 400, `The message is too long (max ${FAKE_MAX_MESSAGE_LENGTH} characters)`);
    }
    if (String(broadcasterId) !== String(channel.id)) {
      rejected += 1;
      return twitchError(res, 401, 'The ID in broadcaster_id must match the user ID in the user access token');
    }

    // Mando de fallo: simula lo que Twitch responde ante credenciales inválidas
    // (401), permisos insuficientes (403) o un problema suyo (500).
    const failure = consume(pendingFailure);
    if (failure) {
      if (failure.times <= 0) {
        pendingFailure = null;
      }
      return twitchError(res, failure.status, failure.message);
    }

    // Mando de descarte: 200 con `is_sent: false` (modo solo-seguidores, etc.).
    const drop = consume(pendingDrop);
    if (drop) {
      if (drop.times <= 0) {
        pendingDrop = null;
      }
      return res.json({
        data: [
          {
            message_id: opaque('fake-sent'),
            is_sent: false,
            drop_reason: { code: drop.code, message: drop.message },
          },
        ],
      });
    }

    const messageId = opaque('fake-sent');
    sent.push({
      id: messageId,
      broadcasterId: String(broadcasterId),
      senderId: String(senderId),
      text: message,
      at: new Date().toISOString(),
    });

    await echoToEventSub(message);

    return res.json({ data: [{ message_id: messageId, is_sent: true }] });
  });

  // El backend crea la suscripción de EventSub por Helix, así que si el
  // imitador de EventSub vive en otro puerto hay que reenviarle esa ruta para
  // que un solo `TWITCH_API_BASE_URL` sirva para todo.
  if (eventSubUrl) {
    router.post('/helix/eventsub/subscriptions', async (req, res) => {
      try {
        const upstream = await fetch(`${eventSubUrl}/helix/eventsub/subscriptions`, {
          method: 'POST',
          headers: {
            authorization: req.get('authorization') ?? '',
            'client-id': req.get('client-id') ?? '',
            'content-type': 'application/json',
          },
          body: JSON.stringify(req.body ?? {}),
        });
        const payload = await upstream.json().catch(() => null);
        return res.status(upstream.status).json(payload ?? {});
      } catch (error) {
        return twitchError(res, 502, `el imitador no pudo hablar con fake-eventsub (${error.message})`);
      }
    });
  }

  router.get('/_fake/chat/sent', (req, res) => {
    res.json({ count: sent.length, messages: sent, rejected, echoFailures });
  });

  router.post('/_fake/chat/fail', (req, res) => {
    const { status, message, times } = req.body ?? {};
    pendingFailure = {
      status: Number.parseInt(String(status ?? '401'), 10) || 401,
      message: typeof message === 'string' && message ? message : 'Missing scope: user:write:chat',
      times: Math.max(1, Number.parseInt(String(times ?? '1'), 10) || 1),
    };
    res.json({ pendingFailure });
  });

  router.post('/_fake/chat/drop', (req, res) => {
    const { code, message, times } = req.body ?? {};
    pendingDrop = {
      code: typeof code === 'string' && code ? code : 'followers_only_mode',
      message: typeof message === 'string' && message ? message : 'El canal está en modo solo-seguidores.',
      times: Math.max(1, Number.parseInt(String(times ?? '1'), 10) || 1),
    };
    res.json({ pendingDrop });
  });

  router.post('/_fake/chat/reset', (req, res) => {
    sent.length = 0;
    echoFailures.length = 0;
    rejected = 0;
    pendingFailure = null;
    pendingDrop = null;
    res.json({ reset: true });
  });

  return router;
}

/**
 * Levanta el imitador completo (envío de chat + el resto del contrato de Twitch
 * vía `fake-twitch.js`). `port = 0` toma un puerto libre del SO.
 * Devuelve `{ port, url, sent(), close() }`.
 */
export function startFakeHelixChat({
  port = 0,
  clientId = 'dummy-client-id',
  clientSecret = 'dummy-client-secret',
  channel = FAKE_CHANNEL,
  eventSubUrl = null,
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  // Primero lo propio; el imitador de OAuth va al final porque trae el 404
  // catch-all y no admite rutas después.
  app.use(createFakeHelixChatRoutes({ clientId, channel, eventSubUrl }));
  app.use(createFakeTwitchApp({ clientId, clientSecret, channel }));

  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1');
    server.once('error', reject);
    server.once('listening', () => {
      const actualPort = server.address().port;
      const url = `http://localhost:${actualPort}`;
      resolve({
        port: actualPort,
        url,
        sent: async () => (await fetch(`${url}/_fake/chat/sent`)).json(),
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** Modo CLI: `node backend/scripts/fake-helix-chat.js [--port 4120] [--eventsub <url>]`. */
const isCli = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  const flag = (name, fallback) => {
    const index = process.argv.indexOf(name);
    return index !== -1 ? process.argv[index + 1] : fallback;
  };

  const fake = await startFakeHelixChat({
    port: Number.parseInt(flag('--port', process.env.FAKE_HELIX_CHAT_PORT ?? '4120'), 10),
    clientId: process.env.TWITCH_CLIENT_ID ?? 'dummy-client-id',
    clientSecret: process.env.TWITCH_CLIENT_SECRET ?? 'dummy-client-secret',
    eventSubUrl: flag('--eventsub', process.env.FAKE_EVENTSUB_URL ?? null),
  });

  console.log(`[fake-helix-chat] escuchando en ${fake.url} (OAuth + /helix/chat/messages + mandos /_fake/chat/)`);
  console.log(`[fake-helix-chat] canal simulado: ${FAKE_CHANNEL.display_name} (${FAKE_CHANNEL.login})`);
  console.log(`[fake-helix-chat] mensajes enviados: curl ${fake.url}/_fake/chat/sent`);

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      void fake.close().then(() => process.exit(0));
    });
  }
}
