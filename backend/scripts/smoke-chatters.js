/**
 * Pruebas de humo de la columna de usuarios híbrida (T-007):
 *
 *   npm --prefix backend run test:chatters
 *
 * Levanta dos imitadores y **el backend real** como proceso hijo apuntado a
 * ellos, se conecta al `/ws` como lo haría el navegador y recorre el camino
 * completo de la columna derecha:
 *
 *   Get Chatters (presentes) + relay de mensajes (activos) → merge con SQLite
 *   (`muted`/`ignored`) → `broadcast('users:list', …)` → `/ws`.
 *
 * - `scripts/fake-chatters.js` sirve `GET /helix/chat/chatters` y reenvía el
 *   resto (OAuth, `/helix/users`, suscripciones de EventSub) a
 *   `scripts/fake-eventsub.js`, de modo que un solo `TWITCH_API_BASE_URL` cubre
 *   todo y se pueden inyectar mensajes de chat reales por EventSub.
 * - El intervalo del poll se baja con `TWITCH_CHATTERS_POLL_MS` (en producción
 *   son 60 s: la prueba sería eterna).
 *
 * No necesita credenciales reales ni red: la sesión se siembra en una base SQLite
 * temporal (`DB_FILE`) con tokens opacos sin ningún valor. No toca
 * `backend/data/app.sqlite`.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { WebSocket } from 'ws';

import { TWITCH_DEFAULTS, backendRoot } from '../src/config.js';
import { SETTING_KEYS, createRepositories, openDatabase } from '../src/db/index.js';
import { CHATTERS_ENDPOINT, CHATTERS_PAGE_SIZE, CHATTERS_SCOPE } from '../src/twitch/chatters.js';
import { USERS_LIST_TYPE } from '../src/users/presence.js';
import { FAKE_CHANNEL } from './fake-twitch.js';
import { startFakeEventSub } from './fake-eventsub.js';
import { FAKE_CHATTERS, startFakeChatters } from './fake-chatters.js';

const CLIENT_ID = 'dummy-client-id';
const CLIENT_SECRET = 'dummy-client-secret';
const SCOPES = ['user:read:chat', 'user:write:chat', 'moderator:read:chatters'];
/** Poll corto: en producción son 60 s (`TWITCH_CHATTERS_POLL_MS`). */
const CHATTERS_POLL_MS = 700;
/** Sondeo agresivo de la sesión para que el relay conecte de inmediato. */
const SESSION_POLL_MS = 200;
/** Un autor debe subir a la columna sin esperar al siguiente poll. */
const ACTIVITY_BUDGET_MS = 500;

/** Claves exactas de cada usuario en la trama `users:list`. */
const USER_FIELDS = [
  'userId',
  'username',
  'displayName',
  'present',
  'active',
  'muted',
  'ignored',
  'volume',
  'pitch',
  'timbre',
  'voiceId',
  'voiceSource',
  'firstSeenAt',
  'lastActiveAt',
  'known',
];

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

async function waitFor(description, probe, { timeoutMs = 10_000, everyMs = 25 } = {}) {
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

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-hub-chatters-'));
const dbFile = path.join(tempDir, 'chatters.sqlite');

// --- Sesión sembrada: el backend arranca creyendo que ya hay login -----------
const seedDb = openDatabase(dbFile);
const seedRepos = createRepositories(seedDb);
seedRepos.tokens.save({
  provider: 'twitch',
  accessToken: 'fake-access-sembrado',
  refreshToken: 'fake-refresh-sembrado',
  // 4 h de vida: por encima del margen de refresco (5 min).
  expiresAt: Date.now() + 4 * 60 * 60 * 1_000,
  scopes: SCOPES,
});
seedRepos.settings.setAll({
  [SETTING_KEYS.twitchUserId]: FAKE_CHANNEL.id,
  [SETTING_KEYS.twitchLogin]: FAKE_CHANNEL.login,
  [SETTING_KEYS.twitchDisplayName]: FAKE_CHANNEL.display_name,
});
seedDb.close();

const eventsub = await startFakeEventSub({
  port: 0,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  keepaliveSeconds: 10,
  keepaliveIntervalMs: 2_000,
});

// Páginas de 3 para que el cliente tenga que seguir el `pagination.cursor`.
const chatters = await startFakeChatters({
  port: 0,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  pageSize: 3,
  forwardBaseUrl: eventsub.url,
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
    TWITCH_AUTH_BASE_URL: chatters.url,
    TWITCH_API_BASE_URL: chatters.url,
    TWITCH_EVENTSUB_WS_URL: eventsub.wsUrl,
    TWITCH_CHAT_SESSION_POLL_MS: String(SESSION_POLL_MS),
    // Esta prueba no debe tocar internet: sin edge-tts (T-009) las voces `edge:*`
    // se resuelven al motor del navegador, que es lo que estas aserciones fijan.
    TTS_EDGE_ENABLED: 'false',
    TWITCH_CHATTERS_POLL_MS: String(CHATTERS_POLL_MS),
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
  return { status: response.status, body: await response.json().catch(() => null) };
};

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
    lists: () => frames.filter((frame) => frame.type === USERS_LIST_TYPE),
    lastList: () => {
      const lists = frames.filter((frame) => frame.type === USERS_LIST_TYPE);
      return lists.length === 0 ? null : lists[lists.length - 1];
    },
    ready: new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    }),
    close: () => socket.close(),
  };
}

/** Espera una trama `users:list` posterior a `after` que cumpla `predicate`. */
const waitForList = (hub, description, predicate, options) =>
  waitFor(description, () => hub.lists().find((frame) => predicate(frame.payload, frame)) ?? null, options);

const findUser = (payload, userId) => payload.users.find((user) => user.userId === userId) ?? null;

let db;
let repos;
let hub;
let secondHub;

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

  section('contrato de Get Chatters (el imitador no se debe filtrar a producción)');

  await check('los defaults son los de Twitch y el poll son 60 s', () => {
    assert.equal(TWITCH_DEFAULTS.apiBaseUrl, 'https://api.twitch.tv');
    assert.equal(TWITCH_DEFAULTS.chattersPollMs, 60_000, 'el default del poll debe seguir siendo 60 s');
    assert.equal(CHATTERS_ENDPOINT, '/helix/chat/chatters');
    assert.equal(CHATTERS_PAGE_SIZE, 1_000, 'Twitch admite como máximo 1000 por página');
    assert.ok(TWITCH_DEFAULTS.scopes.includes(CHATTERS_SCOPE), `falta el scope ${CHATTERS_SCOPE}`);
  });

  await check('el backend consulta con broadcaster_id y moderator_id del canal', async () => {
    const stats = await waitFor('la primera consulta de chatters', async () => {
      const current = await chatters.stats();
      return current.requests >= 1 ? current : null;
    });

    assert.equal(stats.lastQuery.broadcaster_id, FAKE_CHANNEL.id);
    assert.equal(stats.lastQuery.moderator_id, FAKE_CHANNEL.id, 'el moderator_id debe ser el usuario del token');
    assert.equal(stats.lastQuery.first, String(CHATTERS_PAGE_SIZE));
    assert.equal(stats.rejected, 0, `el imitador rechazó ${stats.rejected} consulta(s)`);
  });

  await check('sigue el pagination.cursor hasta traer el roster completo', async () => {
    // El imitador sirve páginas de 3 y el roster tiene 4: hacen falta 2 páginas
    // por poll, y la segunda lleva el `after` de la primera.
    const stats = await waitFor(
      'la segunda página del roster',
      async () => {
        const current = await chatters.stats();
        return current.pages >= 2 ? current : null;
      },
      { timeoutMs: CHATTERS_POLL_MS * 6 },
    );
    assert.ok(stats.pages >= 2, `solo pidió ${stats.pages} página(s): no siguió el cursor`);
    assert.ok(stats.lastQuery.after, 'la última consulta debía llevar el cursor `after`');
  });

  section('presentes por polling (aunque no escriban)');

  hub = openHubClient();
  await hub.ready;

  await check('la trama users:list trae a los cuatro presentes con el shape documentado', async () => {
    const frame = await waitForList(hub, 'la lista de usuarios', (payload) => payload.users.length >= FAKE_CHATTERS.length);

    assert.equal(frame.type, USERS_LIST_TYPE);
    assert.deepEqual(Object.keys(frame.payload).sort(), ['activeCount', 'presentCount', 'rosterAvailable', 'rosterFetchedAt', 'updatedAt', 'users'].sort());
    assert.equal(frame.payload.rosterAvailable, true);
    assert.equal(frame.payload.presentCount, FAKE_CHATTERS.length);
    assert.equal(frame.payload.activeCount, 0, 'nadie ha escrito todavía');

    for (const expected of FAKE_CHATTERS) {
      const user = findUser(frame.payload, expected.user_id);
      assert.ok(user, `falta el presente ${expected.user_login}`);
      assert.deepEqual(Object.keys(user).sort(), [...USER_FIELDS].sort(), `claves inesperadas en ${expected.user_login}`);
      assert.equal(user.username, expected.user_login);
      assert.equal(user.displayName, expected.user_name);
      assert.equal(user.present, true);
      assert.equal(user.active, false, 'un lurker no puede venir como activo');
      assert.equal(user.known, false, 'quien nunca ha escrito no tiene fila en users');
      assert.equal(user.muted, false);
      assert.equal(user.ignored, false);
      assert.equal(user.lastActiveAt, null);
    }
  });

  await check('un presente que no escribe NO se inserta en la tabla users', () => {
    assert.equal(repos.users.count(), 0, 'la presencia no debe escribir en users: eso lo hace el relay por mensaje');
  });

  await check('el poll se repite con el intervalo configurado', async () => {
    const before = await chatters.stats();
    const after = await waitFor(
      'un segundo poll',
      async () => {
        const current = await chatters.stats();
        return current.requests > before.requests ? current : null;
      },
      { timeoutMs: CHATTERS_POLL_MS * 6 },
    );
    assert.ok(after.requests > before.requests, 'el poll no se repitió');
  });

  section('actividad por mensaje (aparece y sube al instante)');

  await check('quien escribe aparece como activo sin esperar al siguiente poll', async () => {
    const listsBefore = hub.lists().length;
    const sentAt = Date.now();
    const { status } = await postJson(`${eventsub.url}/_fake/eventsub/say`, {
      text: 'hola, soy nueva por aquí',
      userId: '777000999',
      username: 'recien_llegada',
      displayName: 'RecienLlegada',
    });
    assert.equal(status, 200, 'el imitador no pudo enviar el mensaje');

    const frame = await waitForList(hub, 'la lista con la autora del mensaje', (payload) => findUser(payload, '777000999')?.active === true);

    const latencyMs = frame.receivedAt - sentAt;
    assert.ok(latencyMs < ACTIVITY_BUDGET_MS, `tardó ${latencyMs} ms (el poll es de ${CHATTERS_POLL_MS} ms)`);
    assert.ok(hub.lists().length > listsBefore, 'debía publicarse una trama nueva');

    const user = findUser(frame.payload, '777000999');
    assert.equal(user.username, 'recien_llegada');
    assert.equal(user.displayName, 'RecienLlegada');
    assert.equal(user.active, true);
    assert.equal(user.known, true, 'el relay ya debió hacer upsert en users');
    assert.equal(user.present, false, 'no está en el roster del imitador todavía');
    assert.ok(user.lastActiveAt > 0, 'debe traer last_active_at');
    assert.equal(frame.payload.users[0].userId, '777000999', 'el autor más reciente va primero');
    console.log(`       (${latencyMs} ms del mensaje a la trama users:list)`);
  });

  await check('los activos se ordenan por actividad reciente, y antes que los lurkers', async () => {
    await postJson(`${eventsub.url}/_fake/eventsub/say`, {
      text: 'yo también hablo',
      userId: '555000222',
      username: 'lurker_dos',
      displayName: 'LurkerDos',
    });

    const frame = await waitForList(hub, 'la lista con dos activos', (payload) => payload.activeCount === 2);

    assert.equal(frame.payload.users[0].userId, '555000222', 'el último en hablar va primero');
    assert.equal(frame.payload.users[1].userId, '777000999');
    assert.equal(frame.payload.users[0].present, true, 'este sí está en el roster');
    for (const user of frame.payload.users.slice(2)) {
      assert.equal(user.active, false, 'los lurkers van después de los activos');
    }
  });

  section('flags de SQLite reflejados en la trama');

  await check('muted e ignored viajan al frontend en el poll siguiente', async () => {
    // Como lo dejaría T-011 al mutear e ignorar desde el panel.
    repos.users.updatePreferences('777000999', { muted: true, volume: 0.4, pitch: 1.25, voiceId: 'edge:es-ES-ElviraNeural', voiceSource: 'override' });
    repos.users.updatePreferences('555000222', { ignored: true });

    const frame = await waitForList(hub, 'la lista con los flags', (payload) => findUser(payload, '777000999')?.muted === true && findUser(payload, '555000222')?.ignored === true, {
      timeoutMs: CHATTERS_POLL_MS * 6,
    });

    const muted = findUser(frame.payload, '777000999');
    assert.equal(muted.muted, true);
    assert.equal(muted.ignored, false);
    assert.equal(muted.volume, 0.4);
    assert.equal(muted.pitch, 1.25);
    assert.equal(muted.voiceId, 'edge:es-ES-ElviraNeural');
    assert.equal(muted.voiceSource, 'override');
    assert.equal(findUser(frame.payload, '555000222').ignored, true);
  });

  section('entradas y salidas entre polls');

  await check('quien entra al chat aparece en el poll siguiente', async () => {
    await chatters.setChatters([
      ...FAKE_CHATTERS,
      { user_id: '555000555', user_login: 'llego_tarde', user_name: 'LlegoTarde' },
    ]);

    const frame = await waitForList(hub, 'la lista con el recién llegado', (payload) => findUser(payload, '555000555') !== null, {
      timeoutMs: CHATTERS_POLL_MS * 6,
    });

    const user = findUser(frame.payload, '555000555');
    assert.equal(user.present, true);
    assert.equal(user.active, false);
    assert.equal(user.displayName, 'LlegoTarde');
  });

  await check('quien se va del chat se saca de la lista, aunque haya hablado', async () => {
    // `lurker_dos` está en el roster desde el arranque de la prueba y ya habló
    // (ver 'los activos se ordenan...'): a esta altura Get Chatters ya la
    // confirmó presente al menos una vez, así que al dejar de aparecer en un
    // roster nuevo se la debe podar de los activos.
    await chatters.setChatters([]);

    const frame = await waitForList(hub, 'la lista después de que se fue todo el mundo presente', (payload) => payload.presentCount === 0, {
      timeoutMs: CHATTERS_POLL_MS * 6,
    });

    assert.equal(findUser(frame.payload, '555000111'), null, 'un lurker que se fue no debe seguir en la lista');
    assert.equal(findUser(frame.payload, '555000555'), null);
    assert.equal(findUser(frame.payload, '555000222'), null, 'habló y estuvo presente, pero se fue: se saca de la lista');

    // `recien_llegada` (777000999) nunca llegó a aparecer en un roster de Get
    // Chatters (el imitador no la incluye): no hay confirmación de que se haya
    // ido, así que se le sigue dando el margen de "activa" en vez de sacarla.
    const neverConfirmed = findUser(frame.payload, '777000999');
    assert.ok(neverConfirmed, 'sin confirmación de presencia previa, se conserva mientras siga activa');
    assert.equal(neverConfirmed.present, false);
    assert.equal(neverConfirmed.active, true);
    assert.equal(frame.payload.users.length, 1, 'la lista queda con la única sin confirmar');

    // Vuelve a entrar: que la hayan podado antes no debe impedirle reaparecer.
    await chatters.setChatters([{ user_id: '555000222', user_login: 'lurker_dos', user_name: 'LurkerDos' }]);
    const backFrame = await waitForList(hub, 'la lista con lurker_dos de vuelta', (payload) => findUser(payload, '555000222') !== null, {
      timeoutMs: CHATTERS_POLL_MS * 6,
    });
    const back = findUser(backFrame.payload, '555000222');
    assert.equal(back.present, true);
    assert.equal(back.active, false, 'al reaparecer no cuenta como activa: no volvió a escribir, solo volvió a estar presente');
  });

  section('robustez');

  await check('si Twitch rechaza Get Chatters se conserva el último roster y se reintenta', async () => {
    const before = hub.lastList().payload;
    await chatters.failNext({ status: 401, times: 1, message: 'Missing scope: moderator:read:chatters' });

    const stats = await waitFor(
      'la consulta rechazada',
      async () => {
        const current = await chatters.stats();
        return current.rejected >= 1 ? current : null;
      },
      { timeoutMs: CHATTERS_POLL_MS * 6 },
    );
    assert.ok(stats.rejected >= 1);
    assert.ok(backendAlive(), 'el backend murió tras el rechazo');

    const frame = await waitForList(hub, 'una lista posterior al rechazo', (payload) => payload.updatedAt > before.updatedAt, {
      timeoutMs: CHATTERS_POLL_MS * 8,
    });
    assert.equal(frame.payload.rosterAvailable, true, 'no debe perder el roster conocido');
    assert.ok(findUser(frame.payload, '555000222'), 'el presente conocido debe seguir ahí');
    assert.ok(backendOutput.join('').includes(CHATTERS_SCOPE), 'el log debe nombrar el scope que falta');
  });

  await check('un navegador que se conecta después recibe la lista sin esperar el poll', async () => {
    secondHub = openHubClient();
    await secondHub.ready;
    const connectedAt = Date.now();

    const frame = await waitFor('la lista para el cliente nuevo', () => secondHub.lastList(), { timeoutMs: 1_000 });
    const latencyMs = frame.receivedAt - connectedAt;
    assert.ok(latencyMs < 500, `tardó ${latencyMs} ms en recibir la lista inicial`);
    assert.ok(frame.payload.users.length > 0, 'la lista inicial venía vacía');
    console.log(`       (${latencyMs} ms desde la conexión al users:list)`);
  });

  await check('el backend no filtró ningún token en su salida', () => {
    const output = backendOutput.join('');
    assert.equal(output.includes('fake-access-sembrado'), false, 'se filtró el access token');
    assert.equal(output.includes('fake-refresh-sembrado'), false, 'se filtró el refresh token');
    assert.equal(output.includes(CLIENT_SECRET), false, 'se filtró el client secret');
  });

  section('apagado');

  await check('SIGTERM detiene el backend con el poll activo y clientes conectados', async () => {
    const exited = new Promise((resolve) => backend.once('exit', (code, signal) => resolve({ code, signal })));
    const started = Date.now();
    backend.kill('SIGTERM');

    const exit = await Promise.race([
      exited,
      sleep(8_000).then(() => {
        throw new Error('el backend no terminó 8 s después de SIGTERM');
      }),
    ]);

    const elapsedMs = Date.now() - started;
    assert.equal(exit.signal, null, `murió por señal ${exit.signal}`);
    assert.equal(exit.code, 0, `código de salida ${exit.code}`);
    assert.ok(elapsedMs < 2_000, `el cierre tardó ${elapsedMs} ms: salió por el temporizador de seguridad`);
    assert.equal(backendOutput.join('').includes('cierre forzado'), false, 'el apagado ordenado no completó');
    console.log(`       (cerró en ${elapsedMs} ms, sin cierre forzado)`);
  });
} finally {
  hub?.close();
  secondHub?.close();
  if (backendAlive()) {
    backend.kill('SIGKILL');
  }
  db?.close();
  await chatters.close();
  await eventsub.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} comprobaciones OK`);

if (failures > 0) {
  console.error(`${failures} comprobacion(es) fallaron`);
  console.error('\n--- salida del backend ---');
  console.error(backendOutput.join(''));
  process.exit(1);
}
