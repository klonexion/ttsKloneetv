/**
 * Pruebas de humo del envío de mensajes al chat (T-006):
 *
 *   npm --prefix backend run test:chat-send
 *
 * Levanta el imitador de EventSub (`fake-eventsub.js`), el imitador de Helix
 * Send Chat Message (`fake-helix-chat.js`, que hace eco del mensaje enviado por
 * EventSub como hace Twitch) y **el backend real** como proceso hijo apuntado a
 * los dos. Se conecta al `/ws` del backend como lo haría el navegador y recorre
 * el camino completo del criterio:
 *
 *   POST /api/chat/send → Helix → EventSub → relay → `chat:message` en `/ws`.
 *
 * Cubre además la validación (vacío, solo espacios, tope de 500), el mapeo de
 * los fallos de Twitch (rechazo permanente, fallo transitorio y mensaje
 * descartado con `drop_reason`) y el caso sin sesión.
 *
 * No necesita credenciales reales ni red: la sesión se siembra directamente en
 * una base SQLite temporal (`DB_FILE`) con tokens opacos sin ningún valor, y los
 * imitadores aceptan cualquier bearer. No toca `backend/data/app.sqlite`.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { WebSocket } from 'ws';

import { CHAT_MESSAGE_TYPE } from '../src/chat/relay.js';
import { CHAT_SEND_CODES, MAX_MESSAGE_LENGTH, SEND_MESSAGE_PATH } from '../src/chat/send.js';
import { TWITCH_DEFAULTS, backendRoot } from '../src/config.js';
import { SETTING_KEYS, createRepositories, openDatabase } from '../src/db/index.js';
import { FAKE_CHANNEL } from './fake-twitch.js';
import { startFakeEventSub } from './fake-eventsub.js';
import { startFakeHelixChat } from './fake-helix-chat.js';

const CLIENT_ID = 'dummy-client-id';
const CLIENT_SECRET = 'dummy-client-secret';
const SCOPES = ['user:read:chat', 'user:write:chat', 'moderator:read:chatters'];
const SEEDED_ACCESS_TOKEN = 'fake-access-sembrado';
/** Sondeo agresivo de la sesión para que la prueba no espere 5 s. */
const SESSION_POLL_MS = 200;

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

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-hub-chat-send-'));
const dbFile = path.join(tempDir, 'chat-send.sqlite');

// --- Sesión sembrada: el backend arranca creyendo que ya hay login -----------
const seedDb = openDatabase(dbFile);
const seedRepos = createRepositories(seedDb);
seedRepos.tokens.save({
  provider: 'twitch',
  accessToken: SEEDED_ACCESS_TOKEN,
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

const eventSub = await startFakeEventSub({
  port: 0,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  keepaliveSeconds: 10,
  keepaliveIntervalMs: 1_000,
});

// El envío vive en este imitador, que además reenvía las suscripciones al de
// EventSub y hace eco de lo enviado: un solo `TWITCH_API_BASE_URL` para todo.
const helix = await startFakeHelixChat({
  port: 0,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  eventSubUrl: eventSub.url,
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
    TWITCH_AUTH_BASE_URL: helix.url,
    TWITCH_API_BASE_URL: helix.url,
    TWITCH_EVENTSUB_WS_URL: eventSub.wsUrl,
    TWITCH_CHAT_SESSION_POLL_MS: String(SESSION_POLL_MS),
    // Esta prueba no debe tocar internet: sin edge-tts (T-009) las voces `edge:*`
    // se resuelven al motor del navegador, que es lo que estas aserciones fijan.
    TTS_EDGE_ENABLED: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

backend.stdout.on('data', (chunk) => backendOutput.push(String(chunk)));
backend.stderr.on('data', (chunk) => backendOutput.push(String(chunk)));

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

/** `POST /api/chat/send`, el mismo camino que usa el input del frontend. */
const send = (text) => postJson(`${backendUrl}/api/chat/send`, { text });

/** Mensajes que el imitador de Helix aceptó (y su contador de rechazos). */
const sentSoFar = () => getJson(`${helix.url}/_fake/chat/sent`);

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
    chatMessages: () => frames.filter((frame) => frame.type === CHAT_MESSAGE_TYPE),
    ready: new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    }),
    close: () => socket.close(),
  };
}

let db;
let repos;
let hub;

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

  section('contrato (el imitador no se debe filtrar a producción)');

  await check('la ruta y el tope son los de Helix, y el endpoint por default es el real', () => {
    assert.equal(SEND_MESSAGE_PATH, '/helix/chat/messages');
    assert.equal(MAX_MESSAGE_LENGTH, 500);
    assert.equal(TWITCH_DEFAULTS.apiBaseUrl, 'https://api.twitch.tv');
  });

  section('envío feliz');

  await check('POST /api/chat/send publica el mensaje como el broadcaster', async () => {
    const response = await send('hola chat, esto lo escribí yo');
    assert.equal(response.status, 200, `respondió ${response.status}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.sent, true);
    assert.ok(response.body.messageId, 'debía devolver el message_id que asignó Twitch');

    const { messages } = await sentSoFar();
    assert.equal(messages.length, 1, `Helix recibió ${messages.length} mensajes`);
    const [published] = messages;
    assert.equal(published.text, 'hola chat, esto lo escribí yo');
    // El broadcaster escribe en su propio canal: emisor y canal son el mismo.
    assert.equal(published.broadcasterId, FAKE_CHANNEL.id);
    assert.equal(published.senderId, FAKE_CHANNEL.id);
    assert.equal(published.id, response.body.messageId, 'el messageId devuelto no es el de Twitch');
  });

  await check('el mensaje enviado vuelve por EventSub y llega al /ws (un solo camino de render)', async () => {
    // La suscripción tiene que existir antes de que el eco pueda entregarse.
    await waitFor('la suscripción a channel.chat.message', async () => {
      const stats = await getJson(`${eventSub.url}/_fake/eventsub/stats`);
      return stats.subscriptionsCreated >= 1;
    });

    hub = openHubClient();
    await hub.ready;

    const text = `de vuelta por EventSub ${Date.now()}`;
    const response = await send(text);
    assert.equal(response.status, 200, `respondió ${response.status}: ${JSON.stringify(response.body)}`);

    const frame = await waitFor(
      'la trama chat:message del mensaje propio',
      () => hub.chatMessages().find((item) => item.payload?.text === text) ?? null,
      { timeoutMs: 5_000, everyMs: 25 },
    );

    assert.equal(frame.type, CHAT_MESSAGE_TYPE);
    assert.equal(frame.payload.userId, FAKE_CHANNEL.id, 'el autor debe ser el canal propio');
    assert.equal(frame.payload.username, FAKE_CHANNEL.login);
    assert.equal(frame.payload.displayName, FAKE_CHANNEL.display_name);

    const { echoFailures } = await sentSoFar();
    assert.deepEqual(echoFailures, [], 'el eco por EventSub falló');
  });

  await check('el texto se recorta antes de publicarlo (Twitch no ve los espacios de sobra)', async () => {
    const response = await send('   con espacios alrededor   ');
    assert.equal(response.status, 200);

    const { messages } = await sentSoFar();
    assert.equal(messages.at(-1).text, 'con espacios alrededor');
  });

  await check(`un mensaje de exactamente ${MAX_MESSAGE_LENGTH} caracteres se publica`, async () => {
    const limit = 'a'.repeat(MAX_MESSAGE_LENGTH);
    const response = await send(limit);
    assert.equal(response.status, 200, `respondió ${response.status}: ${JSON.stringify(response.body)}`);

    const { messages } = await sentSoFar();
    assert.equal(messages.at(-1).text.length, MAX_MESSAGE_LENGTH);
  });

  section('validación (sin gastar una llamada a Twitch)');

  await check('un mensaje vacío no se envía', async () => {
    const before = (await sentSoFar()).count;
    const response = await send('');

    assert.equal(response.status, 400);
    assert.equal(response.body.code, CHAT_SEND_CODES.empty);
    assert.equal((await sentSoFar()).count, before, 'no debía llamar a Helix');
  });

  await check('un mensaje de solo espacios, tabs o saltos de línea no se envía', async () => {
    const before = (await sentSoFar()).count;

    for (const blank of ['   ', '\t\t', '\n', ' \t\n ']) {
      const response = await send(blank);
      assert.equal(response.status, 400, `"${JSON.stringify(blank)}" respondió ${response.status}`);
      assert.equal(response.body.code, CHAT_SEND_CODES.empty);
    }

    assert.equal((await sentSoFar()).count, before, 'no debía llamar a Helix');
  });

  await check('un cuerpo sin `text` (o con un `text` que no es texto) se rechaza igual', async () => {
    const before = (await sentSoFar()).count;

    for (const body of [{}, { text: null }, { text: 42 }, { text: { hola: 'mundo' } }, { texto: 'hola' }]) {
      const response = await postJson(`${backendUrl}/api/chat/send`, body);
      assert.equal(response.status, 400, `${JSON.stringify(body)} respondió ${response.status}`);
      assert.equal(response.body.code, CHAT_SEND_CODES.empty);
    }

    assert.equal((await sentSoFar()).count, before, 'no debía llamar a Helix');
  });

  await check(`un mensaje de más de ${MAX_MESSAGE_LENGTH} caracteres se rechaza antes de salir`, async () => {
    const before = (await sentSoFar()).count;
    const response = await send('b'.repeat(MAX_MESSAGE_LENGTH + 1));

    assert.equal(response.status, 400);
    assert.equal(response.body.code, CHAT_SEND_CODES.tooLong);
    assert.match(response.body.error, /500/);
    assert.equal((await sentSoFar()).count, before, 'no debía llamar a Helix');
  });

  section('fallos de Twitch');

  await check('un rechazo permanente de Twitch se reporta sin filtrar el token', async () => {
    await postJson(`${helix.url}/_fake/chat/fail`, { status: 401, message: 'Missing scope: user:write:chat' });
    const response = await send('esto lo va a rechazar Twitch');

    assert.equal(response.status, 502, `respondió ${response.status}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.code, CHAT_SEND_CODES.rejected);
    assert.match(response.body.error, /Missing scope/);

    const serialized = JSON.stringify(response.body);
    assert.equal(serialized.includes(SEEDED_ACCESS_TOKEN), false, 'se filtró el access token en el error');
    assert.equal(serialized.includes(CLIENT_SECRET), false, 'se filtró el client secret en el error');
  });

  await check('un fallo transitorio de Twitch se reporta como reintentable', async () => {
    await postJson(`${helix.url}/_fake/chat/fail`, { status: 500, message: 'Internal Server Error' });
    const response = await send('esto va a explotar del lado de Twitch');

    assert.equal(response.status, 503, `respondió ${response.status}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.code, CHAT_SEND_CODES.unavailable);
  });

  await check('un mensaje aceptado pero descartado (is_sent: false) se reporta con su motivo', async () => {
    await postJson(`${helix.url}/_fake/chat/drop`, {
      code: 'followers_only_mode',
      message: 'El canal está en modo solo-seguidores.',
    });
    const response = await send('mensaje que Twitch va a descartar');

    assert.equal(response.status, 422, `respondió ${response.status}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.code, CHAT_SEND_CODES.dropped);
    assert.match(response.body.error, /solo-seguidores/);
  });

  await check('tras los fallos, un envío normal vuelve a funcionar', async () => {
    const before = (await sentSoFar()).count;
    const response = await send('sigo funcionando');

    assert.equal(response.status, 200, `respondió ${response.status}: ${JSON.stringify(response.body)}`);
    assert.equal((await sentSoFar()).count, before + 1);
  });

  section('sin sesión');

  await check('sin tokens en la base, el envío responde 401 y no llama a Twitch', async () => {
    const before = (await sentSoFar()).count;
    assert.equal(repos.tokens.delete('twitch'), true, 'no había sesión sembrada que borrar');

    const response = await send('esto no debería salir');
    assert.equal(response.status, 401, `respondió ${response.status}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.code, CHAT_SEND_CODES.noSession);
    assert.equal((await sentSoFar()).count, before, 'no debía llamar a Helix');
  });

  section('higiene de las llamadas a Helix');

  await check('el imitador no rechazó ninguna llamada por headers o parámetros inválidos', async () => {
    const { rejected } = await sentSoFar();
    assert.equal(rejected, 0, `el imitador rechazó ${rejected} llamada(s): faltó client-id, bearer o un parámetro`);
  });

  await check('el backend sigue vivo y no registró errores inesperados', () => {
    assert.ok(backendAlive(), 'el backend murió durante la prueba');
    const output = backendOutput.join('');
    assert.equal(output.includes(SEEDED_ACCESS_TOKEN), false, 'el backend logueó el access token');
    assert.equal(output.includes(CLIENT_SECRET), false, 'el backend logueó el client secret');
  });
} finally {
  hub?.close();
  if (backendAlive()) {
    backend.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => backend.once('exit', resolve)), sleep(3_000)]);
    if (backendAlive()) {
      backend.kill('SIGKILL');
    }
  }
  db?.close();
  await helix.close();
  await eventSub.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} comprobaciones OK`);

if (failures > 0) {
  console.error(`${failures} comprobacion(es) fallaron`);
  console.error('\n--- salida del backend ---');
  console.error(backendOutput.join(''));
  process.exit(1);
}
