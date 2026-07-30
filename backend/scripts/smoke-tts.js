/**
 * Pruebas de humo del núcleo TTS (T-008): la interfaz `TTSEngine`, el registro de
 * motores, los filtros y el pipeline que resuelve los parámetros por mensaje,
 * más la integración con el relay (la trama `chat:message` enriquecida).
 *
 *   npm --prefix backend run test:tts
 *
 * Trabaja sobre una base SQLite temporal en el directorio temporal del SO y un
 * hub de WebSocket falso: no necesita `.env`, ni red, ni puertos, y no toca
 * `backend/data/app.sqlite`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CHAT_MESSAGE_FRAME_FIELDS, CHAT_MESSAGE_TYPE, createChatRelay } from '../src/chat/relay.js';
import { CHAT_PROVIDER_STATUS } from '../src/chat/provider.js';
import { DEFAULT_SETTINGS, createRepositories, openDatabase } from '../src/db/index.js';
import {
  FALLBACK_ENGINE_NAME,
  KNOWN_BOT_USERNAMES,
  TTS_ENGINE_KINDS,
  TTS_ENGINE_NAMES,
  TTS_SKIP_REASONS,
  assertTtsEngine,
  createBrowserEngine,
  createTtsEngineRegistry,
  createTtsPipeline,
  formatVoiceId,
  hasUrl,
  isCommand,
  isKnownBot,
  isVoiceId,
  parseVoiceId,
  replaceUrls,
  toSpokenText,
} from '../src/tts/index.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-hub-tts-'));
const dbFile = path.join(tempDir, 'smoke.sqlite');

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

/** Motor de servidor de juguete: sirve para probar el registro sin traer T-009. */
const createFakeServerEngine = (name = TTS_ENGINE_NAMES.edge) => ({
  name,
  kind: TTS_ENGINE_KINDS.server,
  isAvailable: async () => true,
  listVoices: async () => [
    { id: formatVoiceId(name, 'es-MX-DaliaNeural'), name: 'es-MX-DaliaNeural', engine: name, language: 'es-MX', label: 'Dalia' },
  ],
  synthesize: async () => ({ format: 'mp3', base64: 'ZmFrZQ==' }),
});

const db = openDatabase(dbFile);
const repos = createRepositories(db);
const repositories = () => repos;

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

/** Crea (o refresca) un usuario en la base y le aplica preferencias. */
const seedUser = (twitchUserId, username, preferences = {}) => {
  repos.users.upsert({ twitchUserId, username, displayName: username });
  if (Object.keys(preferences).length > 0) {
    repos.users.updatePreferences(twitchUserId, preferences);
  }
  return repos.users.get(twitchUserId);
};

try {
  section('ids de voz namespaced');

  await check('formatVoiceId compone <engine>:<name>', () => {
    assert.equal(formatVoiceId('edge', 'es-MX-DaliaNeural'), 'edge:es-MX-DaliaNeural');
    assert.equal(formatVoiceId('browser', 'Paulina'), 'browser:Paulina');
    assert.equal(formatVoiceId('piper', 'es_MX-ald-medium'), 'piper:es_MX-ald-medium');
  });

  await check('parseVoiceId parte solo en el primer ":"', () => {
    assert.deepEqual(parseVoiceId('edge:es-MX-DaliaNeural'), { engine: 'edge', name: 'es-MX-DaliaNeural' });
    assert.deepEqual(parseVoiceId('browser:Microsoft Sabina Desktop - Spanish (Mexico)'), {
      engine: 'browser',
      name: 'Microsoft Sabina Desktop - Spanish (Mexico)',
    });
    assert.deepEqual(parseVoiceId('piper:es_ES-davefx:medium'), { engine: 'piper', name: 'es_ES-davefx:medium' });
  });

  await check('parseVoiceId rechaza lo que no tiene namespace', () => {
    for (const bad of ['', 'Paulina', ':Paulina', 'edge:', null, undefined, 42, {}]) {
      assert.equal(parseVoiceId(bad), null, `debía rechazar ${JSON.stringify(bad)}`);
      assert.equal(isVoiceId(bad), false);
    }
    assert.equal(isVoiceId('edge:x'), true);
  });

  await check('la voz global sembrada por T-002 es un id namespaced de edge', () => {
    assert.equal(DEFAULT_SETTINGS.global_voice_id, 'edge:es-MX-DaliaNeural');
    assert.deepEqual(parseVoiceId(repos.settings.getGlobalVoiceId()), {
      engine: TTS_ENGINE_NAMES.edge,
      name: 'es-MX-DaliaNeural',
    });
  });

  section('interfaz TTSEngine');

  await check('el motor del navegador cumple la interfaz y es de tipo client', async () => {
    const engine = assertTtsEngine(createBrowserEngine());
    assert.equal(engine.name, TTS_ENGINE_NAMES.browser);
    assert.equal(engine.kind, TTS_ENGINE_KINDS.client);
    assert.equal(await engine.isAvailable(), true);
    assert.deepEqual(await engine.listVoices(), []);
    assert.equal(engine.synthesize, undefined, 'un motor client no debe sintetizar en el backend');
  });

  await check('assertTtsEngine rechaza contratos incompletos', () => {
    const valid = createFakeServerEngine();
    assert.throws(() => assertTtsEngine(null), TypeError);
    assert.throws(() => assertTtsEngine({ ...valid, name: '' }), TypeError);
    assert.throws(() => assertTtsEngine({ ...valid, name: 'edge:mala' }), TypeError, 'el nombre no puede llevar ":"');
    assert.throws(() => assertTtsEngine({ ...valid, kind: 'otro' }), TypeError);
    assert.throws(() => assertTtsEngine({ ...valid, listVoices: undefined }), TypeError);
    assert.throws(() => assertTtsEngine({ ...valid, isAvailable: undefined }), TypeError);
    assert.throws(() => assertTtsEngine({ ...valid, synthesize: undefined }), TypeError, 'server necesita synthesize');
    assert.equal(assertTtsEngine(valid), valid);
  });

  section('registro de motores');

  await check('un registro nuevo trae siempre el motor del navegador', () => {
    const registry = createTtsEngineRegistry();
    assert.equal(registry.has(TTS_ENGINE_NAMES.browser), true);
    assert.equal(registry.fallback.name, FALLBACK_ENGINE_NAME);
    assert.deepEqual(
      registry.list().map((engine) => engine.name),
      [TTS_ENGINE_NAMES.browser],
    );
  });

  await check('una voz de un motor no registrado cae al navegador sin voz concreta', () => {
    const registry = createTtsEngineRegistry();
    const resolved = registry.resolve('edge:es-MX-DaliaNeural');
    assert.equal(resolved.engine.name, TTS_ENGINE_NAMES.browser);
    assert.equal(resolved.voiceId, null, 'sin motor no se puede pedir una voz concreta');
    assert.equal(resolved.fallback, true);
  });

  await check('un id de voz inválido también cae al navegador', () => {
    const registry = createTtsEngineRegistry();
    for (const bad of ['', 'Paulina', null, undefined]) {
      const resolved = registry.resolve(bad);
      assert.equal(resolved.engine.name, TTS_ENGINE_NAMES.browser);
      assert.equal(resolved.voiceId, null);
      assert.equal(resolved.fallback, true);
    }
  });

  await check('registrar un motor de servidor hace que sus voces se resuelvan a él', () => {
    const registry = createTtsEngineRegistry();
    registry.register(createFakeServerEngine());
    const resolved = registry.resolve('edge:es-MX-DaliaNeural');
    assert.equal(resolved.engine.name, TTS_ENGINE_NAMES.edge);
    assert.equal(resolved.engine.kind, TTS_ENGINE_KINDS.server);
    assert.equal(resolved.voiceId, 'edge:es-MX-DaliaNeural', 'la voz pedida debe conservarse tal cual');
    assert.equal(resolved.fallback, false);
  });

  await check('una voz del navegador se resuelve conservando su id', () => {
    const registry = createTtsEngineRegistry();
    const resolved = registry.resolve('browser:Paulina');
    assert.equal(resolved.engine.name, TTS_ENGINE_NAMES.browser);
    assert.equal(resolved.voiceId, 'browser:Paulina');
    assert.equal(resolved.fallback, false);
  });

  await check('listVoices agrega catálogos y aísla al motor que falla', async () => {
    const registry = createTtsEngineRegistry();
    registry.register(createFakeServerEngine());
    registry.register({
      name: 'roto',
      kind: TTS_ENGINE_KINDS.server,
      isAvailable: async () => true,
      listVoices: async () => {
        throw new Error('sin catálogo');
      },
      synthesize: async () => ({ format: 'mp3', base64: '' }),
    });
    const voices = await registry.listVoices();
    assert.deepEqual(
      voices.map((voice) => voice.id),
      ['edge:es-MX-DaliaNeural'],
    );
  });

  section('filtros de texto y de autor');

  await check('un mensaje que empieza por "!" es un comando (aunque lleve espacios)', () => {
    assert.equal(isCommand('!comandos'), true);
    assert.equal(isCommand('   !cambia-mi-voz Dalia'), true);
    assert.equal(isCommand('hola !no'), false);
    assert.equal(isCommand('¡ojo, esto no es un comando!'), false);
    assert.equal(isCommand(''), false);
  });

  await check('los bots conocidos incluyen Nightbot y StreamElements', () => {
    assert.ok(KNOWN_BOT_USERNAMES.includes('nightbot'));
    assert.ok(KNOWN_BOT_USERNAMES.includes('streamelements'));
    assert.equal(isKnownBot('Nightbot'), true, 'la comparación debe ignorar mayúsculas');
    assert.equal(isKnownBot('  streamelements '), true);
    assert.equal(isKnownBot('juanito'), false);
    assert.equal(isKnownBot('nightbot_fan'), false, 'no vale un heurístico por subcadena');
    assert.equal(isKnownBot(undefined), false);
  });

  await check('las URLs se leen como "enlace"', () => {
    assert.equal(replaceUrls('mira esto https://twitch.tv/alguien ahora'), 'mira esto enlace ahora');
    assert.equal(replaceUrls('http://ejemplo.com/a?b=1#c'), 'enlace');
    assert.equal(replaceUrls('www.ejemplo.com'), 'enlace');
    assert.equal(replaceUrls('pásate por twitch.tv'), 'pásate por enlace');
    assert.equal(replaceUrls('clip en youtu.be/abc123'), 'clip en enlace');
    assert.equal(replaceUrls('dos https://a.com y https://b.org'), 'dos enlace y enlace');
    assert.equal(replaceUrls('https://solo-un.link/x'), 'enlace');
    assert.ok(hasUrl('vamos a twitch.tv/canal'));
    assert.equal(hasUrl('sin enlaces aquí'), false);
  });

  await check('la prosa en español no se confunde con un dominio', () => {
    for (const text of ['no me gusta.me da igual', 'vale.es lo que hay', 'punto.final', 'hola... adiós', '3.14 pi']) {
      assert.equal(hasUrl(text), false, `no debía ver una URL en "${text}"`);
      assert.equal(replaceUrls(text), text.replace(/\s+/g, ' ').trim());
    }
  });

  await check('se lee SOLO el texto del mensaje (sin "usuario dice")', () => {
    assert.equal(toSpokenText('hola mundo'), 'hola mundo');
    assert.equal(toSpokenText('  varios   espacios  '), 'varios espacios');
    assert.equal(toSpokenText('https://solo-enlace.com'), 'enlace');
    assert.equal(toSpokenText(''), '');
  });

  section('pipeline: decisión por mensaje');

  const registry = createTtsEngineRegistry();
  const pipeline = createTtsPipeline({ registry, repositories });

  await check('un usuario desconocido se lee con la voz global (respaldo navegador)', () => {
    const decision = pipeline.decide(makeMessage({ userId: '999', username: 'nuevo' }));
    assert.equal(decision.visible, true);
    assert.equal(decision.reason, null);
    assert.deepEqual(Object.keys(decision.tts).sort(), ['engine', 'pitch', 'text', 'timbre', 'voiceId', 'volume']);
    assert.equal(decision.tts.engine, TTS_ENGINE_NAMES.browser);
    assert.equal(decision.tts.voiceId, null);
    assert.equal(decision.tts.pitch, 1);
    assert.equal(decision.tts.timbre, 1);
    assert.equal(decision.tts.volume, 1);
    assert.equal(decision.tts.text, 'hola mundo');
  });

  await check('la voz asignada al usuario manda sobre la global', () => {
    seedUser('101', 'ana', { voiceId: 'browser:Paulina', voiceSource: 'override' });
    const decision = pipeline.decide(makeMessage({ userId: '101', username: 'ana' }));
    assert.equal(decision.tts.engine, TTS_ENGINE_NAMES.browser);
    assert.equal(decision.tts.voiceId, 'browser:Paulina');
  });

  await check('con el motor registrado, la voz global se resuelve a ese motor', () => {
    const withEdge = createTtsEngineRegistry();
    withEdge.register(createFakeServerEngine());
    const edgePipeline = createTtsPipeline({ registry: withEdge, repositories });
    const decision = edgePipeline.decide(makeMessage({ userId: '999', username: 'nuevo' }));
    assert.equal(decision.tts.engine, TTS_ENGINE_NAMES.edge);
    assert.equal(decision.tts.voiceId, 'edge:es-MX-DaliaNeural');
  });

  await check('un usuario muted SE MUESTRA pero no se lee', () => {
    seedUser('102', 'silencioso', { muted: true });
    const decision = pipeline.decide(makeMessage({ userId: '102', username: 'silencioso' }));
    assert.equal(decision.visible, true, 'muted sigue visible en el chat');
    assert.equal(decision.tts, null);
    assert.equal(decision.reason, TTS_SKIP_REASONS.muted);
  });

  await check('un usuario ignored NO se muestra ni se lee', () => {
    seedUser('103', 'invisible', { ignored: true });
    const decision = pipeline.decide(makeMessage({ userId: '103', username: 'invisible' }));
    assert.equal(decision.visible, false);
    assert.equal(decision.tts, null);
    assert.equal(decision.reason, TTS_SKIP_REASONS.ignored);
  });

  await check('ignored gana a muted cuando el usuario tiene los dos flags', () => {
    seedUser('104', 'ambos', { muted: true, ignored: true });
    const decision = pipeline.decide(makeMessage({ userId: '104', username: 'ambos' }));
    assert.equal(decision.visible, false);
    assert.equal(decision.reason, TTS_SKIP_REASONS.ignored);
  });

  await check('los comandos se muestran pero no se leen', () => {
    const decision = pipeline.decide(makeMessage({ text: '!cambia-mi-voz Dalia' }));
    assert.equal(decision.visible, true);
    assert.equal(decision.tts, null);
    assert.equal(decision.reason, TTS_SKIP_REASONS.command);
  });

  await check('los bots conocidos se muestran pero no se leen', () => {
    const decision = pipeline.decide(makeMessage({ userId: '19264788', username: 'nightbot', text: 'sigue al canal' }));
    assert.equal(decision.visible, true);
    assert.equal(decision.tts, null);
    assert.equal(decision.reason, TTS_SKIP_REASONS.bot);
  });

  await check('un mensaje con URL se lee con "enlace" en su lugar', () => {
    const decision = pipeline.decide(makeMessage({ text: 'mírate esto https://clips.twitch.tv/abc ya' }));
    assert.equal(decision.tts.text, 'mírate esto enlace ya');
  });

  await check('un mensaje que es solo una URL se sigue leyendo como "enlace"', () => {
    const decision = pipeline.decide(makeMessage({ text: 'https://twitch.tv/alguien' }));
    assert.equal(decision.tts.text, 'enlace');
    assert.equal(decision.reason, null);
  });

  await check('pitch y volumen se recortan al rango que acepta Web Speech', () => {
    seedUser('105', 'extremo', { pitch: 9, volume: -3 });
    let decision = pipeline.decide(makeMessage({ userId: '105', username: 'extremo' }));
    assert.equal(decision.tts.pitch, 2);
    assert.equal(decision.tts.volume, 0);

    repos.users.updatePreferences('105', { pitch: 1.4, volume: 0.5 });
    decision = pipeline.decide(makeMessage({ userId: '105', username: 'extremo' }));
    assert.equal(decision.tts.pitch, 1.4, 'el rango del plan (0.8–1.4) pasa intacto');
    assert.equal(decision.tts.volume, 0.5);

    // `users.pitch`/`users.volume` son NOT NULL en el esquema de T-002, así que
    // el caso "sin valor" solo puede venir de un usuario que aún no tiene fila.
    assert.throws(() => repos.users.updatePreferences('105', { pitch: null }));
    const unknown = pipeline.decide(makeMessage({ userId: 'sin-fila', username: 'fantasma' }));
    assert.equal(unknown.tts.pitch, 1, 'sin fila se usa el pitch neutro');
    assert.equal(unknown.tts.volume, 1);
  });

  await check('un cambio de preferencias aplica al mensaje siguiente sin reiniciar', () => {
    seedUser('106', 'cambiante');
    assert.notEqual(pipeline.decide(makeMessage({ userId: '106', username: 'cambiante' })).tts, null);
    repos.users.updatePreferences('106', { muted: true });
    assert.equal(pipeline.decide(makeMessage({ userId: '106', username: 'cambiante' })).tts, null);
    repos.users.updatePreferences('106', { muted: false });
    assert.notEqual(pipeline.decide(makeMessage({ userId: '106', username: 'cambiante' })).tts, null);
  });

  await check('si la base falla el mensaje se muestra sin voz (nunca desaparece)', () => {
    const broken = createTtsPipeline({
      registry,
      repositories: () => {
        throw new Error('base caída');
      },
    });
    const decision = broken.decide(makeMessage());
    assert.equal(decision.visible, true);
    assert.equal(decision.tts, null);
  });

  section('relay: la trama chat:message enriquecida');

  const frames = [];
  const fakeHub = {
    broadcast: (type, payload) => frames.push({ type, payload }),
  };

  const providerHandlers = new Map();
  const fakeProvider = {
    name: 'fake',
    start: () => {},
    stop: () => {},
    getStatus: () => CHAT_PROVIDER_STATUS.subscribed,
    on(event, handler) {
      if (!providerHandlers.has(event)) {
        providerHandlers.set(event, new Set());
      }
      providerHandlers.get(event).add(handler);
      return () => providerHandlers.get(event).delete(handler);
    },
    emit(event, value) {
      for (const handler of providerHandlers.get(event) ?? []) {
        handler(value);
      }
    },
  };

  const seenByHandlers = [];
  const relay = createChatRelay({
    hub: fakeHub,
    provider: fakeProvider,
    repositories,
    tts: pipeline,
    sessionPollMs: 60_000,
    isSessionReady: () => true,
  });
  relay.onMessage((message) => seenByHandlers.push(message));
  relay.start();

  await check('un mensaje normal viaja en UNA trama con la instrucción TTS adjunta', async () => {
    const message = makeMessage({ userId: '200', username: 'lectora', text: 'que se lea esto' });
    fakeProvider.emit('message', message);
    await waitFor('la trama del mensaje', () => frames.find((frame) => frame.payload.id === message.id));

    const matching = frames.filter((frame) => frame.payload.id === message.id);
    assert.equal(matching.length, 1, 'debe haber exactamente una trama por mensaje');
    assert.equal(matching[0].type, CHAT_MESSAGE_TYPE);
    assert.deepEqual(Object.keys(matching[0].payload).sort(), [...CHAT_MESSAGE_FRAME_FIELDS].sort());
    assert.equal(matching[0].payload.text, 'que se lea esto', 'el texto mostrado no se toca');
    assert.equal(matching[0].payload.tts.text, 'que se lea esto');
    assert.equal(matching[0].payload.tts.engine, TTS_ENGINE_NAMES.browser);
  });

  await check('el autor queda registrado en `users` (upsert de T-004 intacto)', () => {
    const user = repos.users.get('200');
    assert.ok(user, 'el usuario debía existir tras su primer mensaje');
    assert.equal(user.username, 'lectora');
    assert.ok(user.lastActiveAt > 0);
  });

  await check('un usuario muted se publica con tts null (se ve, no se oye)', async () => {
    const message = makeMessage({ userId: '102', username: 'silencioso', text: 'no me leas' });
    fakeProvider.emit('message', message);
    const frame = await waitFor('la trama del muteado', () => frames.find((item) => item.payload.id === message.id));
    assert.equal(frame.payload.tts, null);
    assert.equal(frame.payload.text, 'no me leas');
  });

  await check('un usuario ignored no genera ninguna trama pero sí llega a onMessage', async () => {
    const before = frames.length;
    const message = makeMessage({ userId: '103', username: 'invisible', text: 'nadie me ve' });
    fakeProvider.emit('message', message);
    await waitFor('el handler de backend', () => seenByHandlers.some((item) => item.id === message.id));
    assert.equal(frames.length, before, 'no debía publicarse nada al frontend');
    assert.equal(frames.some((frame) => frame.payload.id === message.id), false);
  });

  await check('el mensaje de un ignored sí refresca su actividad en `users`', () => {
    const user = repos.users.get('103');
    assert.ok(user.lastActiveAt > 0);
    assert.equal(user.ignored, true);
  });

  await check('los contadores del relay distinguen publicados de ocultados', () => {
    const status = relay.getStatus();
    assert.equal(status.messagesRelayed, frames.length);
    assert.equal(status.messagesHidden, 1);
  });

  relay.stop();
} finally {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} comprobaciones ok`);
if (failures > 0) {
  console.error(`${failures} comprobación(es) fallaron`);
  process.exit(1);
}
