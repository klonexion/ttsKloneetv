/**
 * Pruebas de humo del relay de EventSub (T-004):
 *
 *   npm --prefix backend run test:eventsub
 *
 * Levanta el imitador de EventSub (`scripts/fake-eventsub.js`) y **el backend
 * real** como proceso hijo apuntado a él, se conecta al `/ws` del backend como lo
 * haría el navegador y comprueba el camino completo:
 *
 *   EventSub → TwitchProvider → upsert en `users` → broadcast `chat:message`.
 *
 * Cubre los dos caminos de reconexión que pide el criterio (`session_reconnect` y
 * caída en seco), la deduplicación por `message_id` y —al final, porque mata el
 * proceso— que `SIGTERM` termina el backend **con un cliente WebSocket
 * conectado** (el defecto que detectaron T-005 y T-003).
 *
 * No necesita credenciales reales ni red: la sesión se siembra directamente en
 * una base SQLite temporal (`DB_FILE`) con tokens opacos sin ningún valor, y el
 * imitador acepta cualquier bearer. No toca `backend/data/app.sqlite`.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { WebSocket } from 'ws';

import { CHAT_MESSAGE_FRAME_FIELDS, CHAT_MESSAGE_TYPE } from '../src/chat/relay.js';
import { CHAT_MESSAGE_FIELDS } from '../src/chat/provider.js';
import { normalizeChatMessage } from '../src/chat/twitch-provider.js';
import { TWITCH_DEFAULTS, backendRoot } from '../src/config.js';
import { SETTING_KEYS, createRepositories, openDatabase } from '../src/db/index.js';
import { CHAT_MESSAGE_SUBSCRIPTION } from '../src/twitch/eventsub.js';
import { FAKE_CHANNEL } from './fake-twitch.js';
import { FAKE_CHATTER, startFakeEventSub } from './fake-eventsub.js';

const CLIENT_ID = 'dummy-client-id';
const CLIENT_SECRET = 'dummy-client-secret';
const SCOPES = ['user:read:chat', 'user:write:chat', 'moderator:read:chatters'];
/** Sondeo agresivo de la sesión para que la prueba no espere 5 s. */
const SESSION_POLL_MS = 200;
/** El criterio pide < ~2 s de EventSub a la pantalla. */
const RELAY_BUDGET_MS = 2_000;

let failures = 0;
let checks = 0;

const section = (title) => console.log(`\n${title}`);

const check = async (label, fn) => {
  checks += 1;
  try {
    await fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${label}`);
    console.error(`       ${error.message.split('\n').join('\n       ')}`);
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Puerto libre del SO (se cierra antes de dárselo al backend). */
const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

async function waitFor(description, probe, { timeoutMs = 10_000, everyMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) {
      return value;
    }
    await sleep(everyMs);
  }
  throw new Error(`timeout esperando ${description} (${timeoutMs} ms)`);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-hub-eventsub-'));
const dbFile = path.join(tempDir, 'eventsub.sqlite');

// --- Sesión sembrada: el backend arranca creyendo que ya hay login -----------
const seedDb = openDatabase(dbFile);
const seedRepos = createRepositories(seedDb);
seedRepos.tokens.save({
  provider: 'twitch',
  accessToken: 'fake-access-sembrado',
  // 4 h de vida: por encima del margen de refresco (5 min), así el ciclo de
  // T-003 no intenta refrescar un refresh token que el imitador no conoce.
  refreshToken: 'fake-refresh-sembrado',
  expiresAt: Date.now() + 4 * 60 * 60 * 1_000,
  scopes: SCOPES,
});
seedRepos.settings.setAll({
  [SETTING_KEYS.twitchUserId]: FAKE_CHANNEL.id,
  [SETTING_KEYS.twitchLogin]: FAKE_CHANNEL.login,
  [SETTING_KEYS.twitchDisplayName]: FAKE_CHANNEL.display_name,
});
seedDb.close();

const fake = await startFakeEventSub({
  port: 0,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  keepaliveSeconds: 10,
  keepaliveIntervalMs: 1_000,
});

const backendPort = await freePort();
const backendUrl = `http://localhost:${backendPort}`;

const backendOutput = [];
const backend = spawn(process.execPath, [path.join(backendRoot, 'src', 'server.js')], {
  env: {
    ...process.env,
    PORT: String(backendPort),
    DB_FILE: dbFile,
    // Hermeticidad: la app real puede tener HTTPS=true en el `.env` de la raíz
    // (Twitch lo exige), pero esta prueba habla HTTP plano contra el hijo.
    HTTPS: 'false',
    FRONTEND_URL: 'http://localhost:5199',
    TWITCH_CLIENT_ID: CLIENT_ID,
    TWITCH_CLIENT_SECRET: CLIENT_SECRET,
    TWITCH_REDIRECT_URI: `${backendUrl}/auth/callback`,
    TWITCH_AUTH_BASE_URL: fake.url,
    TWITCH_API_BASE_URL: fake.url,
    TWITCH_EVENTSUB_WS_URL: fake.wsUrl,
    TWITCH_CHAT_SESSION_POLL_MS: String(SESSION_POLL_MS),
    // Esta prueba no debe tocar internet: sin edge-tts (T-009) las voces `edge:*`
    // se resuelven al motor del navegador, que es lo que estas aserciones fijan.
    TTS_EDGE_ENABLED: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

backend.stdout.on('data', (chunk) => backendOutput.push(String(chunk)));
backend.stderr.on('data', (chunk) => backendOutput.push(String(chunk)));

const backendExit = new Promise((resolve) => {
  backend.once('exit', (code, signal) => resolve({ code, signal }));
});

const backendAlive = () => backend.exitCode === null && backend.signalCode === null;

const getJson = async (url) => {
  const response = await fetch(url);
  assert.equal(response.status, 200, `${url} devolvió ${response.status}`);
  return response.json();
};

const postJson = async (url, body = {}) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, body: payload };
};

const fakeStats = () => getJson(`${fake.url}/_fake/eventsub/stats`);

/** Cliente `/ws` como el del navegador: acumula las tramas recibidas. */
function openHubClient() {
  const frames = [];
  const socket = new WebSocket(`ws://localhost:${backendPort}/ws`);
  socket.on('message', (data) => {
    try {
      frames.push({ ...JSON.parse(String(data)), receivedAt: Date.now() });
    } catch {
      frames.push({ type: '<no-json>', receivedAt: Date.now() });
    }
  });

  return {
    socket,
    frames,
    chatMessages: () => frames.filter((frame) => frame.type === CHAT_MESSAGE_TYPE),
    ready: new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    }),
    close: () => socket.close(),
  };
}

/** Manda un mensaje por el imitador y espera a verlo en el `/ws` del backend. */
async function sayAndAwait(hub, body, { timeoutMs = 5_000 } = {}) {
  const sentAt = Date.now();
  const { status, body: said } = await postJson(`${fake.url}/_fake/eventsub/say`, body);
  assert.equal(status, 200, `el imitador no pudo enviar el mensaje (HTTP ${status})`);

  const frame = await waitFor(
    `el mensaje ${said.id} en el /ws del backend`,
    () => hub.chatMessages().find((item) => item.payload?.id === said.id) ?? null,
    { timeoutMs, everyMs: 25 },
  );

  return { ...frame, sentAt, latencyMs: frame.receivedAt - sentAt, expectedId: said.id };
}

let db;
let repos;
let hub;
let lingeringSocket = null;

try {
  await waitFor('que el backend responda /api/health', async () => {
    try {
      return (await getJson(`${backendUrl}/api/health`)).status === 'ok';
    } catch {
      return false;
    }
  });

  db = openDatabase(dbFile);
  repos = createRepositories(db);

  section('defaults de configuración (el imitador no se debe filtrar a producción)');

  await check('el WebSocket de EventSub por default es el real de Twitch', () => {
    assert.equal(TWITCH_DEFAULTS.eventSubWsUrl, 'wss://eventsub.wss.twitch.tv/ws');
    assert.equal(TWITCH_DEFAULTS.apiBaseUrl, 'https://api.twitch.tv');
    assert.equal(CHAT_MESSAGE_SUBSCRIPTION.type, 'channel.chat.message');
    assert.equal(CHAT_MESSAGE_SUBSCRIPTION.version, '1');
  });

  section('normalización (agnóstica de Twitch)');

  await check('una notification se traduce al shape documentado y a nada más', () => {
    const message = normalizeChatMessage({
      metadata: { message_type: 'notification', message_timestamp: '2026-07-24T10:11:12.500Z' },
      payload: {
        event: {
          broadcaster_user_id: '900100200',
          chatter_user_id: '4242',
          chatter_user_login: 'alguien',
          chatter_user_name: 'Alguien',
          message_id: 'abc-123',
          message: { text: 'hola mundo', fragments: [{ type: 'text', text: 'hola mundo' }] },
          color: '#9146FF',
          badges: [{ set_id: 'subscriber' }],
        },
      },
    });

    assert.deepEqual(Object.keys(message).sort(), [...CHAT_MESSAGE_FIELDS].sort());
    assert.deepEqual(message, {
      id: 'abc-123',
      userId: '4242',
      username: 'alguien',
      displayName: 'Alguien',
      text: 'hola mundo',
      timestamp: '2026-07-24T10:11:12.500Z',
    });
  });

  await check('sin message_id, sin autor o sin texto la trama se descarta', () => {
    const base = { chatter_user_id: '1', chatter_user_login: 'x', message_id: 'm1', message: { text: 'hola' } };
    assert.equal(normalizeChatMessage({ payload: { event: { ...base, message_id: '' } } }), null);
    assert.equal(normalizeChatMessage({ payload: { event: { ...base, chatter_user_id: '' } } }), null);
    assert.equal(normalizeChatMessage({ payload: { event: { ...base, message: { text: '' } } } }), null);
    assert.equal(normalizeChatMessage({}), null);
  });

  section('suscripción a EventSub');

  await check('el backend se conecta al WebSocket y crea una sola suscripción', async () => {
    const stats = await waitFor('la suscripción a channel.chat.message', async () => {
      const current = await fakeStats();
      return current.subscriptionsCreated >= 1 ? current : null;
    });

    assert.equal(stats.subscriptionsCreated, 1, 'debía crear exactamente una suscripción');
    assert.ok(stats.welcomes >= 1, 'no hubo session_welcome');

    const [subscription] = stats.subscriptions;
    assert.equal(subscription.type, 'channel.chat.message');
    assert.equal(subscription.version, '1');
    assert.deepEqual(subscription.condition, {
      broadcaster_user_id: FAKE_CHANNEL.id,
      user_id: FAKE_CHANNEL.id,
    });
    assert.equal(subscription.transport.method, 'websocket');
    assert.ok(subscription.transport.session_id, 'la suscripción debe ir sobre la sesión del WebSocket');
  });

  await check('POST /helix/eventsub/subscriptions exige el client-id (contrato de Helix)', async () => {
    const response = await fetch(`${fake.url}/helix/eventsub/subscriptions`, {
      method: 'POST',
      headers: { authorization: 'Bearer fake-access-sembrado', 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'channel.chat.message', version: '1' }),
    });
    assert.equal(response.status, 401);
  });

  section('relay al frontend');

  hub = openHubClient();
  await hub.ready;

  await check(`un mensaje del chat llega al /ws del backend en menos de ${RELAY_BUDGET_MS} ms`, async () => {
    const frame = await sayAndAwait(hub, { text: 'hola desde el chat' });

    assert.equal(frame.type, CHAT_MESSAGE_TYPE, 'el tipo de trama debe ser chat:message');
    // T-008 enriquece esta misma trama con `tts` (una sola trama por mensaje).
    assert.deepEqual(Object.keys(frame.payload).sort(), [...CHAT_MESSAGE_FRAME_FIELDS].sort());
    assert.equal(frame.payload.id, frame.expectedId);
    assert.equal(frame.payload.userId, FAKE_CHATTER.id);
    assert.equal(frame.payload.username, FAKE_CHATTER.login);
    assert.equal(frame.payload.displayName, FAKE_CHATTER.display_name);
    assert.equal(frame.payload.text, 'hola desde el chat');
    assert.ok(!Number.isNaN(Date.parse(frame.payload.timestamp)), 'timestamp no parseable');
    assert.ok(frame.latencyMs < RELAY_BUDGET_MS, `tardó ${frame.latencyMs} ms`);
  });

  await check('el mensaje no lleva ningún campo crudo de EventSub', () => {
    const [{ payload }] = hub.chatMessages();
    for (const raw of ['message', 'chatter_user_id', 'broadcaster_user_id', 'badges', 'color', 'fragments', 'subscription']) {
      assert.equal(raw in payload, false, `se filtró el campo crudo "${raw}"`);
    }
  });

  await check('un message_id entregado dos veces solo se relaya una vez', async () => {
    const before = hub.chatMessages().length;
    // El imitador reenvía la MISMA notification (mismo message_id), como cuando
    // Twitch reintenta una entrega o dos conexiones se solapan al migrar.
    const { body: said } = await postJson(`${fake.url}/_fake/eventsub/say`, { text: 'entrega duplicada', repeat: 3 });
    await waitFor('el mensaje duplicado', () => hub.chatMessages().some((frame) => frame.payload.id === said.id));
    await sleep(300);

    const copies = hub.chatMessages().filter((frame) => frame.payload.id === said.id);
    assert.equal(copies.length, 1, `el mensaje ${said.id} llegó ${copies.length} veces`);
    assert.equal(hub.chatMessages().length, before + 1, 'solo debía añadirse un mensaje');
  });

  section('upsert en la tabla users');

  await check('el autor queda registrado con last_active_at y los defaults', async () => {
    const user = await waitFor(`el usuario ${FAKE_CHATTER.id} en la base`, () => repos.users.get(FAKE_CHATTER.id));
    assert.equal(user.username, FAKE_CHATTER.login);
    assert.equal(user.displayName, FAKE_CHATTER.display_name);
    assert.equal(user.muted, false);
    assert.equal(user.ignored, false);
    assert.ok(user.firstSeenAt > 0 && user.lastActiveAt >= user.firstSeenAt);
  });

  await check('un mensaje posterior refresca last_active_at sin pisar preferencias ni pitch', async () => {
    // Preferencias como las dejaría T-011.
    repos.users.updatePreferences(FAKE_CHATTER.id, { muted: true, volume: 0.5, pitch: 1.23, voiceId: 'edge:es-ES-ElviraNeural', voiceSource: 'override' });
    const before = repos.users.get(FAKE_CHATTER.id);

    await sleep(20);
    await sayAndAwait(hub, { text: 'segundo mensaje' });

    const after = await waitFor('el refresco de last_active_at', () => {
      const current = repos.users.get(FAKE_CHATTER.id);
      return current.lastActiveAt > before.lastActiveAt ? current : null;
    });

    assert.equal(after.muted, true, 'el mute se perdió');
    assert.equal(after.volume, 0.5, 'el volumen se perdió');
    assert.equal(after.pitch, 1.23, 'el pitch se perdió');
    assert.equal(after.voiceId, 'edge:es-ES-ElviraNeural', 'la voz se perdió');
    assert.equal(after.voiceSource, 'override', 'el origen de la voz se perdió');
    assert.equal(after.firstSeenAt, before.firstSeenAt, 'first_seen_at no debe cambiar');
  });

  await check('si el usuario se renombra en Twitch, username y displayName se actualizan', async () => {
    await sayAndAwait(hub, {
      text: 'me cambié el nombre',
      userId: FAKE_CHATTER.id,
      username: 'espectadora_nueva',
      displayName: 'EspectadoraNueva',
    });

    const user = await waitFor('el rename', () => {
      const current = repos.users.get(FAKE_CHATTER.id);
      return current.username === 'espectadora_nueva' ? current : null;
    });
    assert.equal(user.displayName, 'EspectadoraNueva');
  });

  await check('cada autor distinto crea su propia fila', async () => {
    await sayAndAwait(hub, { text: 'hola', userId: '777001', username: 'otro_chatter', displayName: 'OtroChatter' });
    const user = await waitFor('el segundo usuario', () => repos.users.get('777001'));
    assert.equal(user.username, 'otro_chatter');
    assert.ok(repos.users.count() >= 2);
  });

  section('reconexión (a) Twitch pide migrar: session_reconnect');

  await check('migra a la reconnect_url sin perder mensajes y sin re-suscribirse', async () => {
    const before = await fakeStats();

    const { status, body: reconnect } = await postJson(`${fake.url}/_fake/eventsub/reconnect`);
    assert.equal(status, 200, 'el imitador no pudo pedir la migración');
    assert.ok(reconnect.reconnectUrl.includes('reconnect_token='), 'la reconnect_url debe traer el token de migración');

    // Mensaje enviado por la conexión VIEJA, justo después del session_reconnect:
    // es el que se perdería si el provider cerrara antes de tiempo.
    const during = await sayAndAwait(hub, { text: 'mensaje durante la migración' });
    assert.equal(during.payload.text, 'mensaje durante la migración');

    const stats = await waitFor('que el imitador registre la migración', async () => {
      const current = await fakeStats();
      return current.migrations > before.migrations ? current : null;
    });

    assert.equal(stats.subscriptionsCreated, before.subscriptionsCreated, 'las suscripciones viajan con la sesión: no debe crear otra');

    const after = await sayAndAwait(hub, { text: 'mensaje después de migrar' });
    assert.equal(after.payload.text, 'mensaje después de migrar');
    assert.ok(after.latencyMs < RELAY_BUDGET_MS, `tardó ${after.latencyMs} ms`);

    const finalStats = await fakeStats();
    assert.equal(finalStats.openSessions, 1, 'la sesión vieja debía quedar cerrada');
  });

  section('reconexión (b) la conexión se cae en seco');

  await check('el provider reconecta solo, se re-suscribe y los mensajes siguen fluyendo', async () => {
    const before = await fakeStats();

    const { status, body: dropped } = await postJson(`${fake.url}/_fake/eventsub/drop`);
    assert.equal(status, 200);
    assert.ok(dropped.dropped >= 1, 'no había conexión que tirar');

    const stats = await waitFor(
      'la nueva suscripción tras la caída',
      async () => {
        const current = await fakeStats();
        return current.subscriptionsCreated > before.subscriptionsCreated ? current : null;
      },
      { timeoutMs: 15_000 },
    );

    assert.equal(stats.subscriptionsCreated, before.subscriptionsCreated + 1, 'una conexión nueva necesita una suscripción nueva');

    const frame = await sayAndAwait(hub, { text: 'mensaje después de la caída' });
    assert.equal(frame.payload.text, 'mensaje después de la caída');
    assert.ok(frame.latencyMs < RELAY_BUDGET_MS, `tardó ${frame.latencyMs} ms`);
  });

  await check('el keepalive del imitador no genera tramas de chat', async () => {
    const before = hub.chatMessages().length;
    await postJson(`${fake.url}/_fake/eventsub/keepalive`);
    await sleep(200);
    assert.equal(hub.chatMessages().length, before, 'un keepalive no es un mensaje');

    const frame = await sayAndAwait(hub, { text: 'sigo vivo' });
    assert.equal(frame.payload.text, 'sigo vivo');
  });

  section('apagado ordenado con un cliente WebSocket conectado');

  await check('SIGTERM cierra el backend limpiamente aunque haya un WebSocket abierto', async () => {
    assert.equal(hub.socket.readyState, WebSocket.OPEN, 'la prueba necesita el /ws abierto');
    assert.ok(backendAlive(), 'el backend ya no estaba vivo');

    // Conexión HTTP a medio hablar: es lo que deja abierto el proxy de Vite y no
    // cuenta como "ociosa", así que `server.close()` la esperaría para siempre.
    lingeringSocket = net.connect(backendPort, '127.0.0.1');
    lingeringSocket.on('error', () => {
      /* se cierra con el backend */
    });
    await new Promise((resolve) => lingeringSocket.once('connect', resolve));
    lingeringSocket.write('GET /api/health HTTP/1.1\r\nHost: localhost\r\n');
    await sleep(150);

    const started = Date.now();
    backend.kill('SIGTERM');

    const exit = await Promise.race([
      backendExit,
      sleep(8_000).then(() => {
        throw new Error('el backend no terminó 8 s después de SIGTERM (wss.close() no cierra los sockets vivos)');
      }),
    ]);

    const elapsedMs = Date.now() - started;
    assert.equal(exit.signal, null, `el proceso murió por señal ${exit.signal} en vez de salir solo`);
    assert.equal(exit.code, 0, `código de salida ${exit.code}`);
    // El cierre tiene que ser ordenado, no el manotazo del temporizador de
    // seguridad de `server.js`: si `hub.close()` se cuelga (el defecto de T-005)
    // el proceso sale igual, pero tarde y por la vía de emergencia.
    assert.ok(elapsedMs < 2_000, `el cierre tardó ${elapsedMs} ms: se cerró por el temporizador de seguridad`);
    assert.equal(
      backendOutput.join('').includes('cierre forzado'),
      false,
      'el backend registró "cierre forzado": el apagado ordenado no completó',
    );
    console.log(`       (cerró en ${elapsedMs} ms, sin cierre forzado)`);
  });
} finally {
  hub?.close();
  lingeringSocket?.destroy();
  if (backendAlive()) {
    backend.kill('SIGKILL');
  }
  db?.close();
  await fake.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} comprobaciones OK`);

if (failures > 0) {
  console.error(`${failures} comprobacion(es) fallaron`);
  console.error('\n--- salida del backend ---');
  console.error(backendOutput.join(''));
  process.exit(1);
}
