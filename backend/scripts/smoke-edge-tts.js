/**
 * Pruebas de humo del motor edge-tts y de la capa de audio de servidor (T-009):
 *
 *   npm --prefix backend run test:edge-tts
 *
 * Cubre cuatro bloques:
 *
 * 1. **Puro** (sin red): conversión de pitch a Hz, ids de voz namespaced, el
 *    catálogo mapeado, el almacén de audio y el orden del catálogo agregado.
 * 2. **El registro y el pipeline**: que la voz global default
 *    (`edge:es-MX-DaliaNeural`) resuelva **al motor edge** y que la instrucción
 *    salga con `audio.url`, mientras una voz `browser:*` sale sin `audio`.
 * 3. **Las rutas** (`GET /api/voices` y `GET /api/tts/audio/:id`) sobre la app
 *    Express real, con motores falsos: incluye la prueba de que el catálogo es
 *    **genérico** (un motor nuevo aparece sin tocar la ruta) y el `503` que
 *    dispara el respaldo al navegador.
 * 4. **Red real** (requiere internet): que edge-tts devuelva **MP3 de verdad** con
 *    el pitch aplicado, que una voz inexistente falle, y el catálogo en español.
 *    Si no hay internet este bloque falla con un mensaje explícito: edge-tts es un
 *    servicio online y el criterio de T-009 es explícito al respecto. Para correr
 *    solo lo determinista: `SKIP_NETWORK=1 npm --prefix backend run test:edge-tts`.
 *
 * No necesita `.env`, ni credenciales, ni puertos fijos: la app se levanta en el
 * puerto 0 y la base es un SQLite temporal.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createRepositories, openDatabase } from '../src/db/index.js';
import { DEFAULT_SETTINGS } from '../src/db/migrations.js';
import {
  AUDIO_MIME_TYPES,
  EDGE_DEFAULT_VOICE_NAME,
  SERVER_AUDIO_ROUTE,
  TTS_ENGINE_KINDS,
  TTS_ENGINE_NAMES,
  assertTtsEngine,
  createEdgeTtsEngine,
  createServerAudioStore,
  createTtsEngineRegistry,
  createTtsPipeline,
  createTtsRouter,
  formatVoiceId,
  matchesLanguages,
  pitchToEdgeHz,
  serverAudioUrl,
  sortVoiceCatalog,
  toEdgeVoiceName,
  toTtsVoice,
} from '../src/tts/index.js';
import { timbreToEdgeRate } from '../src/tts/edge-engine.js';

const SKIP_NETWORK = ['1', 'true', 'yes'].includes(String(process.env.SKIP_NETWORK ?? '').toLowerCase());

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-hub-edge-'));
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
    console.error(`       ${String(error.message).split('\n').join('\n       ')}`);
  }
};

/** Cabecera de un frame MPEG (MP3): 11 bits a 1. */
const isMp3 = (bytes) => bytes.length > 4 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;

/** Motor de servidor controlable: sirve para probar la capa sin tocar la red. */
const createStubServerEngine = ({ name = 'stub', audio = null, fail = null, delayMs = 0 } = {}) => {
  const calls = [];
  return {
    engine: {
      name,
      kind: TTS_ENGINE_KINDS.server,
      isAvailable: async () => true,
      listVoices: async () => [
        {
          id: formatVoiceId(name, 'es-ES-Prueba'),
          name: 'es-ES-Prueba',
          engine: name,
          language: 'es-ES',
          label: `Prueba (${name})`,
        },
        {
          id: formatVoiceId(name, 'en-US-Otra'),
          name: 'en-US-Otra',
          engine: name,
          language: 'en-US',
          label: `Otra (${name})`,
        },
      ],
      async synthesize(request) {
        calls.push(request);
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        if (fail !== null) {
          throw new Error(fail);
        }
        return audio ?? { format: 'mp3', base64: Buffer.from([0xff, 0xf3, 0x64, 0xc4, 1, 2, 3]).toString('base64') };
      },
    },
    calls,
  };
};

/** Levanta la app Express en un puerto libre y devuelve un `fetch` con base. */
const startApp = async (app) => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    get: (routePath) => fetch(`http://127.0.0.1:${port}${routePath}`),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const db = openDatabase(dbFile);
const repos = createRepositories(db);
const repositories = () => repos;

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

async function main() {
  console.log('Humo de edge-tts y del audio de servidor (T-009)');
  console.log(`  base temporal: ${dbFile}`);
  console.log(`  red real: ${SKIP_NETWORK ? 'omitida (SKIP_NETWORK)' : 'sí'}`);

  section('motor edge: contrato e ids de voz');

  await check('el motor cumple la interfaz TTSEngine y es de servidor', () => {
    const engine = createEdgeTtsEngine();
    assertTtsEngine(engine);
    assert.equal(engine.name, TTS_ENGINE_NAMES.edge);
    assert.equal(engine.kind, TTS_ENGINE_KINDS.server);
    assert.equal(typeof engine.synthesize, 'function');
  });

  await check('el pitch 0–2 se traduce al desplazamiento en Hz del SSML', () => {
    assert.equal(pitchToEdgeHz(1), '+0Hz');
    assert.equal(pitchToEdgeHz(undefined), '+0Hz');
    assert.equal(pitchToEdgeHz(Number.NaN), '+0Hz');
    // El rango que reparte T-011 entre usuarios (0.8–1.4).
    assert.equal(pitchToEdgeHz(0.8), '-10Hz');
    assert.equal(pitchToEdgeHz(1.4), '+20Hz');
    // Los extremos de Web Speech quedan recortados al límite audible sin artefactos.
    assert.equal(pitchToEdgeHz(0), '-50Hz');
    assert.equal(pitchToEdgeHz(2), '+50Hz');
    assert.equal(pitchToEdgeHz(9), '+50Hz');
    assert.equal(pitchToEdgeHz(-9), '-50Hz');
    assert.match(pitchToEdgeHz(1.234), /^[+-]\d+Hz$/, 'el servicio valida este formato exacto');
  });

  await check('el timbre 0–2 se traduce a un rate % del SSML, independiente del pitch', () => {
    assert.equal(timbreToEdgeRate(1), '+0%');
    assert.equal(timbreToEdgeRate(undefined), '+0%');
    assert.equal(timbreToEdgeRate(Number.NaN), '+0%');
    // El rango que reparte T-011 entre usuarios (0.8–1.4).
    assert.equal(timbreToEdgeRate(0.8), '-20%');
    assert.equal(timbreToEdgeRate(1.4), '+30%', 'se recorta: (1.4-1)*100=40 > el límite de 30');
    // Los extremos quedan recortados al límite.
    assert.equal(timbreToEdgeRate(0), '-30%');
    assert.equal(timbreToEdgeRate(2), '+30%');
    assert.equal(timbreToEdgeRate(9), '+30%');
    assert.equal(timbreToEdgeRate(-9), '-30%');
    assert.match(timbreToEdgeRate(1.234), /^[+-]\d+%$/, 'el servicio valida este formato exacto');
  });

  await check('el id namespaced se convierte al ShortName del servicio', () => {
    assert.equal(toEdgeVoiceName('edge:es-MX-DaliaNeural'), 'es-MX-DaliaNeural');
    assert.equal(toEdgeVoiceName('edge:es-ES-AlvaroNeural'), 'es-ES-AlvaroNeural');
    // `null` = "elige tú": cae en la voz global default del plan.
    assert.equal(toEdgeVoiceName(null), EDGE_DEFAULT_VOICE_NAME);
    assert.equal(toEdgeVoiceName('browser:Paulina'), EDGE_DEFAULT_VOICE_NAME);
    assert.equal(toEdgeVoiceName('sin-namespace'), EDGE_DEFAULT_VOICE_NAME);
    assert.equal(EDGE_DEFAULT_VOICE_NAME, 'es-MX-DaliaNeural');
    assert.equal(DEFAULT_SETTINGS.global_voice_id, formatVoiceId(TTS_ENGINE_NAMES.edge, EDGE_DEFAULT_VOICE_NAME));
  });

  await check('la voz del servicio se mapea a TtsVoice con id namespaced', () => {
    const voice = toTtsVoice({
      ShortName: 'es-MX-DaliaNeural',
      Locale: 'es-MX',
      Gender: 'Female',
      FriendlyName: 'Microsoft Dalia Online (Natural) - Spanish (Mexico)',
    });
    assert.equal(voice.id, 'edge:es-MX-DaliaNeural');
    assert.equal(voice.name, 'es-MX-DaliaNeural');
    assert.equal(voice.engine, TTS_ENGINE_NAMES.edge);
    assert.equal(voice.language, 'es-MX');
    assert.equal(voice.label, 'Dalia (es-MX, mujer)');
  });

  await check('el filtro de idiomas del catálogo acepta prefijos y comodín', () => {
    assert.equal(matchesLanguages('es-MX', ['es']), true);
    assert.equal(matchesLanguages('es', ['es']), true);
    assert.equal(matchesLanguages('en-US', ['es']), false);
    assert.equal(matchesLanguages('en-US', ['es', 'en']), true);
    assert.equal(matchesLanguages('en-US', ['*']), true);
    assert.equal(matchesLanguages('en-US', []), true);
    assert.equal(matchesLanguages('estonio-falso', ['es']), false, 'no debe encajar por prefijo sin guion');
  });

  await check('la síntesis manda voz y pitch al servicio, y el volumen NO', async () => {
    // El volumen se aplica en la reproducción (`audio.volume` en el frontend):
    // mandarlo también en el SSML atenuaría dos veces.
    const seen = [];
    const engine = createEdgeTtsEngine({
      load: async () => ({
        Communicate: class {
          constructor(text, options) {
            seen.push({ text, options });
          }
          async *stream() {
            yield { type: 'audio', data: Buffer.from([0xff, 0xf3, 0x64, 0xc4]) };
          }
        },
      }),
    });

    const audio = await engine.synthesize({
      text: '  hola mundo  ',
      voiceId: 'edge:es-ES-AlvaroNeural',
      pitch: 1.4,
      volume: 0.25,
    });
    assert.equal(audio.format, 'mp3');
    assert.equal(Buffer.from(audio.base64, 'base64').toString('hex'), 'fff364c4');

    assert.equal(seen.length, 1);
    assert.equal(seen[0].text, 'hola mundo', 'el texto va limpio de espacios');
    assert.equal(seen[0].options.voice, 'es-ES-AlvaroNeural');
    assert.equal(seen[0].options.pitch, '+20Hz');
    assert.equal(seen[0].options.volume, undefined, 'el volumen no se manda en el SSML');
    assert.equal(typeof seen[0].options.connectionTimeout, 'number');
  });

  await check('un fallo de la síntesis se propaga (para poder caer al navegador)', async () => {
    const engine = createEdgeTtsEngine({
      timeoutMs: 50,
      load: async () => ({
        // Simula el caso "sin internet": la librería se queda colgada. El timeout
        // duro del motor es lo que garantiza que la promesa rechaza.
        Communicate: class {
          stream() {
            return {
              [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
            };
          }
        },
      }),
    });
    await assert.rejects(() => engine.synthesize({ text: 'hola', voiceId: 'edge:es-MX-DaliaNeural' }), /no respondió/);
  });

  await check('sin texto no se llama al servicio', async () => {
    let loaded = false;
    const engine = createEdgeTtsEngine({
      load: async () => {
        loaded = true;
        return {};
      },
    });
    await assert.rejects(() => engine.synthesize({ text: '   ', voiceId: 'edge:es-MX-DaliaNeural' }), /texto/);
    assert.equal(loaded, false, 'no debía cargarse el paquete para un texto vacío');
  });

  await check('el catálogo se cachea y sobrevive a un fallo posterior', async () => {
    let calls = 0;
    const engine = createEdgeTtsEngine({
      languages: ['es'],
      load: async () => ({
        listVoices: async () => {
          calls += 1;
          if (calls > 1) {
            throw new Error('sin internet');
          }
          return [
            { ShortName: 'es-MX-DaliaNeural', Locale: 'es-MX', Gender: 'Female' },
            { ShortName: 'es-ES-AlvaroNeural', Locale: 'es-ES', Gender: 'Male' },
            { ShortName: 'en-US-EmmaNeural', Locale: 'en-US', Gender: 'Female' },
          ];
        },
      }),
      voiceCacheTtlMs: 0,
    });

    const first = await engine.listVoices();
    assert.deepEqual(
      first.map((voice) => voice.id),
      ['edge:es-ES-AlvaroNeural', 'edge:es-MX-DaliaNeural'],
      'solo español, ordenado por id',
    );
    assert.equal(await engine.isAvailable(), true);

    const second = await engine.listVoices();
    assert.deepEqual(second, first, 'un fallo al refrescar devuelve el último catálogo bueno');
    assert.ok(calls > 1, 'con TTL 0 debía intentar refrescar');
  });

  await check('sin catálogo previo, el registro aísla al motor que falla', async () => {
    const registry = createTtsEngineRegistry();
    registry.register(
      createEdgeTtsEngine({
        load: async () => ({
          listVoices: async () => {
            throw new Error('sin internet');
          },
        }),
      }),
    );
    assert.deepEqual(await registry.listVoices(), [], 'el catálogo agregado no se cae, sale vacío');
  });

  section('audio de servidor: almacén genérico');

  await check('un motor de cliente no lleva audio adjunto', () => {
    const registry = createTtsEngineRegistry();
    const store = createServerAudioStore({ registry });
    const tts = { engine: TTS_ENGINE_NAMES.browser, voiceId: null, pitch: 1, volume: 1, text: 'hola' };
    const attached = store.attach('m1', tts);
    assert.deepEqual(Object.keys(attached).sort(), ['engine', 'pitch', 'text', 'voiceId', 'volume']);
    assert.equal(store.getStats().started, 0, 'no debía arrancar ninguna síntesis');
  });

  await check('un motor de servidor recibe la instrucción y adjunta la URL', async () => {
    const { engine, calls } = createStubServerEngine({ name: 'stub' });
    const registry = createTtsEngineRegistry();
    registry.register(engine);
    const store = createServerAudioStore({ registry });

    const attached = store.attach('m2', {
      engine: 'stub',
      voiceId: 'stub:es-ES-Prueba',
      pitch: 1.4,
      volume: 0.5,
      text: 'hola mundo',
    });
    assert.deepEqual(attached.audio, { url: '/api/tts/audio/m2' });
    assert.equal(serverAudioUrl('m2'), `${SERVER_AUDIO_ROUTE}/m2`);
    assert.equal(attached.text, 'hola mundo', 'la instrucción original se conserva');

    const entry = store.get('m2');
    assert.ok(entry !== null);
    const served = await entry.audio;
    assert.equal(served.mime, AUDIO_MIME_TYPES.mp3);
    assert.ok(isMp3(served.bytes), 'los bytes decodificados deben ser audio');

    assert.equal(calls.length, 1, 'la síntesis se arranca una sola vez');
    assert.deepEqual(calls[0], {
      text: 'hola mundo',
      voiceId: 'stub:es-ES-Prueba',
      pitch: 1.4,
      volume: 0.5,
    });
  });

  await check('el id del mensaje se codifica en la URL', () => {
    assert.equal(serverAudioUrl('a b/c?d'), '/api/tts/audio/a%20b%2Fc%3Fd');
  });

  await check('un fallo del motor deja la entrada rechazada, no reventada', async () => {
    const { engine } = createStubServerEngine({ name: 'stub', fail: 'sin internet' });
    const registry = createTtsEngineRegistry();
    registry.register(engine);
    const store = createServerAudioStore({ registry });

    const attached = store.attach('m3', { engine: 'stub', voiceId: null, pitch: 1, volume: 1, text: 'hola' });
    assert.deepEqual(attached.audio, { url: '/api/tts/audio/m3' });
    await assert.rejects(() => store.get('m3').audio, /sin internet/);
    assert.equal(store.getStats().failed, 1);
    // El proceso sigue vivo: la promesa colgada tiene su propio observador.
    await new Promise((resolve) => setImmediate(resolve));
  });

  await check('un audio con formato desconocido o vacío se rechaza', async () => {
    const registry = createTtsEngineRegistry();
    registry.register(createStubServerEngine({ name: 'raro', audio: { format: 'flac', base64: 'AAAA' } }).engine);
    registry.register(createStubServerEngine({ name: 'vacio', audio: { format: 'mp3', base64: '' } }).engine);
    const store = createServerAudioStore({ registry });

    store.attach('m4', { engine: 'raro', voiceId: null, pitch: 1, volume: 1, text: 'hola' });
    store.attach('m5', { engine: 'vacio', voiceId: null, pitch: 1, volume: 1, text: 'hola' });
    await assert.rejects(() => store.get('m4').audio, /formato desconocido/);
    await assert.rejects(() => store.get('m5').audio, /no devolvió audio/);
  });

  await check('el almacén tiene tope de entradas y TTL', async () => {
    const { engine } = createStubServerEngine({ name: 'stub' });
    const registry = createTtsEngineRegistry();
    registry.register(engine);

    let clock = 1_000;
    const store = createServerAudioStore({ registry, maxEntries: 2, ttlMs: 100, now: () => clock });
    const tts = { engine: 'stub', voiceId: null, pitch: 1, volume: 1, text: 'hola' };

    store.attach('a', tts);
    store.attach('b', tts);
    store.attach('c', tts);
    assert.equal(store.get('a'), null, 'la más vieja se descarta al pasar el tope');
    assert.ok(store.get('c') !== null);
    assert.equal(store.getStats().size, 2);

    clock += 1_000;
    assert.equal(store.get('c'), null, 'una entrada caducada no se sirve');
  });

  section('pipeline: la voz global default resuelve a edge');

  await check('con edge registrado, la voz global lleva audio de servidor', () => {
    const { engine } = createStubServerEngine({ name: TTS_ENGINE_NAMES.edge });
    const registry = createTtsEngineRegistry();
    registry.register(engine);
    const pipeline = createTtsPipeline({ registry, repositories });

    const decision = pipeline.decide(makeMessage({ userId: '900', username: 'nueva' }));
    assert.equal(decision.visible, true);
    assert.equal(decision.tts.engine, TTS_ENGINE_NAMES.edge, 'la voz global default ya NO cae al navegador');
    assert.equal(decision.tts.voiceId, 'edge:es-MX-DaliaNeural');
    assert.deepEqual(Object.keys(decision.tts).sort(), ['audio', 'engine', 'pitch', 'text', 'timbre', 'voiceId', 'volume']);
    assert.match(decision.tts.audio.url, /^\/api\/tts\/audio\//);
    assert.equal(pipeline.serverAudio.getStats().started, 1);
  });

  await check('el pitch y el volumen del usuario llegan a la síntesis', async () => {
    const { engine, calls } = createStubServerEngine({ name: TTS_ENGINE_NAMES.edge });
    const registry = createTtsEngineRegistry();
    registry.register(engine);
    const pipeline = createTtsPipeline({ registry, repositories });

    repos.users.upsert({ twitchUserId: '901', username: 'ana', displayName: 'Ana' });
    repos.users.updatePreferences('901', { pitch: 1.4, volume: 0.25 });

    const decision = pipeline.decide(makeMessage({ userId: '901', username: 'ana' }));
    assert.equal(decision.tts.pitch, 1.4, 'viaja en la instrucción para el respaldo del navegador');
    assert.equal(decision.tts.volume, 0.25);

    // La síntesis se arranca en un microtask (decide() no espera): hay que dejarla
    // llegar antes de mirar con qué se llamó al motor.
    const id = decodeURIComponent(decision.tts.audio.url.split('/').pop());
    await pipeline.serverAudio.get(id).audio;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].pitch, 1.4, 'y llega al motor, que lo aplica en el SSML');
    assert.equal(calls[0].volume, 0.25, 'el volumen se pasa; el motor lo deja para la reproducción');
    assert.equal(pitchToEdgeHz(calls[0].pitch), '+20Hz');
  });

  await check('una voz del navegador sigue saliendo sin audio adjunto', () => {
    const { engine } = createStubServerEngine({ name: TTS_ENGINE_NAMES.edge });
    const registry = createTtsEngineRegistry();
    registry.register(engine);
    const pipeline = createTtsPipeline({ registry, repositories });

    repos.users.upsert({ twitchUserId: '902', username: 'beto', displayName: 'Beto' });
    repos.users.updatePreferences('902', { voiceId: 'browser:Paulina', voiceSource: 'override' });

    const decision = pipeline.decide(makeMessage({ userId: '902', username: 'beto' }));
    assert.equal(decision.tts.engine, TTS_ENGINE_NAMES.browser);
    assert.equal(decision.tts.audio, undefined, 'el navegador sintetiza: no hay nada que adjuntar');
  });

  await check('el orden de las decisiones no depende de lo que tarde la síntesis', async () => {
    // El criterio "FIFO intacto entre motores mezclados" se apoya en esto: la
    // instrucción sale al instante, aunque el motor de servidor tarde.
    const { engine } = createStubServerEngine({ name: TTS_ENGINE_NAMES.edge, delayMs: 120 });
    const registry = createTtsEngineRegistry();
    registry.register(engine);
    const pipeline = createTtsPipeline({ registry, repositories });

    repos.users.upsert({ twitchUserId: '903', username: 'cielo', displayName: 'Cielo' });
    repos.users.updatePreferences('903', { voiceId: 'browser:Paulina', voiceSource: 'override' });

    const started = Date.now();
    const decisions = [
      pipeline.decide(makeMessage({ userId: '900', username: 'nueva', text: 'uno' })), // edge (lenta)
      pipeline.decide(makeMessage({ userId: '903', username: 'cielo', text: 'dos' })), // navegador
      pipeline.decide(makeMessage({ userId: '900', username: 'nueva', text: 'tres' })), // edge (lenta)
    ];
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 100, `decidir no debe esperar la síntesis (tardó ${elapsed} ms)`);
    assert.deepEqual(
      decisions.map((decision) => decision.tts.text),
      ['uno', 'dos', 'tres'],
    );
    assert.deepEqual(
      decisions.map((decision) => decision.tts.engine),
      [TTS_ENGINE_NAMES.edge, TTS_ENGINE_NAMES.browser, TTS_ENGINE_NAMES.edge],
    );
    // Y el audio de las dos lentas llega igual, cada uno por su URL.
    for (const decision of [decisions[0], decisions[2]]) {
      const id = decodeURIComponent(decision.tts.audio.url.split('/').pop());
      const served = await pipeline.serverAudio.get(id).audio;
      assert.ok(isMp3(served.bytes));
    }
  });

  section('rutas: GET /api/voices y GET /api/tts/audio/:id');

  await check('el catálogo agregado ordena español primero y por motor', () => {
    const ordered = sortVoiceCatalog(
      [
        { id: 'edge:en-US-A', engine: 'edge', language: 'en-US' },
        { id: 'piper:es_MX-b', engine: 'piper', language: 'es-MX' },
        { id: 'edge:es-MX-b', engine: 'edge', language: 'es-MX' },
        { id: 'edge:es-ES-a', engine: 'edge', language: 'es-ES' },
      ],
      ['browser', 'edge', 'piper'],
    );
    assert.deepEqual(
      ordered.map((voice) => voice.id),
      ['edge:es-ES-a', 'edge:es-MX-b', 'piper:es_MX-b', 'edge:en-US-A'],
    );
  });

  {
    const express = (await import('express')).default;
    const registry = createTtsEngineRegistry();
    registry.register(createStubServerEngine({ name: TTS_ENGINE_NAMES.edge }).engine);
    const failing = createStubServerEngine({ name: 'roto', fail: 'sin internet' });
    registry.register(failing.engine);
    const serverAudio = createServerAudioStore({ registry });

    const app = express();
    app.use('/api', createTtsRouter({ registry, serverAudio }));
    const server = await startApp(app);

    await check('GET /api/voices lista las voces con ids namespaced', async () => {
      const response = await server.get('/api/voices');
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.ok(Array.isArray(body.voices));
      const edgeVoices = body.voices.filter((voice) => voice.engine === TTS_ENGINE_NAMES.edge);
      assert.ok(edgeVoices.length > 0);
      for (const voice of edgeVoices) {
        assert.match(voice.id, /^edge:/);
        assert.deepEqual(Object.keys(voice).sort(), ['engine', 'id', 'label', 'language', 'name']);
      }
      assert.deepEqual(
        body.engines.map((engine) => engine.name),
        [TTS_ENGINE_NAMES.browser, TTS_ENGINE_NAMES.edge, 'roto'],
      );
      assert.equal(body.engines[0].kind, TTS_ENGINE_KINDS.client);
      assert.equal(body.engines[1].kind, TTS_ENGINE_KINDS.server);
      assert.equal(body.voices[0].language.startsWith('es'), true, 'español primero');
    });

    await check('la ruta es genérica: un motor nuevo aparece sin tocarla (T-010)', async () => {
      const before = await (await server.get('/api/voices')).json();
      registry.register(createStubServerEngine({ name: 'piper' }).engine);
      const after = await (await server.get('/api/voices')).json();

      const piperVoices = after.voices.filter((voice) => voice.engine === 'piper');
      assert.equal(piperVoices.length, 2, 'las voces del motor recién registrado salen solas');
      assert.deepEqual(
        piperVoices.map((voice) => voice.id).sort(),
        ['piper:en-US-Otra', 'piper:es-ES-Prueba'],
      );
      assert.equal(after.voices.length, before.voices.length + 2);
      assert.ok(after.engines.some((engine) => engine.name === 'piper'));
    });

    await check('GET /api/tts/audio/:id devuelve el audio con su Content-Type', async () => {
      serverAudio.attach('ruta-1', {
        engine: TTS_ENGINE_NAMES.edge,
        voiceId: 'edge:es-MX-DaliaNeural',
        pitch: 1,
        volume: 1,
        text: 'hola',
      });
      const response = await server.get('/api/tts/audio/ruta-1');
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), AUDIO_MIME_TYPES.mp3);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.ok(isMp3(bytes), 'deben ser bytes de audio, no un placeholder');
    });

    await check('un mensaje sin audio da 404', async () => {
      const response = await server.get('/api/tts/audio/no-existe');
      assert.equal(response.status, 404);
      assert.equal((await response.json()).code, 'not_found');
    });

    await check('si la síntesis falló, la ruta da 503 (el cliente cae al navegador)', async () => {
      serverAudio.attach('ruta-2', { engine: 'roto', voiceId: null, pitch: 1, volume: 1, text: 'hola' });
      const response = await server.get('/api/tts/audio/ruta-2');
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.code, 'synthesis_failed');
      assert.ok(!/sin internet/.test(JSON.stringify(body)), 'el detalle queda en el log, no en la respuesta');
    });

    await server.close();
  }

  section(SKIP_NETWORK ? 'red real: OMITIDA' : 'red real: síntesis contra el servicio de Microsoft');

  if (!SKIP_NETWORK) {
    const engine = createEdgeTtsEngine();

    await check('el catálogo real trae voces en español con ids namespaced', async () => {
      const voices = await engine.listVoices();
      assert.ok(voices.length >= 10, `esperaba varias voces en español, llegaron ${voices.length}`);
      for (const voice of voices) {
        assert.match(voice.id, /^edge:/);
        assert.ok(String(voice.language).toLowerCase().startsWith('es'), `${voice.id} no es español`);
      }
      const ids = voices.map((voice) => voice.id);
      assert.ok(ids.includes('edge:es-MX-DaliaNeural'), 'la voz global default debe estar en el catálogo');
      assert.ok(ids.includes('edge:es-ES-AlvaroNeural'), 'y las de España también');
      assert.equal(await engine.isAvailable(), true);
    });

    await check('sintetiza MP3 real con la voz global default', async () => {
      const audio = await engine.synthesize({
        text: 'hola, esto es una prueba de la voz global',
        voiceId: 'edge:es-MX-DaliaNeural',
        pitch: 1,
        volume: 1,
      });
      assert.equal(audio.format, 'mp3');
      const bytes = Buffer.from(audio.base64, 'base64');
      assert.ok(bytes.length > 5_000, `esperaba audio de verdad, llegaron ${bytes.length} bytes`);
      assert.ok(isMp3(bytes), 'la cabecera debe ser de un frame MPEG');
    });

    await check('el servicio acepta el pitch alterado y otra voz en español', async () => {
      // Que el pitch *llegue* al SSML lo fija la comprobación determinista de
      // arriba; aquí se confirma que el servicio real lo admite y sigue devolviendo
      // audio (comparar bytes no serviría: dos síntesis idénticas ya difieren).
      const [alto, bajo] = await Promise.all([
        engine.synthesize({ text: 'prueba de tono agudo', voiceId: 'edge:es-MX-DaliaNeural', pitch: 1.4 }),
        engine.synthesize({ text: 'prueba de tono grave', voiceId: 'edge:es-ES-AlvaroNeural', pitch: 0.8 }),
      ]);
      for (const audio of [alto, bajo]) {
        const bytes = Buffer.from(audio.base64, 'base64');
        assert.ok(isMp3(bytes));
        assert.ok(bytes.length > 3_000, `esperaba audio de verdad, llegaron ${bytes.length} bytes`);
      }
    });

    await check('un error del servicio (voz inexistente) rechaza para poder respaldar', async () => {
      await assert.rejects(
        () => engine.synthesize({ text: 'hola', voiceId: 'edge:es-XX-NoExisteNeural', pitch: 1, volume: 1 }),
        (error) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.length > 0);
          return true;
        },
      );
    });

    await check('la cadena completa: registro real → pipeline → ruta con MP3', async () => {
      const express = (await import('express')).default;
      const registry = createTtsEngineRegistry();
      registry.register(createEdgeTtsEngine());
      const pipeline = createTtsPipeline({ registry, repositories });

      const app = express();
      app.use('/api', createTtsRouter({ registry, serverAudio: pipeline.serverAudio }));
      const server = await startApp(app);

      try {
        const decision = pipeline.decide(
          makeMessage({ userId: '910', username: 'real', text: 'mensaje sintetizado de verdad' }),
        );
        assert.equal(decision.tts.engine, TTS_ENGINE_NAMES.edge);
        assert.ok(decision.tts.audio.url.startsWith(SERVER_AUDIO_ROUTE));

        const response = await server.get(decision.tts.audio.url);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), AUDIO_MIME_TYPES.mp3);
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.ok(bytes.length > 5_000, `el audio servido debe ser real (${bytes.length} bytes)`);
        assert.ok(isMp3(bytes));
      } finally {
        await server.close();
      }
    });
  }

  console.log(`\n${failures === 0 ? 'TODO OK' : 'HAY FALLOS'}: ${checks - failures}/${checks} comprobaciones`);
  if (failures > 0 && !SKIP_NETWORK) {
    console.log('Si los fallos son del bloque de red: edge-tts es un servicio ONLINE y necesita internet.');
  }
}

try {
  await main();
} catch (error) {
  failures += 1;
  console.error('\nError inesperado en la prueba de humo:');
  console.error(error);
} finally {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
