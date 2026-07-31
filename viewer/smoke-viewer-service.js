/**
 * Pruebas de humo del servicio de viewer (T-015):
 *
 *   npm --prefix viewer test
 *
 * A diferencia de los smoke tests de `backend/`, este levanta **dos procesos
 * reales** apuntados a la misma base SQLite temporal: el backend admin
 * (`backend/src/server.js`) y el servicio de viewer (`viewer/server.js`) — la
 * misma topología que en producción. La comprobación que le da sentido a este
 * archivo es la de la sección "garantía central": loguear a un viewer por
 * `viewer/server.js` no toca ni un bit de la sesión del bot que vive en el
 * backend admin.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { backendRoot } from '../backend/src/config.js';
import { createRepositories, openDatabase } from '../backend/src/db/index.js';
import { FAKE_CHANNEL, startFakeTwitch } from '../backend/scripts/fake-twitch.js';

const viewerRoot = path.dirname(fileURLToPath(import.meta.url));

const CLIENT_ID = 'dummy-client-id';
const CLIENT_SECRET = 'dummy-client-secret';
const FRONTEND_URL = 'http://localhost:5199';

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

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(description, probe, { timeoutMs = 10_000, everyMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) {
      return last;
    }
    await sleep(everyMs);
  }
  throw new Error(`timeout esperando ${description} (${timeoutMs} ms)`);
}

const getJson = async (url, options) => {
  const response = await fetch(url, options);
  assert.equal(response.status, 200, `${url} devolvió ${response.status}`);
  return response.json();
};

const hop = (url, options) => fetch(url, { redirect: 'manual', ...options });

const cookieValue = (setCookieHeader, name) => {
  const match = new RegExp(`${name}=([^;]+)`).exec(setCookieHeader ?? '');
  return match ? decodeURIComponent(match[1]) : null;
};

function spawnProcess(entrypoint, env) {
  const output = [];
  const child = spawn(process.execPath, [entrypoint], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  };
  return { child, output, stop };
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-hub-viewer-service-'));
const dbFile = path.join(tempDir, 'viewer-service.sqlite');

const fake = await startFakeTwitch({ port: 0, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

const adminPort = await freePort();
const adminUrl = `http://localhost:${adminPort}`;
const viewerPort = await freePort();
const viewerUrl = `http://localhost:${viewerPort}`;
const viewerRedirectUri = `${viewerUrl}/viewer-auth/callback`;

const sharedEnv = {
  DB_FILE: dbFile,
  HTTPS: 'false',
  FRONTEND_URL,
  TWITCH_CLIENT_ID: CLIENT_ID,
  TWITCH_CLIENT_SECRET: CLIENT_SECRET,
  TWITCH_AUTH_BASE_URL: fake.url,
  TWITCH_API_BASE_URL: fake.url,
};

const admin = spawnProcess(path.join(backendRoot, 'src', 'server.js'), {
  ...sharedEnv,
  PORT: String(adminPort),
  TWITCH_REDIRECT_URI: `${adminUrl}/auth/callback`,
  TWITCH_VIEWER_REDIRECT_URI: '',
});

const viewer = spawnProcess(path.join(viewerRoot, 'server.js'), {
  ...sharedEnv,
  VIEWER_SERVICE_PORT: String(viewerPort),
  TWITCH_REDIRECT_URI: `${adminUrl}/auth/callback`,
  TWITCH_VIEWER_REDIRECT_URI: viewerRedirectUri,
});

let db;
let repos;

try {
  await waitFor('que el backend admin responda', async () => {
    try {
      return (await getJson(`${adminUrl}/api/health`)).status === 'ok';
    } catch {
      return false;
    }
  });
  await waitFor('que el servicio de viewer responda', async () => {
    try {
      return (await getJson(`${viewerUrl}/api/health`)).status === 'ok';
    } catch {
      return false;
    }
  });

  db = openDatabase(dbFile);
  repos = createRepositories(db);

  section('la página estática se sirve');

  await check('GET / del viewer sirve el HTML de la pantalla', async () => {
    const response = await fetch(`${viewerUrl}/`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(body.includes('Configurá tu voz'));
  });

  section('sin sesión de viewer');

  await check('GET /viewer-auth/me responde { authenticated: false }', async () => {
    assert.deepEqual(await getJson(`${viewerUrl}/viewer-auth/me`), { authenticated: false, user: null });
  });

  await check('GET /viewer/preferences sin sesión responde 401', async () => {
    const response = await fetch(`${viewerUrl}/viewer/preferences`);
    assert.equal(response.status, 401);
  });

  section('el bot inicia sesión primero (como en producción)');

  let botTokensAfterLogin;

  await check('el bot completa su login por /auth/* en el backend admin', async () => {
    const login = await hop(`${adminUrl}/auth/login`);
    const consent = await hop(login.headers.get('location'));
    const callback = await hop(consent.headers.get('location'));
    assert.equal(new URL(callback.headers.get('location')).searchParams.get('auth_error'), null);

    botTokensAfterLogin = repos.tokens.get();
    assert.ok(botTokensAfterLogin, 'el bot debía quedar logueado');
  });

  section('flujo de login de un viewer contra el servicio separado');

  let authorizeUrl;

  await check('GET /viewer-auth/login (viewer) redirige con redirect_uri propio, sin scopes', async () => {
    const response = await hop(`${viewerUrl}/viewer-auth/login`);
    assert.equal(response.status, 302);
    authorizeUrl = new URL(response.headers.get('location'));
    assert.equal(authorizeUrl.searchParams.get('redirect_uri'), viewerRedirectUri);
    assert.notEqual(authorizeUrl.searchParams.get('redirect_uri'), `${adminUrl}/auth/callback`);
    assert.equal(authorizeUrl.searchParams.get('scope'), '');
  });

  let callbackUrl;

  await check('la consola vuelve al callback del viewer', async () => {
    const response = await hop(authorizeUrl.toString());
    callbackUrl = new URL(response.headers.get('location'));
    assert.equal(`${callbackUrl.origin}${callbackUrl.pathname}`, viewerRedirectUri);
  });

  let viewerCookie;

  await check('el callback crea la sesión y redirige RELATIVO (mismo origen, sin depender de FRONTEND_URL)', async () => {
    const response = await hop(callbackUrl.toString());
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/', 'el redirect debe ser relativo, no absoluto a otro origen');
    viewerCookie = cookieValue(response.headers.get('set-cookie'), 'viewer_session');
    assert.ok(viewerCookie);
  });

  const authHeader = { cookie: `viewer_session=${viewerCookie}` };

  await check('GET /viewer-auth/me con la cookie identifica al viewer', async () => {
    const body = await getJson(`${viewerUrl}/viewer-auth/me`, { headers: authHeader });
    assert.equal(body.authenticated, true);
    assert.equal(body.user.id, FAKE_CHANNEL.id);
  });

  section('catálogo y preferencias propias');

  let catalog;

  await check('GET /viewer/catalog devuelve el catálogo agregado (incluye la voz del navegador)', async () => {
    catalog = await getJson(`${viewerUrl}/viewer/catalog`, { headers: authHeader });
    assert.ok(Array.isArray(catalog.voices) && catalog.voices.length > 0);
  });

  await check('GET /viewer/preferences antes de guardar nada da los defaults', async () => {
    const prefs = await getJson(`${viewerUrl}/viewer/preferences`, { headers: authHeader });
    assert.deepEqual(prefs, { voiceId: null, volume: 1, pitch: 1, timbre: 1 });
  });

  const chosenVoice = catalog.voices[0];

  await check('PATCH /viewer/preferences guarda voz/volumen/pitch/timbre propios', async () => {
    const response = await fetch(`${viewerUrl}/viewer/preferences`, {
      method: 'PATCH',
      headers: { ...authHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ voiceId: chosenVoice.id, volume: 0.7, pitch: 1.2, timbre: 0.9 }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.voiceId, chosenVoice.id);
    assert.equal(body.volume, 0.7);
  });

  await check('la fila quedó en users con voice_source = override', () => {
    const user = repos.users.get(FAKE_CHANNEL.id);
    assert.ok(user, 'debía existir la fila del viewer');
    assert.equal(user.voiceSource, 'override');
    assert.equal(user.voiceId, chosenVoice.id);
  });

  await check('PATCH con una clave prohibida (muted) se rechaza con 400, sin tocar la fila', async () => {
    const before = repos.users.get(FAKE_CHANNEL.id);
    const response = await fetch(`${viewerUrl}/viewer/preferences`, {
      method: 'PATCH',
      headers: { ...authHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ muted: true }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(repos.users.get(FAKE_CHANNEL.id), before);
  });

  await check('PATCH ignora cualquier intento de decir "userId": no hay forma de tocar a otro', async () => {
    const response = await fetch(`${viewerUrl}/viewer/preferences`, {
      method: 'PATCH',
      headers: { ...authHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ userId: '000000', volume: 0.5 }),
    });
    // "userId" no está en ALLOWED_KEYS: se rechaza el cuerpo entero.
    assert.equal(response.status, 400);
  });

  section('garantía central: nada de esto tocó la sesión del bot');

  await check('repos.tokens.get() sigue siendo exactamente el mismo', () => {
    assert.deepEqual(repos.tokens.get(), botTokensAfterLogin);
  });

  await check('GET /api/session del backend admin sigue reportando el canal del bot', async () => {
    assert.deepEqual(await getJson(`${adminUrl}/api/session`), {
      authenticated: true,
      channel: { id: FAKE_CHANNEL.id, login: FAKE_CHANNEL.login, displayName: FAKE_CHANNEL.display_name },
    });
  });

  section('logout');

  await check('POST /viewer-auth/logout cierra la sesión del viewer', async () => {
    const response = await fetch(`${viewerUrl}/viewer-auth/logout`, { method: 'POST', headers: authHeader });
    assert.equal(response.status, 200);
    const after = await getJson(`${viewerUrl}/viewer-auth/me`, { headers: authHeader });
    assert.deepEqual(after, { authenticated: false, user: null });
  });

  await check('la sesión del bot sigue intacta después del logout del viewer', () => {
    assert.deepEqual(repos.tokens.get(), botTokensAfterLogin);
  });
} finally {
  admin.stop();
  viewer.stop();
  db?.close();
  await fake.close();
}

section('flujo deshabilitado (viewer sin TWITCH_VIEWER_REDIRECT_URI)');

const disabledDbFile = path.join(tempDir, 'viewer-service-disabled.sqlite');
const fakeForDisabled = await startFakeTwitch({ port: 0, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
const disabledPort = await freePort();
const disabledUrl = `http://localhost:${disabledPort}`;

const disabledViewer = spawnProcess(path.join(viewerRoot, 'server.js'), {
  ...sharedEnv,
  DB_FILE: disabledDbFile,
  TWITCH_AUTH_BASE_URL: fakeForDisabled.url,
  TWITCH_API_BASE_URL: fakeForDisabled.url,
  VIEWER_SERVICE_PORT: String(disabledPort),
  TWITCH_VIEWER_REDIRECT_URI: '',
});

try {
  await waitFor('que el viewer deshabilitado responda', async () => {
    try {
      return (await getJson(`${disabledUrl}/api/health`)).status === 'ok';
    } catch {
      return false;
    }
  });

  await check('sin TWITCH_VIEWER_REDIRECT_URI, /viewer-auth/* responde 404', async () => {
    const response = await fetch(`${disabledUrl}/viewer-auth/login`, { redirect: 'manual' });
    assert.equal(response.status, 404);
  });

  await check('pero la página estática se sigue sirviendo (no depende del login)', async () => {
    const response = await fetch(`${disabledUrl}/`);
    assert.equal(response.status, 200);
  });
} finally {
  disabledViewer.stop();
  await fakeForDisabled.close();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

console.log(`\n${checks - failures}/${checks} comprobaciones OK`);

if (failures > 0) {
  console.error(`${failures} comprobacion(es) fallaron`);
  process.exit(1);
}
