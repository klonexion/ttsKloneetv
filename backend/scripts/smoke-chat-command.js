/**
 * Pruebas de humo del comando de chat `!cambia-mi-voz` (T-012):
 *
 *   npm --prefix backend run test:chat-command
 *
 * Cubre los cuatro criterios de la tarea:
 *
 * 1. Quien escribe `!cambia-mi-voz` recibe una voz **aleatoria en español del
 *    catálogo completo** (todos los motores registrados), **distinta de la que
 *    tenía**, persistida con `voice_source = 'command'` y aplicada desde su
 *    **siguiente** mensaje.
 * 2. Repetir el comando vuelve a rodar la voz **sin cooldown** (ocho veces
 *    seguidas, todas aplicadas).
 * 3. Con un `override` del streamer el comando **no cambia nada**.
 * 4. El mensaje del comando **se ve en el chat y no se lee** (lo salta el filtro
 *    de T-008; aquí se comprueba, no se reimplementa).
 *
 * Hermético: base SQLite temporal en el tmpdir del SO, hub y provider de chat
 * falsos y un registro de motores de juguete. No necesita `.env`, ni red, ni
 * puertos, y no toca `backend/data/app.sqlite`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  COMMAND_OUTCOMES,
  VOICE_ROLL_COMMAND,
  createChatCommands,
  isSpanishVoice,
  parseChatCommand,
  pickRandomSpanishVoice,
} from '../src/chat/commands.js';
import { CHAT_PROVIDER_STATUS } from '../src/chat/provider.js';
import { createChatRelay } from '../src/chat/relay.js';
import { createRepositories, openDatabase } from '../src/db/index.js';
import { TTS_ENGINE_KINDS, TTS_ENGINE_NAMES, TTS_SKIP_REASONS, isCommand } from '../src/tts/index.js';
import { createTtsPipeline } from '../src/tts/pipeline.js';
import { createTtsEngineRegistry } from '../src/tts/registry.js';
import { VOICE_SOURCES, isRandomPitchInRange } from '../src/tts/voice-model.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-hub-command-'));
const dbFile = path.join(tempDir, 'smoke.sqlite');

/** Voz global sembrada por T-002 (la del plan). */
const VOICE_GLOBAL = 'edge:es-MX-DaliaNeural';
const VOICE_OVERRIDE = 'edge:es-ES-AlvaroNeural';

/** Voz en inglés: está en el catálogo y el sorteo no debe elegirla nunca. */
const VOICE_INGLES = 'edge:en-US-AriaNeural';

const makeVoice = (id, engine, language) => ({
  id,
  name: id.split(':')[1],
  engine,
  language,
  label: `${id} (${language})`,
});

/** Catálogo de juguete: dos motores con voces en español y una en inglés. */
const EDGE_VOICES = [
  makeVoice(VOICE_GLOBAL, TTS_ENGINE_NAMES.edge, 'es-MX'),
  makeVoice(VOICE_OVERRIDE, TTS_ENGINE_NAMES.edge, 'es-ES'),
  makeVoice('edge:es-AR-ElenaNeural', TTS_ENGINE_NAMES.edge, 'es-AR'),
  makeVoice('edge:es-CO-SalomeNeural', TTS_ENGINE_NAMES.edge, 'es-CO'),
  makeVoice('edge:es-BO-MarceloNeural', TTS_ENGINE_NAMES.edge, 'es-BO'),
  makeVoice(VOICE_INGLES, TTS_ENGINE_NAMES.edge, 'en-US'),
];

const PIPER_VOICES = [
  makeVoice('piper:es_ES-davefx-medium', TTS_ENGINE_NAMES.piper, 'es-ES'),
  makeVoice('piper:es_MX-claude-high', TTS_ENGINE_NAMES.piper, 'es-MX'),
];

const SPANISH_IDS = [...EDGE_VOICES, ...PIPER_VOICES].filter(isSpanishVoice).map((voice) => voice.id);

const createFakeEngine = (name, voices) => ({
  name,
  kind: TTS_ENGINE_KINDS.server,
  isAvailable: async () => true,
  listVoices: async () => voices,
  synthesize: async () => ({ format: 'mp3', base64: 'ZmFrZQ==' }),
});

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

let db = openDatabase(dbFile);
let repos = createRepositories(db);
const repositories = () => repos;

const registry = createTtsEngineRegistry();
registry.register(createFakeEngine(TTS_ENGINE_NAMES.edge, EDGE_VOICES));
registry.register(createFakeEngine(TTS_ENGINE_NAMES.piper, PIPER_VOICES));

/** Envoltorio que cuenta cuántas veces se pide el catálogo (para el espía). */
let catalogCalls = 0;
const countingRegistry = {
  ...registry,
  listVoices: async () => {
    catalogCalls += 1;
    return registry.listVoices();
  },
};

const pipeline = createTtsPipeline({ registry, repositories });
const commands = createChatCommands({ repositories, registry: countingRegistry });

const hubFrames = [];
const fakeHub = { broadcast: (type, payload) => hubFrames.push({ type, payload }) };
const provider = createFakeProvider();
const seenByHandlers = [];

let relay = null;

/** Emite un mensaje por el provider y espera a que el relay lo haya procesado. */
const say = async (userId, username, text = 'hola') => {
  const message = makeMessage({ userId, username, displayName: username, text });
  provider.emit('message', message);
  await waitFor(`el mensaje ${message.id} procesado`, () => seenByHandlers.some((seen) => seen.id === message.id));
  return { message, frame: hubFrames.find((item) => item.payload.id === message.id) ?? null };
};

/** Escribe el comando en el chat y espera a que la voz del usuario cambie. */
const rollVoiceInChat = async (userId, username) => {
  const before = repos.users.get(userId)?.voiceId ?? null;
  await say(userId, username, VOICE_ROLL_COMMAND);
  return waitFor(
    `la voz nueva de ${username}`,
    () => {
      const voiceId = repos.users.get(userId)?.voiceId ?? null;
      return voiceId !== null && voiceId !== before ? voiceId : null;
    },
  );
};

/** La voz que el pipeline pediría para un usuario, resolviendo la prioridad. */
const decidedVoice = (userId) => pipeline.decide(makeMessage({ userId })).tts?.voiceId ?? null;

try {
  section('parseo del comando');

  await check(`el nombre del comando es exactamente ${VOICE_ROLL_COMMAND}`, () => {
    assert.equal(VOICE_ROLL_COMMAND, '!cambia-mi-voz');
    assert.deepEqual(commands.names(), [VOICE_ROLL_COMMAND]);
  });

  await check('lo reconoce con mayúsculas, espacios de más y argumentos detrás', () => {
    for (const text of [
      '!cambia-mi-voz',
      '  !cambia-mi-voz  ',
      '!CAMBIA-MI-VOZ',
      '!Cambia-Mi-Voz',
      '!cambia-mi-voz por favor',
      '!cambia-mi-voz\n',
    ]) {
      assert.equal(parseChatCommand(text), VOICE_ROLL_COMMAND, `no reconoció ${JSON.stringify(text)}`);
    }
  });

  await check('no confunde otros textos con el comando', () => {
    for (const text of [
      'cambia-mi-voz',
      '!cambia-mi-vozz',
      '!cambiamivoz',
      'hola !cambia-mi-voz',
      '!otro-comando',
      '!',
      '',
      null,
      undefined,
      42,
    ]) {
      assert.notEqual(parseChatCommand(text), VOICE_ROLL_COMMAND, `confundió ${JSON.stringify(text)}`);
    }
  });

  await check('el comando empieza por el prefijo que ya salta el filtro TTS de T-008', () => {
    assert.equal(isCommand(VOICE_ROLL_COMMAND), true);
  });

  section('sorteo sobre el catálogo completo (sin listas escritas a mano)');

  const catalogo = [...EDGE_VOICES, ...PIPER_VOICES];

  await check('nunca elige una voz que no esté en español', () => {
    for (let i = 0; i < 300; i += 1) {
      const voice = pickRandomSpanishVoice(catalogo, null);
      assert.ok(SPANISH_IDS.includes(voice.id), `eligió ${voice.id}, que no está en el catálogo en español`);
      assert.notEqual(voice.id, VOICE_INGLES);
    }
  });

  await check('nunca elige la voz que el usuario ya tiene', () => {
    for (const current of SPANISH_IDS) {
      for (let i = 0; i < 60; i += 1) {
        assert.notEqual(pickRandomSpanishVoice(catalogo, current).id, current);
      }
    }
  });

  await check('sortea entre los motores del registro, no solo entre los de uno', () => {
    const engines = new Set();
    for (let i = 0; i < 300; i += 1) {
      engines.add(pickRandomSpanishVoice(catalogo, null).engine);
    }
    assert.deepEqual([...engines].sort(), [TTS_ENGINE_NAMES.edge, TTS_ENGINE_NAMES.piper]);
  });

  await check('reparte: en 300 tiradas salen todas las voces posibles', () => {
    const seen = new Set();
    for (let i = 0; i < 300; i += 1) {
      seen.add(pickRandomSpanishVoice(catalogo, VOICE_GLOBAL).id);
    }
    const esperadas = SPANISH_IDS.filter((id) => id !== VOICE_GLOBAL).sort();
    assert.deepEqual([...seen].sort(), esperadas);
  });

  await check('el catálogo manda: con voces inventadas sortea entre esas', () => {
    const inventadas = [makeVoice('otro:voz-a', 'otro', 'es-419'), makeVoice('otro:voz-b', 'otro', 'es')];
    const elegidas = new Set();
    for (let i = 0; i < 60; i += 1) {
      elegidas.add(pickRandomSpanishVoice(inventadas, null).id);
    }
    assert.deepEqual([...elegidas].sort(), ['otro:voz-a', 'otro:voz-b']);
  });

  await check('sin alternativa devuelve null (una sola voz, y es la actual)', () => {
    const una = [makeVoice('edge:es-MX-DaliaNeural', TTS_ENGINE_NAMES.edge, 'es-MX')];
    assert.equal(pickRandomSpanishVoice(una, VOICE_GLOBAL), null);
    assert.notEqual(pickRandomSpanishVoice(una, null), null, 'sin voz actual sí se puede elegir');
  });

  await check('un catálogo vacío, roto o sin español no rompe el sorteo', () => {
    assert.equal(pickRandomSpanishVoice([], null), null);
    assert.equal(pickRandomSpanishVoice(null, null), null);
    assert.equal(pickRandomSpanishVoice([{ id: '  ' }, { language: 'es' }], null), null);
    assert.equal(pickRandomSpanishVoice([makeVoice(VOICE_INGLES, 'edge', 'en-US')], null), null);
  });

  await check('los extremos del generador aleatorio caen dentro del catálogo', () => {
    assert.equal(pickRandomSpanishVoice(catalogo, null, () => 0).id, SPANISH_IDS[0]);
    assert.equal(pickRandomSpanishVoice(catalogo, null, () => 0.999999999).id, SPANISH_IDS.at(-1));
    assert.equal(pickRandomSpanishVoice(catalogo, null, () => 1).id, SPANISH_IDS.at(-1), 'un 1 no se sale del array');
  });

  section('el comando en el chat, por el relay');

  relay = createChatRelay({
    hub: fakeHub,
    provider,
    repositories,
    tts: pipeline,
    commands,
    sessionPollMs: 60_000,
    isSessionReady: () => true,
  });
  relay.onMessage((message) => seenByHandlers.push(message));
  relay.start();

  await check('la voz global sembrada es la del plan y el usuario nuevo la usa', async () => {
    assert.equal(repos.settings.getGlobalVoiceId(), VOICE_GLOBAL);
    const { frame } = await say('201', 'chelo');
    assert.equal(frame.payload.tts.voiceId, VOICE_GLOBAL);
    assert.equal(repos.users.get('201').voiceId, null, 'todavía no tiene voz propia');
  });

  await check('el mensaje del comando aparece en el chat y NO se lee', async () => {
    const { frame } = await say('201', 'chelo', VOICE_ROLL_COMMAND);
    assert.ok(frame !== null, 'el comando debe publicarse en el chat');
    assert.equal(frame.payload.text, VOICE_ROLL_COMMAND, 'se ve tal cual lo escribió');
    assert.equal(frame.payload.tts, null, 'y no se lee');
    assert.equal(pipeline.decide(makeMessage({ userId: '201', text: VOICE_ROLL_COMMAND })).reason, TTS_SKIP_REASONS.command);
  });

  await check('el comando le asigna una voz en español distinta de la que tenía', async () => {
    const voiceId = await waitFor('la voz de chelo', () => repos.users.get('201').voiceId);
    assert.ok(SPANISH_IDS.includes(voiceId), `${voiceId} no está en el catálogo en español`);
    assert.notEqual(voiceId, VOICE_GLOBAL, 'debe ser distinta de la que se le oía');
    assert.notEqual(voiceId, VOICE_INGLES);
  });

  await check('y queda persistida con voice_source = command', () => {
    assert.equal(repos.users.get('201').voiceSource, VOICE_SOURCES.command);
  });

  await check('la voz nueva aplica desde el SIGUIENTE mensaje del usuario', async () => {
    const asignada = repos.users.get('201').voiceId;
    const { frame } = await say('201', 'chelo', 'ahora me oigo distinto');
    assert.equal(frame.payload.tts.voiceId, asignada);
    assert.equal(decidedVoice('201'), asignada);
  });

  await check('el comando no toca el pitch, el volumen ni los flags del usuario', async () => {
    const antes = repos.users.get('201');
    await rollVoiceInChat('201', 'chelo');
    const despues = repos.users.get('201');
    assert.equal(despues.pitch, antes.pitch);
    assert.equal(despues.volume, antes.volume);
    assert.equal(despues.muted, antes.muted);
    assert.equal(despues.ignored, antes.ignored);
    assert.ok(isRandomPitchInRange(despues.pitch), `pitch fuera de rango: ${despues.pitch}`);
  });

  await check('repetir el comando vuelve a rodar la voz SIN cooldown (ocho veces seguidas)', async () => {
    const rodadas = [];
    for (let i = 0; i < 8; i += 1) {
      const anterior = repos.users.get('201').voiceId;
      const nueva = await rollVoiceInChat('201', 'chelo');
      assert.notEqual(nueva, anterior, `la tirada ${i + 1} no cambió la voz`);
      assert.ok(SPANISH_IDS.includes(nueva), `${nueva} no está en el catálogo en español`);
      rodadas.push(nueva);
    }
    assert.ok(new Set(rodadas).size > 1, `las ocho tiradas dieron la misma voz (${rodadas[0]})`);
    assert.equal(repos.users.get('201').voiceSource, VOICE_SOURCES.command);
  });

  await check('el relay cuenta los comandos aplicados', () => {
    assert.ok(relay.getStatus().commandsApplied >= 9, `solo contó ${relay.getStatus().commandsApplied}`);
  });

  await check('un mensaje normal no es un comando: no pide el catálogo ni escribe nada', async () => {
    const llamadasAntes = catalogCalls;
    const voiceAntes = repos.users.get('201').voiceId;
    await say('201', 'chelo', 'esto no es un comando, aunque hable de !cambia-mi-voz');
    await say('202', 'otra', 'hola a todos');
    assert.equal(catalogCalls, llamadasAntes, 'no debía consultarse el catálogo');
    assert.equal(repos.users.get('201').voiceId, voiceAntes);
    assert.equal(repos.users.get('202').voiceId, null);
  });

  section('el override del streamer gana');

  await check('con override, el comando NO cambia la voz', async () => {
    repos.users.updatePreferences('202', { voiceId: VOICE_OVERRIDE, voiceSource: VOICE_SOURCES.override });
    const llamadasAntes = catalogCalls;

    const { frame } = await say('202', 'otra', VOICE_ROLL_COMMAND);
    assert.ok(frame !== null, 'el mensaje del comando sí se ve');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const user = repos.users.get('202');
    assert.equal(user.voiceId, VOICE_OVERRIDE, 'el override se mantiene');
    assert.equal(user.voiceSource, VOICE_SOURCES.override);
    assert.equal(decidedVoice('202'), VOICE_OVERRIDE, 'y el pipeline sigue leyéndola con esa voz');
    assert.equal(catalogCalls, llamadasAntes, 'ni siquiera hace falta pedir el catálogo');
  });

  await check('handle() lo dice explícitamente: override_wins', async () => {
    const result = await commands.handle(makeMessage({ userId: '202', username: 'otra', text: VOICE_ROLL_COMMAND }));
    assert.equal(result.matched, true);
    assert.equal(result.applied, false);
    assert.equal(result.outcome, COMMAND_OUTCOMES.overrideWins);
  });

  await check('si el streamer le quita la voz, el comando vuelve a funcionar', async () => {
    repos.users.updatePreferences('202', { voiceId: null, voiceSource: null });
    const nueva = await rollVoiceInChat('202', 'otra');
    assert.ok(SPANISH_IDS.includes(nueva));
    assert.equal(repos.users.get('202').voiceSource, VOICE_SOURCES.command);
  });

  section('casos de borde del usuario');

  await check('si el PRIMER mensaje de alguien es el comando, también se le asigna voz', async () => {
    assert.equal(repos.users.get('203'), null, 'no debía existir todavía');
    const nueva = await rollVoiceInChat('203', 'primeriza');
    const user = repos.users.get('203');
    assert.equal(user.voiceId, nueva);
    assert.equal(user.voiceSource, VOICE_SOURCES.command);
    assert.ok(isRandomPitchInRange(user.pitch), `pitch fuera de rango: ${user.pitch}`);
  });

  await check('handle() crea la fila con pitch del modelo si el usuario no existe', async () => {
    const result = await commands.handle(makeMessage({ userId: '204', username: 'lurker', text: VOICE_ROLL_COMMAND }));
    assert.equal(result.applied, true);
    const user = repos.users.get('204');
    assert.equal(user.username, 'lurker');
    assert.equal(user.voiceSource, VOICE_SOURCES.command);
    assert.ok(isRandomPitchInRange(user.pitch), `pitch fuera de rango: ${user.pitch}`);
    assert.equal(user.lastActiveAt, 0, 'ensure() no le inventa actividad');
  });

  await check('un usuario muted puede usar el comando (se ve, no se lee)', async () => {
    repos.users.updatePreferences('203', { muted: true });
    const anterior = repos.users.get('203').voiceId;
    const { frame } = await say('203', 'primeriza', VOICE_ROLL_COMMAND);
    assert.ok(frame !== null, 'un muteado sí se muestra');
    assert.equal(frame.payload.tts, null);
    const nueva = await waitFor(
      'la voz nueva de la muteada',
      () => {
        const voiceId = repos.users.get('203').voiceId;
        return voiceId !== anterior ? voiceId : null;
      },
    );
    assert.ok(SPANISH_IDS.includes(nueva));
    repos.users.updatePreferences('203', { muted: false });
  });

  await check('un usuario ignored también: el relay sigue entregando su mensaje', async () => {
    repos.users.updatePreferences('203', { ignored: true });
    const anterior = repos.users.get('203').voiceId;
    const { frame } = await say('203', 'primeriza', VOICE_ROLL_COMMAND);
    assert.equal(frame, null, 'un ignorado no se publica en el chat');
    const nueva = await waitFor(
      'la voz nueva de la ignorada',
      () => {
        const voiceId = repos.users.get('203').voiceId;
        return voiceId !== anterior ? voiceId : null;
      },
    );
    assert.ok(SPANISH_IDS.includes(nueva));
    repos.users.updatePreferences('203', { ignored: false });
  });

  await check('una ráfaga de comandos del mismo usuario deja una voz válida del catálogo', async () => {
    for (let i = 0; i < 5; i += 1) {
      provider.emit('message', makeMessage({ userId: '205', username: 'insistente', text: VOICE_ROLL_COMMAND }));
    }
    const voiceId = await waitFor('la voz de insistente', () => repos.users.get('205')?.voiceId ?? null);
    assert.ok(SPANISH_IDS.includes(voiceId), `${voiceId} no está en el catálogo`);
    assert.equal(repos.users.get('205').voiceSource, VOICE_SOURCES.command);
  });

  section('la voz sobrevive a un reinicio');

  await check('la voz rodada sigue ahí tras cerrar y reabrir el archivo SQLite', async () => {
    const antes = repos.users.get('201').voiceId;
    relay.stop();
    db.close();

    db = openDatabase(dbFile);
    repos = createRepositories(db);

    const user = repos.users.get('201');
    assert.equal(user.voiceId, antes, 'la voz se perdió al reabrir la base');
    assert.equal(user.voiceSource, VOICE_SOURCES.command);

    relay = createChatRelay({
      hub: fakeHub,
      provider,
      repositories,
      tts: createTtsPipeline({ registry, repositories }),
      commands,
      sessionPollMs: 60_000,
      isSessionReady: () => true,
    });
    relay.onMessage((message) => seenByHandlers.push(message));
    relay.start();

    const { frame } = await say('201', 'chelo', 'después del reinicio');
    assert.equal(frame.payload.tts.voiceId, antes, 'y se sigue leyendo con ella');
  });

  section('nunca rompe el chat');

  await check('si el catálogo falla, el comando no escribe nada y lo dice', async () => {
    const roto = createChatCommands({
      repositories,
      registry: { listVoices: async () => { throw new Error('sin red'); } },
    });
    const antes = repos.users.get('201').voiceId;
    const result = await roto.handle(makeMessage({ userId: '201', username: 'chelo', text: VOICE_ROLL_COMMAND }));
    assert.equal(result.outcome, COMMAND_OUTCOMES.failed);
    assert.equal(result.applied, false);
    assert.equal(repos.users.get('201').voiceId, antes);
  });

  await check('si el catálogo no trae ninguna voz en español, tampoco escribe', async () => {
    const sinEspanol = createChatCommands({
      repositories,
      registry: { listVoices: async () => [makeVoice(VOICE_INGLES, TTS_ENGINE_NAMES.edge, 'en-US')] },
    });
    const antes = repos.users.get('201').voiceId;
    const result = await sinEspanol.handle(makeMessage({ userId: '201', username: 'chelo', text: VOICE_ROLL_COMMAND }));
    assert.equal(result.outcome, COMMAND_OUTCOMES.noVoices);
    assert.equal(repos.users.get('201').voiceId, antes);
  });

  await check('si la base falla, handle() no lanza', async () => {
    const roto = createChatCommands({
      repositories: () => {
        throw new Error('base caída');
      },
      registry: countingRegistry,
    });
    const result = await roto.handle(makeMessage({ text: VOICE_ROLL_COMMAND }));
    assert.equal(result.outcome, COMMAND_OUTCOMES.failed);
  });

  await check('un mensaje malformado no es un comando ni lanza', async () => {
    assert.deepEqual(await commands.handle(null), { matched: false });
    assert.deepEqual(await commands.handle({}), { matched: false });
    assert.deepEqual(await commands.handle(makeMessage({ text: 'hola' })), { matched: false });
  });

  await check('el relay se puede construir sin comandos (commands: false) y sigue publicando', async () => {
    const frames = [];
    const soloChat = createChatRelay({
      hub: { broadcast: (type, payload) => frames.push({ type, payload }) },
      provider: createFakeProvider(),
      repositories,
      tts: pipeline,
      commands: false,
      sessionPollMs: 60_000,
      isSessionReady: () => true,
    });
    soloChat.start();
    const antes = repos.users.get('201').voiceId;
    soloChat.provider.emit('message', makeMessage({ userId: '201', username: 'chelo', text: VOICE_ROLL_COMMAND }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    soloChat.stop();
    assert.equal(frames.length, 1, 'el mensaje se sigue viendo en el chat');
    assert.equal(repos.users.get('201').voiceId, antes, 'pero sin comandos no se rueda ninguna voz');
  });
} finally {
  relay?.stop();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} comprobaciones ok`);
if (failures > 0) {
  console.error(`${failures} comprobación(es) fallaron`);
  process.exit(1);
}
