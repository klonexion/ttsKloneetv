/**
 * Pruebas de humo del flujo OAuth de Twitch (T-003):
 *
 *   npm --prefix backend run test:oauth
 *
 * Levanta el imitador de Twitch (`scripts/fake-twitch.js`) y **el backend real**
 * como proceso hijo apuntado a él, y recorre el flujo completo por HTTP como lo
 * haría el navegador: `/auth/login` → authorize → `/auth/callback` →
 * `/api/session`, comprobando la persistencia en SQLite en cada paso.
 *
 * No necesita credenciales reales ni red: el `client_id`/`client_secret` son
 * valores dummy que el imitador exige igual que Twitch exigiría los reales, y
 * los tokens que circulan son cadenas opacas sin ningún valor. Trabaja sobre una
 * base SQLite temporal (`DB_FILE`) y un puerto libre, así que no toca
 * `backend/data/app.sqlite` ni pelea con un backend que ya esté corriendo.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { TWITCH_DEFAULTS, backendRoot } from '../src/config.js';
import { SETTING_KEYS, createRepositories, openDatabase } from '../src/db/index.js';
import { FAKE_CHANNEL, startFakeTwitch } from './fake-twitch.js';

const CLIENT_ID = 'dummy-client-id';
const CLIENT_SECRET = 'dummy-client-secret';
const FRONTEND_URL = 'http://localhost:5199';
/** Intervalo agresivo del ciclo de refresco para que la prueba no tarde. */
const TOKEN_CHECK_INTERVAL_MS = 200;
const SCOPES = 'user:read:chat user:write:chat moderator:read:chatters';

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reintenta `probe` hasta que devuelva algo verdadero o se agote el tiempo. */
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

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-hub-oauth-'));
const dbFile = path.join(tempDir, 'oauth.sqlite');

const fake = await startFakeTwitch({ port: 0, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
const backendPort = await freePort();
const backendUrl = `http://localhost:${backendPort}`;
const redirectUri = `${backendUrl}/auth/callback`;

const backendOutput = [];
const backend = spawn(process.execPath, [path.join(backendRoot, 'src', 'server.js')], {
  env: {
    ...process.env,
    PORT: String(backendPort),
    DB_FILE: dbFile,
    // Hermeticidad: la app real puede tener HTTPS=true en el `.env` de la raíz
    // (Twitch lo exige), pero esta prueba habla HTTP plano contra el hijo.
    HTTPS: 'false',
    FRONTEND_URL,
    TWITCH_CLIENT_ID: CLIENT_ID,
    TWITCH_CLIENT_SECRET: CLIENT_SECRET,
    TWITCH_REDIRECT_URI: redirectUri,
    TWITCH_AUTH_BASE_URL: fake.url,
    TWITCH_API_BASE_URL: fake.url,
    TWITCH_TOKEN_CHECK_INTERVAL_MS: String(TOKEN_CHECK_INTERVAL_MS),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

backend.stdout.on('data', (chunk) => backendOutput.push(String(chunk)));
backend.stderr.on('data', (chunk) => backendOutput.push(String(chunk)));

const stopBackend = () => {
  if (backend.exitCode === null && backend.signalCode === null) {
    // SIGKILL: el apagado ordenado se cuelga si queda algún cliente WebSocket.
    backend.kill('SIGKILL');
  }
};

const getJson = async (url) => {
  const response = await fetch(url);
  assert.equal(response.status, 200, `${url} devolvió ${response.status}`);
  return response.json();
};

const hop = (url) => fetch(url, { redirect: 'manual' });

const fakeStats = () => getJson(`${fake.url}/_fake/stats`);

let db;
let repos;

try {
  await waitFor('que el backend responda /api/health', async () => {
    try {
      const health = await getJson(`${backendUrl}/api/health`);
      return health.status === 'ok';
    } catch {
      return false;
    }
  });

  db = openDatabase(dbFile);
  repos = createRepositories(db);

  section('defaults de configuración');

  await check('los endpoints por default son los reales de Twitch', () => {
    assert.equal(TWITCH_DEFAULTS.authBaseUrl, 'https://id.twitch.tv');
    assert.equal(TWITCH_DEFAULTS.apiBaseUrl, 'https://api.twitch.tv');
    assert.equal(TWITCH_DEFAULTS.redirectUri, 'http://localhost:3000/auth/callback');
    assert.deepEqual([...TWITCH_DEFAULTS.scopes], SCOPES.split(' '));
  });

  section('estado sin sesión');

  await check('GET /api/session responde { authenticated: false, channel: null }', async () => {
    assert.deepEqual(await getJson(`${backendUrl}/api/session`), { authenticated: false, channel: null });
  });

  await check('la tabla tokens está vacía', () => {
    assert.equal(repos.tokens.get(), null);
    assert.deepEqual(repos.tokens.list(), []);
  });

  section('flujo de login');

  let authorizeUrl;

  await check('GET /auth/login redirige a la pantalla de consentimiento con los scopes exactos', async () => {
    const response = await hop(`${backendUrl}/auth/login`);
    assert.equal(response.status, 302, `se esperaba 302, llegó ${response.status}`);

    authorizeUrl = new URL(response.headers.get('location'));
    assert.equal(authorizeUrl.origin, fake.url, 'la URL base de Twitch debe venir de la configuración');
    assert.equal(authorizeUrl.pathname, '/oauth2/authorize');
    assert.equal(authorizeUrl.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(authorizeUrl.searchParams.get('redirect_uri'), redirectUri);
    assert.equal(authorizeUrl.searchParams.get('response_type'), 'code');
    assert.equal(authorizeUrl.searchParams.get('scope'), SCOPES);
    assert.ok((authorizeUrl.searchParams.get('state') ?? '').length >= 16, 'falta el state (CSRF)');
  });

  let callbackUrl;

  await check('la pantalla de consentimiento vuelve al callback con code y el mismo state', async () => {
    const response = await hop(authorizeUrl.toString());
    assert.equal(response.status, 302, `se esperaba 302, llegó ${response.status}`);

    callbackUrl = new URL(response.headers.get('location'));
    assert.equal(`${callbackUrl.origin}${callbackUrl.pathname}`, redirectUri);
    assert.ok(callbackUrl.searchParams.get('code'), 'falta el code');
    assert.equal(callbackUrl.searchParams.get('state'), authorizeUrl.searchParams.get('state'));
  });

  await check('GET /auth/callback canjea el code y devuelve el navegador al frontend', async () => {
    const response = await hop(callbackUrl.toString());
    assert.equal(response.status, 302, `se esperaba 302, llegó ${response.status}`);

    const target = new URL(response.headers.get('location'));
    assert.equal(target.origin, FRONTEND_URL);
    assert.equal(target.searchParams.get('auth_error'), null, `el redirect trae error: ${target.search}`);
  });

  let firstTokens;

  await check('los tokens quedan persistidos en la tabla tokens (una sola fila)', () => {
    firstTokens = repos.tokens.get();
    assert.ok(firstTokens, 'no hay fila de tokens');
    assert.equal(firstTokens.provider, 'twitch');
    assert.ok(firstTokens.accessToken.length > 0, 'access_token vacío');
    assert.ok(firstTokens.refreshToken.length > 0, 'refresh_token vacío');
    assert.ok(firstTokens.expiresAt > Date.now(), 'expires_at no está en el futuro');
    assert.deepEqual(firstTokens.scopes, SCOPES.split(' '));
    assert.equal(repos.tokens.list().length, 1);
  });

  await check('la identidad del canal queda en app_settings', () => {
    assert.equal(repos.settings.get(SETTING_KEYS.twitchUserId), FAKE_CHANNEL.id);
    assert.equal(repos.settings.get(SETTING_KEYS.twitchLogin), FAKE_CHANNEL.login);
    assert.equal(repos.settings.get(SETTING_KEYS.twitchDisplayName), FAKE_CHANNEL.display_name);
  });

  await check('GET /api/session responde { authenticated: true, channel }', async () => {
    assert.deepEqual(await getJson(`${backendUrl}/api/session`), {
      authenticated: true,
      channel: { id: FAKE_CHANNEL.id, login: FAKE_CHANNEL.login, displayName: FAKE_CHANNEL.display_name },
    });
  });

  section('callbacks inválidos');

  await check('un callback con state desconocido se descarta sin tocar la sesión', async () => {
    const response = await hop(`${backendUrl}/auth/callback?code=cualquiera&state=inventado`);
    assert.equal(response.status, 302);
    assert.equal(new URL(response.headers.get('location')).searchParams.get('auth_error'), 'state');
    assert.deepEqual(repos.tokens.get(), firstTokens, 'los tokens no debían cambiar');
  });

  await check('reusar un state ya canjeado se descarta (nonce de un solo uso)', async () => {
    const response = await hop(callbackUrl.toString());
    assert.equal(response.status, 302);
    assert.equal(new URL(response.headers.get('location')).searchParams.get('auth_error'), 'state');
    assert.deepEqual(repos.tokens.get(), firstTokens, 'los tokens no debían cambiar');
  });

  await check('si el usuario cancela en Twitch, el frontend recibe auth_error=denied', async () => {
    const login = await hop(`${backendUrl}/auth/login`);
    const denyUrl = new URL(login.headers.get('location'));
    denyUrl.searchParams.set('fake_deny', '1');

    const denied = await hop(denyUrl.toString());
    assert.equal(denied.status, 302);
    const back = new URL(denied.headers.get('location'));
    assert.equal(`${back.origin}${back.pathname}`, redirectUri);
    assert.equal(back.searchParams.get('error'), 'access_denied');

    const response = await hop(back.toString());
    assert.equal(new URL(response.headers.get('location')).searchParams.get('auth_error'), 'denied');
    assert.deepEqual(repos.tokens.get(), firstTokens, 'los tokens no debían cambiar');
  });

  section('refresh automático');

  const statsBeforeRefresh = await fakeStats();

  await check('con expires_at en el pasado, el backend refresca solo (sin intervención)', async () => {
    // Exactamente la comprobación del criterio: forzar la expiración en SQLite.
    repos.tokens.save({ ...firstTokens, expiresAt: Date.now() - 1_000 });
    assert.ok(repos.tokens.get().expiresAt < Date.now());

    const refreshed = await waitFor('el refresh automático', () => {
      const current = repos.tokens.get();
      return current && current.accessToken !== firstTokens.accessToken ? current : null;
    });

    assert.ok(refreshed.expiresAt > Date.now(), 'el expires_at nuevo no está en el futuro');
    assert.notEqual(refreshed.refreshToken, firstTokens.refreshToken, 'Twitch rota el refresh token');
    assert.deepEqual(refreshed.scopes, SCOPES.split(' '), 'los scopes deben conservarse');
    assert.equal(repos.tokens.list().length, 1, 'el refresh no debe duplicar filas (save es upsert)');

    const stats = await fakeStats();
    assert.equal(
      stats.refreshGrants,
      statsBeforeRefresh.refreshGrants + 1,
      'se esperaba exactamente un grant refresh_token contra Twitch',
    );
  });

  await check('la sesión sigue autenticada y con el mismo canal después del refresh', async () => {
    assert.deepEqual(await getJson(`${backendUrl}/api/session`), {
      authenticated: true,
      channel: { id: FAKE_CHANNEL.id, login: FAKE_CHANNEL.login, displayName: FAKE_CHANNEL.display_name },
    });
  });

  await check('si Twitch rechaza el refresh token, la sesión se borra y vuelve el login', async () => {
    const current = repos.tokens.get();
    repos.tokens.save({ ...current, refreshToken: 'fake-refresh-revocado', expiresAt: Date.now() - 1_000 });

    await waitFor('que el backend borre la sesión rechazada', () => repos.tokens.get() === null);

    assert.deepEqual(await getJson(`${backendUrl}/api/session`), { authenticated: false, channel: null });
    assert.equal(repos.settings.get(SETTING_KEYS.twitchUserId), null, 'la identidad del canal debía limpiarse');
    assert.equal(repos.settings.getGlobalVoiceId(), 'edge:es-MX-DaliaNeural', 'no debe tocar otros ajustes');
  });

  section('volver a iniciar sesión');

  await check('después de perder la sesión, un login nuevo la restablece', async () => {
    const login = await hop(`${backendUrl}/auth/login`);
    const consent = await hop(login.headers.get('location'));
    const callback = await hop(consent.headers.get('location'));

    assert.equal(new URL(callback.headers.get('location')).searchParams.get('auth_error'), null);
    assert.deepEqual(await getJson(`${backendUrl}/api/session`), {
      authenticated: true,
      channel: { id: FAKE_CHANNEL.id, login: FAKE_CHANNEL.login, displayName: FAKE_CHANNEL.display_name },
    });
    assert.equal(repos.tokens.list().length, 1);
  });
} finally {
  stopBackend();
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
