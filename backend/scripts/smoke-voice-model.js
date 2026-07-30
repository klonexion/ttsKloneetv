/**
 * Pruebas de humo del modelo de voz/pitch y de las acciones por usuario (T-011):
 *
 *   npm --prefix backend run test:voice-model
 *
 * Cubre los cuatro criterios de la tarea:
 *
 * 1. **Pitch aleatorio persistente** en [0.8, 1.4] asignado en el primer mensaje
 *    y estable después, incluso **entre reinicios** (se cierra y se reabre el
 *    archivo SQLite de verdad).
 * 2. **Prioridad `override` > `command` > global**, con un usuario en cada estado
 *    pasando por el pipeline real.
 * 3. **Cambiar la voz global afecta solo al nivel 3** y conserva todos los pitch.
 * 4. **Mutear, volumen, ignorar, voz y pitch desde el panel** persisten en SQLite
 *    y aplican al **siguiente mensaje sin reiniciar** (el pipeline y el relay que
 *    se usan para comprobarlo se construyen *antes* de las escrituras).
 *
 * Trabaja sobre una base SQLite temporal en el directorio temporal del SO, un hub
 * y un provider de chat falsos y un Express en el puerto 0: no necesita `.env`, ni
 * red, ni puertos fijos, y no toca `backend/data/app.sqlite`.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express from 'express';

import { CHAT_PROVIDER_STATUS } from '../src/chat/provider.js';
import { createChatRelay } from '../src/chat/relay.js';
import { createRepositories, openDatabase } from '../src/db/index.js';
import { SETTING_KEYS } from '../src/db/repositories/settings.js';
import { TTS_ENGINE_KINDS, TTS_ENGINE_NAMES, TTS_SKIP_REASONS } from '../src/tts/index.js';
import { createTtsEngineRegistry } from '../src/tts/registry.js';
import { createTtsPipeline } from '../src/tts/pipeline.js';
import {
  PITCH_RANDOM_MAX,
  PITCH_RANDOM_MIN,
  TIMBRE_RANDOM_MAX,
  TIMBRE_RANDOM_MIN,
  VOICE_LEVELS,
  VOICE_SOURCES,
  assignUserVoice,
  canAssignVoice,
  combineTimbre,
  isRandomPitchInRange,
  isRandomTimbreInRange,
  randomUserPitch,
  randomUserTimbre,
  resolveUserVoice,
  voiceLevelOf,
} from '../src/tts/voice-model.js';
import { createUsersRouter } from '../src/users/router.js';
import { parsePreferencesPatch } from '../src/users/preferences.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-hub-voice-'));
const dbFile = path.join(tempDir, 'smoke.sqlite');

const VOICE_OVERRIDE = 'edge:es-ES-AlvaroNeural';
const VOICE_COMMAND = 'edge:es-AR-ElenaNeural';
const VOICE_GLOBAL = 'edge:es-MX-DaliaNeural';
const VOICE_GLOBAL_NUEVA = 'edge:es-CO-SalomeNeural';

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

const waitFor = async (label, predicate, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timeout esperando ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** Motor de servidor de juguete, para que los ids `edge:*` no caigan al respaldo. */
const createFakeEdgeEngine = () => ({
  name: TTS_ENGINE_NAMES.edge,
  kind: TTS_ENGINE_KINDS.server,
  isAvailable: async () => true,
  listVoices: async () => [VOICE_GLOBAL, VOICE_OVERRIDE, VOICE_COMMAND].map((id) => ({
    id,
    name: id.split(':')[1],
    engine: TTS_ENGINE_NAMES.edge,
    language: 'es-MX',
    label: id,
  })),
  synthesize: async () => ({ format: 'mp3', base64: 'ZmFrZQ==' }),
});

/** Mensaje normalizado como el que entrega el provider de T-004. */
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

let db = openDatabase(dbFile);
let repos = createRepositories(db);
const repositories = () => repos;

const registry = createTtsEngineRegistry();
registry.register(createFakeEdgeEngine());
const pipeline = createTtsPipeline({ registry, repositories });

/** Voz que el pipeline pediría para un usuario, resolviendo la prioridad. */
const decidedVoice = (userId) => pipeline.decide(makeMessage({ userId })).tts?.voiceId ?? null;

let httpServer = null;
let relay = null;

try {
  section('pitch aleatorio: rango y reparto');

  await check(`randomUserPitch() siempre cae en [${PITCH_RANDOM_MIN}, ${PITCH_RANDOM_MAX}]`, () => {
    for (let i = 0; i < 500; i += 1) {
      const pitch = randomUserPitch();
      assert.ok(isRandomPitchInRange(pitch), `pitch fuera de rango: ${pitch}`);
      assert.equal(pitch, Number(pitch.toFixed(2)), `el pitch debe tener 2 decimales: ${pitch}`);
    }
  });

  await check('reparte tonos distintos (no es una constante disfrazada)', () => {
    const values = new Set();
    for (let i = 0; i < 200; i += 1) {
      values.add(randomUserPitch());
    }
    assert.ok(values.size > 10, `solo salieron ${values.size} valores distintos en 200 tiradas`);
  });

  await check('los extremos del generador dan exactamente los del rango', () => {
    assert.equal(randomUserPitch(() => 0), PITCH_RANDOM_MIN);
    assert.equal(randomUserPitch(() => 0.999999999), PITCH_RANDOM_MAX);
    assert.equal(randomUserPitch(() => 0.5), 1.1);
  });

  await check('isRandomPitchInRange rechaza lo que está fuera y lo que no es número', () => {
    assert.equal(isRandomPitchInRange(0.79), false);
    assert.equal(isRandomPitchInRange(1.41), false);
    assert.equal(isRandomPitchInRange(Number.NaN), false);
    assert.equal(isRandomPitchInRange(null), false);
    assert.equal(isRandomPitchInRange(1), true);
  });

  section('timbre aleatorio: rango, reparto y combinación con el maestro');

  await check(`randomUserTimbre() siempre cae en [${TIMBRE_RANDOM_MIN}, ${TIMBRE_RANDOM_MAX}]`, () => {
    for (let i = 0; i < 500; i += 1) {
      const timbre = randomUserTimbre();
      assert.ok(isRandomTimbreInRange(timbre), `timbre fuera de rango: ${timbre}`);
      assert.equal(timbre, Number(timbre.toFixed(2)), `el timbre debe tener 2 decimales: ${timbre}`);
    }
  });

  await check('reparte timbres distintos (no es una constante disfrazada)', () => {
    const values = new Set();
    for (let i = 0; i < 200; i += 1) {
      values.add(randomUserTimbre());
    }
    assert.ok(values.size > 10, `solo salieron ${values.size} valores distintos en 200 tiradas`);
  });

  await check('los extremos del generador dan exactamente los del rango', () => {
    assert.equal(randomUserTimbre(() => 0), TIMBRE_RANDOM_MIN);
    assert.equal(randomUserTimbre(() => 0.999999999), TIMBRE_RANDOM_MAX);
    assert.equal(randomUserTimbre(() => 0.5), 1.1);
  });

  await check('el pitch y el timbre son sorteos independientes (fuentes de azar separadas)', () => {
    // Fuentes fijas distintas: si compartieran generador, darían el mismo número.
    assert.equal(randomUserPitch(() => 0.25), 0.95);
    assert.equal(randomUserTimbre(() => 0.75), 1.25);
  });

  await check('combineTimbre: el maestro neutro (1) no cambia nada', () => {
    assert.equal(combineTimbre(1, 1), 1);
    assert.equal(combineTimbre(1.3, 1), 1.3);
    assert.equal(combineTimbre(0.85, 1), 0.85);
  });

  await check('combineTimbre: se suman los desvíos, no se multiplican los valores', () => {
    // 1.3 individual + (1.3 master - 1) = 1.6 — no 1.3*1.3 = 1.69.
    assert.equal(Number(combineTimbre(1.3, 1.3).toFixed(2)), 1.6);
    assert.equal(Number(combineTimbre(0.9, 0.8).toFixed(2)), 0.7);
  });

  await check('combineTimbre: el resultado se recorta a 0–2', () => {
    assert.equal(combineTimbre(2, 2), 2, 'se recorta arriba');
    assert.equal(combineTimbre(0, 0), 0, 'se recorta abajo');
  });

  await check('combineTimbre: valores inválidos caen al neutro (1), no rompen', () => {
    assert.equal(combineTimbre(Number.NaN, 1), 1);
    assert.equal(combineTimbre(1, undefined), 1);
    assert.equal(combineTimbre(null, null), 1);
  });

  section('prioridad de la voz: override > command > global');

  await check('voiceLevelOf clasifica los tres niveles', () => {
    assert.equal(voiceLevelOf({ voiceId: VOICE_OVERRIDE, voiceSource: 'override' }).level, VOICE_LEVELS.override);
    assert.equal(voiceLevelOf({ voiceId: VOICE_COMMAND, voiceSource: 'command' }).level, VOICE_LEVELS.command);
    assert.equal(voiceLevelOf({ voiceId: null, voiceSource: null }).level, VOICE_LEVELS.global);
    assert.equal(voiceLevelOf(null).level, VOICE_LEVELS.global);
  });

  await check('una fila con voz pero sin origen se respeta como nivel 2 (solo la produce SQL a mano)', () => {
    const level = voiceLevelOf({ voiceId: VOICE_COMMAND, voiceSource: null });
    assert.equal(level.level, VOICE_LEVELS.command);
    assert.equal(level.voiceId, VOICE_COMMAND);
    assert.equal(level.source, null);
  });

  await check('resolveUserVoice aplica la prioridad completa', () => {
    assert.equal(resolveUserVoice({ voiceId: VOICE_OVERRIDE, voiceSource: 'override' }, VOICE_GLOBAL).voiceId, VOICE_OVERRIDE);
    assert.equal(resolveUserVoice({ voiceId: VOICE_COMMAND, voiceSource: 'command' }, VOICE_GLOBAL).voiceId, VOICE_COMMAND);
    assert.equal(resolveUserVoice({ voiceId: null, voiceSource: null }, VOICE_GLOBAL).voiceId, VOICE_GLOBAL);
    assert.equal(resolveUserVoice(null, VOICE_GLOBAL).voiceId, VOICE_GLOBAL, 'sin fila se usa la global');
    assert.equal(resolveUserVoice(null, null).voiceId, null, 'sin global el cliente elige su mejor voz');
  });

  await check('resolveUserVoice dice de dónde salió la voz', () => {
    assert.equal(resolveUserVoice({ voiceId: VOICE_OVERRIDE, voiceSource: 'override' }, VOICE_GLOBAL).fromGlobal, false);
    assert.equal(resolveUserVoice({}, VOICE_GLOBAL).fromGlobal, true);
    assert.equal(resolveUserVoice({ voiceId: '   ' }, VOICE_GLOBAL).fromGlobal, true, 'una voz vacía no es una voz');
  });

  await check('canAssignVoice: una voz de comando no pisa el override del streamer', () => {
    assert.equal(canAssignVoice('override', VOICE_SOURCES.command), false);
    assert.equal(canAssignVoice('command', VOICE_SOURCES.command), true);
    assert.equal(canAssignVoice(null, VOICE_SOURCES.command), true);
    assert.equal(canAssignVoice('override', VOICE_SOURCES.override), true, 'el streamer siempre puede');
    assert.equal(canAssignVoice('override', null), true, 'y también puede quitarla');
  });

  section('pipeline: un usuario en cada estado de la prioridad');

  // Los tres usuarios nacen como nacen de verdad: por un mensaje que pasa por el
  // relay, así que su pitch es el aleatorio del primer mensaje.
  const hubFrames = [];
  const fakeHub = { broadcast: (type, payload) => hubFrames.push({ type, payload }) };
  const provider = createFakeProvider();
  const seenByHandlers = [];

  relay = createChatRelay({
    hub: fakeHub,
    provider,
    repositories,
    tts: pipeline,
    sessionPollMs: 60_000,
    isSessionReady: () => true,
  });
  relay.onMessage((message) => seenByHandlers.push(message));
  relay.start();

  const say = async (userId, username, text = 'hola') => {
    const message = makeMessage({ userId, username, displayName: username, text });
    provider.emit('message', message);
    await waitFor(`el mensaje ${message.id} procesado`, () => seenByHandlers.some((seen) => seen.id === message.id));
    return { message, frame: hubFrames.find((item) => item.payload.id === message.id) ?? null };
  };

  await say('201', 'conoverride');
  await say('202', 'concomando');
  await say('203', 'conglobal');

  repos.users.updatePreferences('201', { voiceId: VOICE_OVERRIDE, voiceSource: VOICE_SOURCES.override });
  repos.users.updatePreferences('202', { voiceId: VOICE_COMMAND, voiceSource: VOICE_SOURCES.command });

  await check('la voz global sembrada es la del plan', () => {
    assert.equal(repos.settings.getGlobalVoiceId(), VOICE_GLOBAL);
  });

  await check('cada usuario se lee con la voz de su nivel', () => {
    assert.equal(decidedVoice('201'), VOICE_OVERRIDE, 'nivel 1: override del streamer');
    assert.equal(decidedVoice('202'), VOICE_COMMAND, 'nivel 2: voz de comando');
    assert.equal(decidedVoice('203'), VOICE_GLOBAL, 'nivel 3: voz global');
  });

  await check('y con su propio pitch, distinto del de los demás', () => {
    const pitches = ['201', '202', '203'].map((id) => pipeline.decide(makeMessage({ userId: id })).tts.pitch);
    for (const pitch of pitches) {
      assert.ok(isRandomPitchInRange(pitch), `pitch fuera de rango: ${pitch}`);
    }
    assert.ok(new Set(pitches).size >= 2, `los tres pitch salieron iguales (${pitches.join(', ')})`);
  });

  section('cambiar la voz global afecta solo al nivel 3');

  const pitchesAntes = ['201', '202', '203'].map((id) => repos.users.get(id).pitch);

  await check('cambiar global_voice_id solo cambia la voz de quien no tiene voz propia', () => {
    repos.settings.set(SETTING_KEYS.globalVoiceId, VOICE_GLOBAL_NUEVA);

    assert.equal(decidedVoice('201'), VOICE_OVERRIDE, 'el override no se toca');
    assert.equal(decidedVoice('202'), VOICE_COMMAND, 'la voz de comando no se toca');
    assert.equal(decidedVoice('203'), VOICE_GLOBAL_NUEVA, 'el nivel 3 sí cambia');
  });

  await check('el pitch individual de todos se conserva al cambiar la global', () => {
    const pitchesDespues = ['201', '202', '203'].map((id) => repos.users.get(id).pitch);
    assert.deepEqual(pitchesDespues, pitchesAntes);
  });

  await check('las filas de los niveles 1 y 2 quedan intactas', () => {
    const override = repos.users.get('201');
    const command = repos.users.get('202');
    assert.equal(override.voiceId, VOICE_OVERRIDE);
    assert.equal(override.voiceSource, 'override');
    assert.equal(command.voiceId, VOICE_COMMAND);
    assert.equal(command.voiceSource, 'command');
  });

  await check('y no hace falta reiniciar: el cambio se ve en el mensaje siguiente', async () => {
    const { frame } = await say('203', 'conglobal', 'segundo mensaje');
    assert.equal(frame.payload.tts.voiceId, VOICE_GLOBAL_NUEVA);
  });

  // Se vuelve a dejar la global del plan para el resto de las comprobaciones.
  repos.settings.set(SETTING_KEYS.globalVoiceId, VOICE_GLOBAL);

  section('pitch aleatorio en el primer mensaje y entre reinicios');

  await check('el primer mensaje de un usuario nuevo le fija un pitch del rango', async () => {
    const before = repos.users.get('300');
    assert.equal(before, null, 'no debía existir todavía');
    await say('300', 'primeriza');
    const user = repos.users.get('300');
    assert.ok(user !== null, 'el primer mensaje debe crear su fila');
    assert.ok(isRandomPitchInRange(user.pitch), `pitch fuera de rango: ${user.pitch}`);
  });

  await check('los mensajes siguientes NO cambian su pitch', async () => {
    const asignado = repos.users.get('300').pitch;
    await say('300', 'primeriza', 'segundo');
    await say('300', 'primeriza', 'tercero');
    const user = repos.users.get('300');
    assert.equal(user.pitch, asignado);
    assert.ok(user.lastActiveAt > 0, 'la actividad sí se refresca');
  });

  await check('usuarios distintos reciben tonos distintos', async () => {
    const ids = ['301', '302', '303', '304', '305', '306', '307', '308'];
    for (const id of ids) {
      await say(id, `user${id}`);
    }
    const pitches = ids.map((id) => repos.users.get(id).pitch);
    for (const pitch of pitches) {
      assert.ok(isRandomPitchInRange(pitch), `pitch fuera de rango: ${pitch}`);
    }
    assert.ok(new Set(pitches).size > 1, `los ${ids.length} usuarios recibieron el mismo pitch`);
  });

  await check('el pitch sobrevive a un reinicio del backend (mismo archivo SQLite)', async () => {
    const antes = repos.users.get('300').pitch;

    // "Reinicio": se cierra el archivo y se vuelve a abrir con repositorios y
    // pipeline nuevos, como haría un arranque desde cero.
    relay.stop();
    db.close();
    db = openDatabase(dbFile);
    repos = createRepositories(db);

    const despues = repos.users.get('300');
    assert.equal(despues.pitch, antes, 'el pitch se perdió al reabrir la base');
    assert.ok(isRandomPitchInRange(despues.pitch));

    // Y sigue estable cuando el usuario vuelve a escribir tras el reinicio.
    relay = createChatRelay({
      hub: fakeHub,
      provider,
      repositories,
      tts: createTtsPipeline({ registry, repositories }),
      sessionPollMs: 60_000,
      isSessionReady: () => true,
    });
    relay.onMessage((message) => seenByHandlers.push(message));
    relay.start();

    const { frame } = await say('300', 'primeriza', 'después del reinicio');
    assert.equal(frame.payload.tts.pitch, antes, 'el mensaje posterior al reinicio debe llevar el mismo pitch');
    assert.equal(repos.users.get('300').pitch, antes);
  });

  section('panel del usuario: PATCH /api/users/:userId/preferences');

  // El pipeline y el relay con los que se comprueba "aplica al siguiente mensaje"
  // se construyeron **antes** de estas escrituras: nada se reinicia en el medio.
  const panelPipeline = createTtsPipeline({ registry, repositories });
  const app = express();
  app.use(express.json());
  app.use('/api/users', createUsersRouter({ repositories }));
  httpServer = app.listen(0);
  await once(httpServer, 'listening');
  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;

  const patch = async (userId, body) => {
    const response = await fetch(`${baseUrl}/api/users/${userId}/preferences`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  await say('400', 'panelista');

  await check('la respuesta trae la fila con las claves de la trama users:list', async () => {
    const { status, body } = await patch('400', { muted: true });
    assert.equal(status, 200);
    assert.deepEqual(
      Object.keys(body.user).sort(),
      ['displayName', 'firstSeenAt', 'ignored', 'lastActiveAt', 'muted', 'pitch', 'timbre', 'userId', 'username', 'voiceId', 'voiceSource', 'volume'].sort(),
    );
    assert.equal(body.user.userId, '400');
    assert.equal(body.user.muted, true);
  });

  await check('mutear persiste en SQLite y el siguiente mensaje se muestra sin voz', async () => {
    assert.equal(repos.users.get('400').muted, true);
    const decision = panelPipeline.decide(makeMessage({ userId: '400', username: 'panelista' }));
    assert.equal(decision.visible, true, 'un muteado sí se muestra');
    assert.equal(decision.tts, null);
    assert.equal(decision.reason, TTS_SKIP_REASONS.muted);
  });

  await check('desmutear vuelve a leerlo, sin reiniciar', async () => {
    await patch('400', { muted: false });
    const decision = panelPipeline.decide(makeMessage({ userId: '400', username: 'panelista' }));
    assert.notEqual(decision.tts, null);
    assert.equal(decision.reason, null);
  });

  await check('el volumen del panel llega a la instrucción del siguiente mensaje', async () => {
    const { body } = await patch('400', { volume: 0.25 });
    assert.equal(body.user.volume, 0.25);
    assert.equal(repos.users.get('400').volume, 0.25);
    assert.equal(panelPipeline.decide(makeMessage({ userId: '400' })).tts.volume, 0.25);
  });

  await check('el pitch del panel llega a la instrucción del siguiente mensaje', async () => {
    const { body } = await patch('400', { pitch: 1.35 });
    assert.equal(body.user.pitch, 1.35);
    assert.equal(panelPipeline.decide(makeMessage({ userId: '400' })).tts.pitch, 1.35);
  });

  await check('el ruido de coma flotante del slider no llega a SQLite', async () => {
    // 1 - 0.05 * 2 en coma flotante es 0.8999999999999999.
    const { body } = await patch('400', { volume: 1 - 0.05 * 2 });
    assert.equal(body.user.volume, 0.9);
    assert.equal(repos.users.get('400').volume, 0.9);
  });

  await check('rerollPitch rueda un tono nuevo dentro del rango del modelo', async () => {
    const { body } = await patch('400', { rerollPitch: true });
    assert.ok(isRandomPitchInRange(body.user.pitch), `pitch fuera de rango: ${body.user.pitch}`);
    assert.equal(repos.users.get('400').pitch, body.user.pitch);
  });

  await check('asignar voz desde el panel marca voice_source = override', async () => {
    const { body } = await patch('400', { voiceId: VOICE_OVERRIDE });
    assert.equal(body.user.voiceId, VOICE_OVERRIDE);
    assert.equal(body.user.voiceSource, 'override');
    assert.equal(panelPipeline.decide(makeMessage({ userId: '400' })).tts.voiceId, VOICE_OVERRIDE);
  });

  await check('y NO cambia la voz global', () => {
    assert.equal(repos.settings.getGlobalVoiceId(), VOICE_GLOBAL);
    assert.equal(decidedVoice('203'), VOICE_GLOBAL, 'el usuario de nivel 3 sigue con la global');
  });

  await check('quitar la voz (voiceId: null) devuelve al usuario a la voz global', async () => {
    const { body } = await patch('400', { voiceId: null });
    assert.equal(body.user.voiceId, null);
    assert.equal(body.user.voiceSource, null);
    assert.equal(panelPipeline.decide(makeMessage({ userId: '400' })).tts.voiceId, VOICE_GLOBAL);
  });

  await check('ignorar oculta el mensaje siguiente pero el backend lo sigue viendo (T-012)', async () => {
    await patch('400', { ignored: true });
    const decision = panelPipeline.decide(makeMessage({ userId: '400' }));
    assert.equal(decision.visible, false);
    assert.equal(decision.tts, null);
    assert.equal(decision.reason, TTS_SKIP_REASONS.ignored);

    const antes = seenByHandlers.length;
    await say('400', 'panelista', 'sigo aquí');
    assert.equal(seenByHandlers.length, antes + 1, 'relay.onMessage debe seguir entregándolo');
    await patch('400', { ignored: false });
  });

  await check('un presente que nunca escribió recibe fila, pitch y preferencia sin quedar "activo"', async () => {
    assert.equal(repos.users.get('500'), null);
    const { status, body } = await patch('500', { muted: true, username: 'lurker', displayName: 'Lurker' });
    assert.equal(status, 200);
    assert.equal(body.user.username, 'lurker');
    assert.equal(body.user.muted, true);
    assert.ok(isRandomPitchInRange(body.user.pitch), `pitch fuera de rango: ${body.user.pitch}`);
    assert.equal(body.user.lastActiveAt, 0, 'no se le puede inventar actividad');
    assert.ok(body.user.firstSeenAt > 0);
  });

  await check('users.ensure() no pisa nada ni sube last_active_at de quien ya existía', () => {
    const antes = repos.users.get('400');
    const despues = repos.users.ensure({ twitchUserId: '400', username: 'otro-nombre', displayName: 'Otro', pitch: 0.9 });
    assert.deepEqual(despues, antes);
  });

  await check('el patch rechaza lo que no puede guardar (400 con código)', async () => {
    const casos = [
      [{ desconocida: 1 }, 'unknown_key'],
      [{ pitch: null }, 'invalid'],
      [{ pitch: 5 }, 'out_of_range'],
      [{ volume: -1 }, 'out_of_range'],
      [{ muted: 'sí' }, 'invalid'],
      [{}, 'empty'],
      [{ pitch: 1, rerollPitch: true }, 'invalid'],
      [{ rerollPitch: false }, 'invalid'],
      [{ voiceId: 7 }, 'invalid'],
    ];

    for (const [body, code] of casos) {
      const response = await patch('400', body);
      assert.equal(response.status, 400, `${JSON.stringify(body)} debía ser 400`);
      assert.equal(response.body.code, code, `${JSON.stringify(body)} → ${response.body.code}`);
      assert.ok(response.body.error.length > 0, 'el aviso debe traer texto para mostrar');
    }
  });

  await check('un id de usuario imposible no crea nada', async () => {
    const response = await patch('no%20valido!', { muted: true });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'invalid_user');
  });

  await check('parsePreferencesPatch acepta un patch parcial y deriva el origen de la voz', () => {
    assert.deepEqual(parsePreferencesPatch({ muted: true }).patch, { muted: true });
    assert.deepEqual(parsePreferencesPatch({ voiceId: VOICE_OVERRIDE }).patch, {
      voiceId: VOICE_OVERRIDE,
      voiceSource: VOICE_SOURCES.override,
    });
    assert.deepEqual(parsePreferencesPatch({ voiceId: null }).patch, { voiceId: null, voiceSource: null });
    assert.equal(parsePreferencesPatch({ rerollPitch: true }).rerollPitch, true);
  });

  await check('el cliente NO puede declararse a sí mismo una voz de comando', async () => {
    const response = await patch('400', { voiceId: VOICE_COMMAND, voiceSource: 'command' });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'unknown_key', 'voiceSource no es una clave que acepte la API');
    assert.equal(repos.users.get('400').voiceId, null, 'y no escribió nada');
  });

  section('assignUserVoice: el enganche que escribirá T-012');

  await check('una voz de comando NO pisa el override del streamer', () => {
    const result = assignUserVoice(repos.users, '201', { voiceId: VOICE_COMMAND, source: VOICE_SOURCES.command });
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'override_wins');
    assert.equal(repos.users.get('201').voiceId, VOICE_OVERRIDE);
    assert.equal(decidedVoice('201'), VOICE_OVERRIDE);
  });

  await check('sobre un usuario sin voz sí escribe, con voice_source = command', () => {
    const result = assignUserVoice(repos.users, '203', { voiceId: VOICE_COMMAND, source: VOICE_SOURCES.command });
    assert.equal(result.applied, true);
    assert.equal(result.user.voiceSource, 'command');
    assert.equal(decidedVoice('203'), VOICE_COMMAND, 'y el pipeline la usa desde el mensaje siguiente');
  });

  await check('y puede volver a rodar sobre su propia voz de comando', () => {
    const result = assignUserVoice(repos.users, '203', { voiceId: VOICE_GLOBAL, source: VOICE_SOURCES.command });
    assert.equal(result.applied, true);
    assert.equal(repos.users.get('203').voiceId, VOICE_GLOBAL);
    assert.equal(repos.users.get('203').voiceSource, 'command');
  });

  await check('el override del panel sí pisa una voz de comando', async () => {
    const { body } = await patch('203', { voiceId: VOICE_OVERRIDE });
    assert.equal(body.user.voiceSource, 'override');
    assert.equal(decidedVoice('203'), VOICE_OVERRIDE);
  });

  await check('sin fila no se puede asignar voz (hay que crearla antes)', () => {
    const result = assignUserVoice(repos.users, '999999', { voiceId: VOICE_COMMAND, source: VOICE_SOURCES.command });
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'unknown_user');
    assert.equal(result.user, null);
  });

  await check('el pitch de todos sigue en el rango del modelo al final de la corrida', () => {
    for (const user of repos.users.list()) {
      if (user.twitchUserId === '400') {
        continue; // a este el panel le fijó el pitch a mano a propósito.
      }
      assert.ok(isRandomPitchInRange(user.pitch), `${user.username} quedó con pitch ${user.pitch}`);
    }
  });
} finally {
  relay?.stop();
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
