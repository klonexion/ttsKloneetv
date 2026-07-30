/**
 * Pruebas de humo de los ajustes globales (T-013):
 *
 *   npm --prefix backend run test:settings
 *
 * Cubre los tres criterios de la tarea que se pueden medir en el backend:
 *
 * 1. **La voz global cambia a los usuarios sin override ni voz de comando desde el
 *    mensaje siguiente y sin reiniciar** (el pipeline y el relay con los que se
 *    comprueba se construyen *antes* de la escritura), conservando el pitch de
 *    todos y sin tocar los niveles 1 y 2.
 * 2. **El volumen maestro** se persiste, se redondea, se valida y llega a
 *    `GET /api/settings` (lo aplica la reproducción, que vive en el frontend).
 * 3. **El tema sobrevive a un reinicio de verdad**: se comprueba dos veces, con el
 *    archivo SQLite cerrado y reabierto, y con **el backend real** apagado con
 *    SIGTERM y vuelto a levantar sobre la misma base.
 *
 * La segunda mitad levanta `src/server.js` como proceso hijo, que es lo que prueba
 * que la ruta está **montada en `src/app.js`** (sin esa línea el gate se cae en
 * bloque). No necesita red ni credenciales reales (los motores TTS de servidor se
 * apagan por variable de entorno y no hay sesión de Twitch), trabaja sobre una base
 * temporal (`DB_FILE`) y un puerto libre, y no toca `backend/data/app.sqlite`.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import express from 'express';

import { VOICE_ROLL_COMMAND, createChatCommands } from '../src/chat/commands.js';
import { CHAT_PROVIDER_STATUS } from '../src/chat/provider.js';
import { createChatRelay } from '../src/chat/relay.js';
import { backendRoot } from '../src/config.js';
import { createRepositories, openDatabase } from '../src/db/index.js';
import { SETTING_KEYS } from '../src/db/repositories/settings.js';
import { createSettingsRouter } from '../src/settings/router.js';
import {
  DEFAULT_MASTER_VOLUME,
  DEFAULT_THEME,
  GLOBAL_SETTING_KEYS,
  MASTER_VOLUME_KEY,
  THEMES,
  normalizeMasterVolume,
  normalizeTheme,
  parseGlobalSettingsPatch,
} from '../src/settings/settings.js';
import { TTS_ENGINE_KINDS, TTS_ENGINE_NAMES } from '../src/tts/index.js';
import { createTtsPipeline } from '../src/tts/pipeline.js';
import { createTtsEngineRegistry } from '../src/tts/registry.js';
import { VOICE_SOURCES } from '../src/tts/voice-model.js';

const VOICE_SEMBRADA = 'edge:es-MX-DaliaNeural';
const VOICE_OVERRIDE = 'edge:es-ES-AlvaroNeural';
const VOICE_COMMAND = 'edge:es-AR-ElenaNeural';
const VOICE_NUEVA_GLOBAL = 'edge:es-CO-SalomeNeural';
const VOICE_PIPER = 'piper:es_MX-ald-medium';

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

/** Reintenta `probe` hasta que devuelva algo verdadero o se agote el tiempo. */
async function waitFor(description, probe, { timeoutMs = 15_000, everyMs = 100 } = {}) {
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

/**
 * Motor de servidor de juguete: los ids `edge:*` no caen al respaldo. Su catálogo
 * es en español porque el comando `!cambia-mi-voz` de T-012 sortea de ahí.
 */
const createFakeEdgeEngine = () => ({
  name: TTS_ENGINE_NAMES.edge,
  kind: TTS_ENGINE_KINDS.server,
  isAvailable: async () => true,
  listVoices: async () =>
    [VOICE_SEMBRADA, VOICE_OVERRIDE, VOICE_COMMAND, VOICE_NUEVA_GLOBAL].map((id) => ({
      id,
      name: id.split(':')[1],
      engine: TTS_ENGINE_NAMES.edge,
      language: 'es-MX',
      label: id,
    })),
  synthesize: async () => ({ format: 'mp3', base64: 'ZmFrZQ==' }),
});

/** Provider falso: deja empujar mensajes al relay como si vinieran de EventSub. */
const createFakeProvider = () => {
  const handlers = new Map();
  return {
    name: 'fake',
    start: () => {},
    stop: () => {},
    getStatus: () => CHAT_PROVIDER_STATUS.subscribed,
    on(event, handler) {
      if (!handlers.has(event)) {
        handlers.set(event, new Set());
      }
      handlers.get(event).add(handler);
      return () => handlers.get(event).delete(handler);
    },
    emit(event, value) {
      for (const handler of handlers.get(event) ?? []) {
        handler(value);
      }
    },
  };
};

let messageSeq = 0;
const makeMessage = (overrides = {}) => {
  messageSeq += 1;
  return {
    id: `msg-${messageSeq}`,
    userId: '100',
    username: 'juan',
    displayName: 'Juan',
    text: 'hola mundo',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
};

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-hub-settings-'));
const dbFile = path.join(tempDir, 'settings.sqlite');

let db = openDatabase(dbFile);
let repos = createRepositories(db);
const repositories = () => repos;

const registry = createTtsEngineRegistry();
registry.register(createFakeEdgeEngine());

let httpServer = null;
let relay = null;
let backend = null;
const backendOutput = [];

/** Apaga el backend hijo; SIGTERM primero, como haría PM2. */
const stopBackend = async (child, { signal = 'SIGTERM', timeoutMs = 5000 } = {}) => {
  if (child === null || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill(signal);
  const raced = await Promise.race([once(child, 'exit'), sleep(timeoutMs).then(() => null)]);
  if (raced === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
};

try {
  section('lectura: defaults y valores imposibles');

  await check('las claves son las de app_settings (dos de T-002 y la nueva del volumen)', () => {
    assert.equal(GLOBAL_SETTING_KEYS.globalVoiceId, SETTING_KEYS.globalVoiceId);
    assert.equal(GLOBAL_SETTING_KEYS.theme, SETTING_KEYS.theme);
    assert.equal(GLOBAL_SETTING_KEYS.masterVolume, 'tts_master_volume');
    assert.equal(MASTER_VOLUME_KEY, 'tts_master_volume');
  });

  await check('el tema sembrado es oscuro y la voz global la del plan', () => {
    assert.equal(repos.settings.getTheme(), DEFAULT_THEME);
    assert.equal(DEFAULT_THEME, 'dark');
    assert.equal(repos.settings.getGlobalVoiceId(), VOICE_SEMBRADA);
  });

  await check('el volumen maestro no está sembrado y su default no atenúa', () => {
    assert.equal(repos.settings.get(MASTER_VOLUME_KEY), null, 'no debe existir la fila antes de guardarla');
    assert.equal(DEFAULT_MASTER_VOLUME, 1);
    assert.equal(normalizeMasterVolume(null), 1);
  });

  await check('un valor imposible en la base se lee como su default, no revienta', () => {
    assert.equal(normalizeTheme('fucsia'), DEFAULT_THEME);
    assert.equal(normalizeTheme(undefined), DEFAULT_THEME);
    assert.equal(normalizeMasterVolume('no-es-un-numero'), DEFAULT_MASTER_VOLUME);
    assert.equal(normalizeMasterVolume('7'), DEFAULT_MASTER_VOLUME, 'fuera de rango vuelve al default');
    assert.equal(normalizeMasterVolume('0.4'), 0.4, 'SQLite guarda TEXT: hay que parsearlo');
    assert.equal(normalizeMasterVolume('0'), 0, 'silencio total es un valor legítimo');
  });

  section('validación del patch (sin HTTP)');

  await check('parseGlobalSettingsPatch traduce a las claves de app_settings', () => {
    assert.deepEqual(parseGlobalSettingsPatch({ theme: 'light' }), { theme: 'light' });
    assert.deepEqual(parseGlobalSettingsPatch({ globalVoiceId: VOICE_PIPER }), { global_voice_id: VOICE_PIPER });
    assert.deepEqual(parseGlobalSettingsPatch({ masterVolume: 0.5 }), { tts_master_volume: 0.5 });
    assert.deepEqual(parseGlobalSettingsPatch({ globalVoiceId: `  ${VOICE_PIPER}  ` }), { global_voice_id: VOICE_PIPER });
  });

  await check('el ruido de coma flotante del slider no llega a la base', () => {
    // 1 - 0.05 * 2 en coma flotante es 0.8999999999999999.
    assert.deepEqual(parseGlobalSettingsPatch({ masterVolume: 1 - 0.05 * 2 }), { tts_master_volume: 0.9 });
  });

  await check('rechaza lo que no puede guardar, con código', () => {
    const casos = [
      [{ desconocido: 1 }, 'unknown_key'],
      [{}, 'empty'],
      [{ theme: 'fucsia' }, 'invalid'],
      [{ theme: null }, 'invalid'],
      [{ masterVolume: 1.5 }, 'out_of_range'],
      [{ masterVolume: -0.1 }, 'out_of_range'],
      [{ masterVolume: null }, 'invalid'],
      [{ masterVolume: '0.5' }, 'invalid'],
      [{ globalVoiceId: null }, 'invalid'],
      [{ globalVoiceId: '' }, 'invalid'],
      [{ globalVoiceId: '   ' }, 'invalid'],
      [{ globalVoiceId: 7 }, 'invalid'],
      [{ globalVoiceId: 'x'.repeat(201) }, 'invalid'],
      [null, 'invalid'],
      [[{ theme: 'light' }], 'invalid'],
    ];

    for (const [body, code] of casos) {
      let thrown = null;
      try {
        parseGlobalSettingsPatch(body);
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown !== null, `${JSON.stringify(body)} debía ser rechazado`);
      assert.equal(thrown.code, code, `${JSON.stringify(body)} → ${thrown.code}`);
      assert.ok(thrown.message.length > 0, 'el aviso debe traer texto para mostrar');
    }
  });

  await check('un patch inválido no escribe nada de lo que traía', () => {
    const antes = repos.settings.all();
    assert.throws(() => parseGlobalSettingsPatch({ theme: 'light', masterVolume: 9 }));
    assert.deepEqual(repos.settings.all(), antes);
  });

  section('la ruta: GET y PATCH /api/settings');

  const app = express();
  app.use(express.json());
  app.use('/api/settings', createSettingsRouter({ repositories }));
  httpServer = app.listen(0);
  await once(httpServer, 'listening');
  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;

  const getSettings = async () => {
    const response = await fetch(`${baseUrl}/api/settings`, { headers: { accept: 'application/json' } });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  const patchSettings = async (body) => {
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  await check('GET devuelve los cuatro ajustes con sus defaults', async () => {
    const { status, body } = await getSettings();
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body.settings).sort(), ['globalVoiceId', 'masterTimbre', 'masterVolume', 'theme']);
    assert.deepEqual(body.settings, { globalVoiceId: VOICE_SEMBRADA, theme: 'dark', masterVolume: 1, masterTimbre: 1 });
  });

  await check('PATCH guarda los cuatro de golpe y devuelve los vigentes', async () => {
    const { status, body } = await patchSettings({ globalVoiceId: VOICE_PIPER, theme: 'light', masterVolume: 0.35 });
    assert.equal(status, 200);
    assert.deepEqual(body.settings, { globalVoiceId: VOICE_PIPER, theme: 'light', masterVolume: 0.35, masterTimbre: 1 });
    assert.equal(repos.settings.get(SETTING_KEYS.theme), 'light');
    assert.equal(repos.settings.get(MASTER_VOLUME_KEY), '0.35', 'app_settings guarda TEXT');
    assert.equal(repos.settings.getGlobalVoiceId(), VOICE_PIPER);
  });

  await check('un PATCH parcial no pisa los otros ajustes', async () => {
    const { body } = await patchSettings({ theme: 'dark' });
    assert.deepEqual(body.settings, { globalVoiceId: VOICE_PIPER, theme: 'dark', masterVolume: 0.35, masterTimbre: 1 });
  });

  await check('los dos temas se pueden guardar y volver a leer', async () => {
    for (const theme of THEMES) {
      await patchSettings({ theme });
      const { body } = await getSettings();
      assert.equal(body.settings.theme, theme);
    }
  });

  await check('un PATCH inválido responde 400 con código y no cambia nada', async () => {
    const antes = (await getSettings()).body.settings;
    for (const [body, code] of [
      [{ masterVolume: 2 }, 'out_of_range'],
      [{ theme: 'fucsia' }, 'invalid'],
      [{ globalVoiceId: null }, 'invalid'],
      [{ otro: true }, 'unknown_key'],
      [{}, 'empty'],
    ]) {
      const response = await patchSettings(body);
      assert.equal(response.status, 400, `${JSON.stringify(body)} debía ser 400`);
      assert.equal(response.body.code, code);
      assert.ok(response.body.error.length > 0);
    }
    assert.deepEqual((await getSettings()).body.settings, antes);
  });

  await check('el volumen maestro admite silencio total y el tope', async () => {
    assert.equal((await patchSettings({ masterVolume: 0 })).body.settings.masterVolume, 0);
    assert.equal((await patchSettings({ masterVolume: 1 })).body.settings.masterVolume, 1);
  });

  // Se deja la voz global sembrada para el bloque del pipeline.
  await patchSettings({ globalVoiceId: VOICE_SEMBRADA, theme: 'dark', masterVolume: 1 });

  section('la voz global aplica desde el mensaje siguiente, sin reiniciar');

  // El pipeline y el relay con los que se comprueba se construyen **antes** de
  // escribir el ajuste: nada se reinicia en el medio.
  const pipeline = createTtsPipeline({ registry, repositories });
  const hubFrames = [];
  const fakeHub = { broadcast: (type, payload) => hubFrames.push({ type, payload }) };
  const provider = createFakeProvider();
  const seen = [];

  relay = createChatRelay({
    hub: fakeHub,
    provider,
    repositories,
    tts: pipeline,
    // Los comandos de T-012 con el registro de juguete: así `!cambia-mi-voz`
    // sortea del catálogo falso y el gate sigue sin red.
    commands: createChatCommands({ repositories, registry, random: () => 0.99 }),
    sessionPollMs: 60_000,
    isSessionReady: () => true,
  });
  relay.onMessage((message) => seen.push(message));
  relay.start();

  const say = async (userId, username, text = 'hola') => {
    const message = makeMessage({ userId, username, displayName: username, text });
    provider.emit('message', message);
    await waitFor(`el mensaje ${message.id} procesado`, () => seen.some((item) => item.id === message.id), { timeoutMs: 2000 });
    return hubFrames.find((item) => item.payload.id === message.id) ?? null;
  };

  await say('201', 'conoverride');
  await say('202', 'concomando');
  await say('203', 'conglobal');
  repos.users.updatePreferences('201', { voiceId: VOICE_OVERRIDE, voiceSource: VOICE_SOURCES.override });
  repos.users.updatePreferences('202', { voiceId: VOICE_COMMAND, voiceSource: VOICE_SOURCES.command });

  const pitchesAntes = ['201', '202', '203'].map((id) => repos.users.get(id).pitch);

  await check('antes del cambio los tres se leen con la voz de su nivel', async () => {
    assert.equal((await say('201', 'conoverride')).payload.tts.voiceId, VOICE_OVERRIDE);
    assert.equal((await say('202', 'concomando')).payload.tts.voiceId, VOICE_COMMAND);
    assert.equal((await say('203', 'conglobal')).payload.tts.voiceId, VOICE_SEMBRADA);
  });

  await check('cambiar la voz global por la ruta mueve solo al nivel 3, sin reiniciar', async () => {
    const { status } = await patchSettings({ globalVoiceId: VOICE_NUEVA_GLOBAL });
    assert.equal(status, 200);

    assert.equal((await say('201', 'conoverride')).payload.tts.voiceId, VOICE_OVERRIDE, 'el override no se toca');
    assert.equal((await say('202', 'concomando')).payload.tts.voiceId, VOICE_COMMAND, 'la voz de comando no se toca');
    assert.equal((await say('203', 'conglobal')).payload.tts.voiceId, VOICE_NUEVA_GLOBAL, 'el nivel 3 sí cambia');
  });

  await check('y el pitch individual de todos se conserva', () => {
    assert.deepEqual(
      ['201', '202', '203'].map((id) => repos.users.get(id).pitch),
      pitchesAntes,
    );
  });

  await check('las filas de los niveles 1 y 2 quedan intactas', () => {
    assert.equal(repos.users.get('201').voiceSource, 'override');
    assert.equal(repos.users.get('201').voiceId, VOICE_OVERRIDE);
    assert.equal(repos.users.get('202').voiceSource, 'command');
    assert.equal(repos.users.get('202').voiceId, VOICE_COMMAND);
  });

  await check('guardar ajustes globales no escribe nada en la tabla users', async () => {
    const antes = repos.users.list();
    await patchSettings({ globalVoiceId: VOICE_PIPER, masterVolume: 0.5, theme: 'light' });
    assert.deepEqual(repos.users.list(), antes, 'los ajustes globales no tocan ninguna fila de users');
    // Y se deja como estaba para las comprobaciones siguientes.
    await patchSettings({ globalVoiceId: VOICE_NUEVA_GLOBAL, masterVolume: 1, theme: 'dark' });
  });

  section('interacción con T-012: la voz sorteada con !cambia-mi-voz no la pisa la global');

  // Aquí el nivel 2 no se escribe a mano (como arriba) sino con el **comando real**
  // de T-012 pasando por el relay: es la única forma de fijar que las dos tareas de
  // esta ola conviven (`voice_source = 'command'` lo escribe `assignUserVoice`).
  let voiceDelComando = null;

  await check('el comando real deja al usuario en nivel 2 (voice_source = command)', async () => {
    await say('205', 'rodadora');
    assert.equal(repos.users.get('205').voiceSource, null, 'nace en el nivel 3');

    const frame = await say('205', 'rodadora', VOICE_ROLL_COMMAND);
    assert.equal(frame.payload.tts, null, 'el comando se ve pero no se lee (filtro de T-008)');

    const user = await waitFor('la voz del comando escrita', () => {
      const row = repos.users.get('205');
      return row.voiceSource === VOICE_SOURCES.command ? row : false;
    });
    voiceDelComando = user.voiceId;
    assert.ok(typeof voiceDelComando === 'string' && voiceDelComando !== '', 'el comando debía dejar una voz');
    assert.notEqual(voiceDelComando, VOICE_NUEVA_GLOBAL, 'el sorteo no puede devolver la voz que ya tenía');
  });

  await check('cambiar la voz global NO pisa la voz que se sorteó con el comando', async () => {
    const pitchAntes = repos.users.get('205').pitch;
    const { status } = await patchSettings({ globalVoiceId: VOICE_SEMBRADA });
    assert.equal(status, 200);

    const frame = await say('205', 'rodadora', 'después de cambiar la global');
    assert.equal(frame.payload.tts.voiceId, voiceDelComando, 'la voz de comando manda sobre la global');
    const user = repos.users.get('205');
    assert.equal(user.voiceId, voiceDelComando, 'y la fila no se reescribió');
    assert.equal(user.voiceSource, VOICE_SOURCES.command);
    assert.equal(user.pitch, pitchAntes, 'su pitch tampoco cambia');
  });

  await check('en el mismo cambio, el override sigue intacto y el nivel 3 sí se mueve', async () => {
    assert.equal((await say('201', 'conoverride')).payload.tts.voiceId, VOICE_OVERRIDE);
    assert.equal((await say('203', 'conglobal')).payload.tts.voiceId, VOICE_SEMBRADA);
    assert.equal(repos.users.get('201').voiceSource, 'override');
  });

  await check('y el comando puede volver a rodar sobre su propia voz después del cambio', async () => {
    await say('205', 'rodadora', VOICE_ROLL_COMMAND);
    const user = await waitFor('la segunda voz del comando', () => {
      const row = repos.users.get('205');
      return row.voiceId !== voiceDelComando ? row : false;
    });
    assert.equal(user.voiceSource, VOICE_SOURCES.command);
    const frame = await say('205', 'rodadora', 'con la segunda voz de comando');
    assert.equal(frame.payload.tts.voiceId, user.voiceId);
  });

  // Se deja la global que espera el bloque del reinicio.
  await patchSettings({ globalVoiceId: VOICE_NUEVA_GLOBAL });

  section('el tema sobrevive a un reinicio (mismo archivo SQLite)');

  await check('reabrir la base devuelve los tres ajustes guardados', async () => {
    await patchSettings({ theme: 'light', masterVolume: 0.4 });

    relay.stop();
    relay = null;
    db.close();
    db = openDatabase(dbFile);
    repos = createRepositories(db);

    assert.equal(repos.settings.getTheme(), 'light', 'el tema se perdió al reabrir la base');
    assert.equal(normalizeMasterVolume(repos.settings.get(MASTER_VOLUME_KEY)), 0.4);
    assert.equal(repos.settings.getGlobalVoiceId(), VOICE_NUEVA_GLOBAL);
  });

  await check('la migración es idempotente y NO pisa el tema que eligió el operador', () => {
    // `openDatabase()` migra en cada apertura (T-002): si usara INSERT OR REPLACE
    // en vez de INSERT OR IGNORE, el tema volvería a `dark` en cada arranque.
    const otra = openDatabase(dbFile);
    try {
      assert.equal(createRepositories(otra).settings.getTheme(), 'light');
    } finally {
      otra.close();
    }
  });

  section('el backend real: la ruta está montada en app.js y sobrevive al reinicio');

  const backendPort = await freePort();
  const backendUrl = `http://localhost:${backendPort}`;
  const backendEnv = {
    ...process.env,
    PORT: String(backendPort),
    DB_FILE: dbFile,
    // Hermeticidad: la app real puede tener HTTPS=true en el `.env` de la raíz
    // (Twitch lo exige), pero esta prueba habla HTTP plano contra el hijo.
    HTTPS: 'false',
    TWITCH_CLIENT_ID: 'dummy-client-id',
    TWITCH_CLIENT_SECRET: 'dummy-client-secret',
    // Herméticos: sin sesión no se sale a Twitch, y los motores de servidor no
    // deben tocar la red ni el disco durante el gate.
    TTS_EDGE_ENABLED: 'false',
    TTS_PIPER_ENABLED: 'false',
  };

  const startBackend = async () => {
    const child = spawn(process.execPath, [path.join(backendRoot, 'src', 'server.js')], {
      env: backendEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => backendOutput.push(String(chunk)));
    child.stderr.on('data', (chunk) => backendOutput.push(String(chunk)));
    await waitFor('que el backend responda /api/health', async () => {
      try {
        const response = await fetch(`${backendUrl}/api/health`);
        return response.ok;
      } catch {
        return false;
      }
    });
    return child;
  };

  const liveSettings = async () => {
    const response = await fetch(`${backendUrl}/api/settings`, { headers: { accept: 'application/json' } });
    assert.equal(response.status, 200, `GET /api/settings devolvió ${response.status}`);
    return (await response.json()).settings;
  };

  backend = await startBackend();

  await check('GET /api/settings responde en el backend real (la ruta está montada)', async () => {
    const settings = await liveSettings();
    assert.deepEqual(settings, { globalVoiceId: VOICE_NUEVA_GLOBAL, theme: 'light', masterVolume: 0.4, masterTimbre: 1 });
  });

  await check('PATCH /api/settings guarda contra la base real del proceso', async () => {
    const response = await fetch(`${backendUrl}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ theme: 'light', masterVolume: 0.65, globalVoiceId: VOICE_SEMBRADA }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).settings, {
      globalVoiceId: VOICE_SEMBRADA,
      theme: 'light',
      masterVolume: 0.65,
      masterTimbre: 1,
    });
  });

  await check('los ajustes sobreviven a un reinicio real del backend (SIGTERM + arranque)', async () => {
    await stopBackend(backend);
    assert.ok(
      !backendOutput.join('').includes('cierre forzado'),
      'el backend necesitó el cierre forzado de los 5 s (regresión del shutdown)',
    );
    backend = await startBackend();

    assert.deepEqual(await liveSettings(), {
      globalVoiceId: VOICE_SEMBRADA,
      theme: 'light',
      masterVolume: 0.65,
      masterTimbre: 1,
    });
  });

  await check('un PATCH inválido contra el backend real responde 400 sin filtrar secretos', async () => {
    const response = await fetch(`${backendUrl}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ masterVolume: 42 }),
    });
    assert.equal(response.status, 400);
    const text = JSON.stringify(await response.json());
    assert.match(text, /out_of_range/);
    assert.doesNotMatch(text, /dummy-client-secret/);
    assert.doesNotMatch(backendOutput.join(''), /dummy-client-secret/);
  });
} finally {
  relay?.stop();
  await stopBackend(backend);
  if (httpServer !== null) {
    httpServer.closeAllConnections?.();
    await new Promise((resolve) => httpServer.close(resolve));
  }
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} comprobaciones ok`);
if (failures > 0) {
  console.error(`${failures} comprobación(es) fallaron`);
  process.exit(1);
}
