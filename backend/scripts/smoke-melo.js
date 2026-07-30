/**
 * Pruebas de humo del motor MeloTTS (contenedor `docker/melotts/`):
 *
 *   npm --prefix backend run test:melo
 *
 * **Corre igual con el contenedor arriba y sin él**, porque eso es justo lo
 * que hay que garantizar: sin `docker compose up -d melotts`, el catálogo sale
 * vacío y el resto del sistema funciona igual — la misma degradación limpia
 * que Piper sin instalar.
 *
 * Cinco bloques:
 *
 * 1. **Lógica pura**: recorte de pitch, ids namespaced, mapeo a `TtsVoice`, la
 *    elección de locutor y la bandera de entorno. Nada de esto toca red.
 * 2. **Catálogo** con un `fetch` de mentira: qué locutores se ven y cómo se
 *    cachean.
 * 3. **Degradación limpia**: contenedor caído, JSON roto, o desactivado por
 *    entorno — catálogo vacío, `GET /api/voices` sigue respondiendo con las
 *    voces de los demás motores, y solo `synthesize()` lanza.
 * 4. **Síntesis con un `fetch` de mentira**: fija el `speed` inverso al pitch
 *    que se manda, el WAV que resulta, y los fallos (contenedor con error,
 *    colgado → timeout).
 * 5. **MeloTTS real**, solo si el contenedor responde en `TTS_MELO_URL`
 *    (default `http://localhost:8100`): audio WAV de verdad, el pitch
 *    aplicado y la cadena completa registro → pipeline →
 *    `GET /api/tts/audio/:id`. Si no responde, este bloque se **omite** con
 *    un aviso (y el gate pasa). Se puede omitir a mano con `SKIP_MELO_REAL=1`.
 *
 * No necesita `.env`, ni credenciales, ni puertos fijos propios.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import express from 'express';

import { createRepositories, openDatabase } from '../src/db/index.js';
import {
  AUDIO_MIME_TYPES,
  TTS_ENGINE_KINDS,
  TTS_ENGINE_NAMES,
  assertTtsEngine,
  createBrowserEngine,
  createTtsEngineRegistry,
  createTtsPipeline,
  createTtsRouter,
  formatVoiceId,
} from '../src/tts/index.js';
import {
  MELO_AUDIO_FORMAT,
  MELO_PITCH_MAX,
  MELO_PITCH_MIN,
  MELO_TIMBRE_MAX,
  MELO_TIMBRE_MIN,
  createMeloEngine,
  isMeloEnabled,
  meloBaseUrl,
  meloPitchFactor,
  meloTimbreFactor,
  pickMeloSpeaker,
  toMeloInputLine,
  toMeloSpeakerName,
  toMeloVoice,
} from '../src/tts/melo-engine.js';
import { buildWavHeader } from '../src/tts/piper-engine.js';

const SKIP_REAL = ['1', 'true', 'yes'].includes(String(process.env.SKIP_MELO_REAL ?? '').toLowerCase());

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-hub-melo-'));
const dbFile = path.join(tempDir, 'smoke.sqlite');

let failures = 0;
let checks = 0;
let skipped = 0;

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

const skip = (label, why) => {
  skipped += 1;
  console.log(`  --   ${label} (omitido: ${why})`);
};

/** Levanta la app Express en un puerto libre y devuelve un `fetch` con base. */
const startApp = async (app) => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
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

/** Lee la cabecera de un WAV PCM de 44 bytes. */
function readWavHeader(bytes) {
  return {
    riff: bytes.toString('ascii', 0, 4),
    wave: bytes.toString('ascii', 8, 12),
    audioFormat: bytes.readUInt16LE(20),
    channels: bytes.readUInt16LE(22),
    sampleRate: bytes.readUInt32LE(24),
    bitsPerSample: bytes.readUInt16LE(34),
    data: bytes.toString('ascii', 36, 40),
    dataLength: bytes.readUInt32LE(40),
  };
}

const wavSeconds = (bytes) => {
  const header = readWavHeader(bytes);
  return header.dataLength / 2 / header.sampleRate;
};

const toArrayBuffer = (buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

/**
 * Costura `fetchImpl` de mentira: responde `/health` y `/speak` sin tocar la
 * red, y respeta `AbortSignal` de verdad (para probar el timeout del motor).
 */
function fakeMeloFetch({
  speakers = ['ES'],
  language = 'es',
  healthOk = true,
  speakMode = 'ok',
  sampleRate = 24_000,
  channels = 1,
  bitsPerSample = 16,
  samples = 500,
} = {}) {
  const calls = [];
  const fetchImpl = (url, options = {}) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });

    if (url.endsWith('/health')) {
      if (!healthOk) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: 'ok', language, speakers }) });
    }

    if (url.endsWith('/speak')) {
      if (speakMode === 'fail') {
        return Promise.resolve({ ok: false, status: 500 });
      }
      if (speakMode === 'hang') {
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => {
            const error = new Error('The operation was aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
      }
      const pcm = Buffer.alloc(samples * 2);
      for (let i = 0; i < samples; i += 1) {
        pcm.writeInt16LE(((i * 37) % 20_000) - 10_000, i * 2);
      }
      const wav = Buffer.concat([buildWavHeader({ sampleRate, dataLength: pcm.length, channels, bitsPerSample }), pcm]);
      return Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => toArrayBuffer(wav) });
    }

    return Promise.reject(new Error(`fetch inesperado: ${url}`));
  };
  return { fetchImpl, calls };
}

async function main() {
  console.log('Humo del motor MeloTTS');
  console.log(`  temporales: ${tempDir}`);

  // ---------------------------------------------------------------- bloque 1
  section('lógica pura (sin red)');

  await check('el pitch se recorta al rango soportado', () => {
    assert.equal(meloPitchFactor(1), 1);
    assert.equal(meloPitchFactor(undefined), 1);
    assert.equal(meloPitchFactor(Number.NaN), 1);
    assert.equal(meloPitchFactor(0.8), 0.8);
    assert.equal(meloPitchFactor(1.4), MELO_PITCH_MAX);
    assert.equal(meloPitchFactor(0), MELO_PITCH_MIN);
    assert.equal(meloPitchFactor(9), MELO_PITCH_MAX);
  });

  await check('el timbre se recorta al rango soportado', () => {
    assert.equal(meloTimbreFactor(1), 1);
    assert.equal(meloTimbreFactor(undefined), 1);
    assert.equal(meloTimbreFactor(Number.NaN), 1);
    assert.equal(meloTimbreFactor(0.8), 0.8);
    assert.equal(meloTimbreFactor(1.4), MELO_TIMBRE_MAX);
    assert.equal(meloTimbreFactor(0), MELO_TIMBRE_MIN);
    assert.equal(meloTimbreFactor(9), MELO_TIMBRE_MAX);
  });

  await check('el id namespaced se convierte al nombre del locutor', () => {
    assert.equal(toMeloSpeakerName('melo:ES'), 'ES');
    assert.equal(toMeloSpeakerName('edge:es-MX-DaliaNeural'), null);
    assert.equal(toMeloSpeakerName(null), null, 'null = "elige tú"');
    assert.equal(toMeloSpeakerName('sin-namespace'), null);
  });

  await check('un locutor se mapea a TtsVoice con id melo:<locutor>', () => {
    const voice = toMeloVoice('ES', 'es');
    assert.equal(voice.id, 'melo:ES');
    assert.equal(voice.name, 'ES');
    assert.equal(voice.engine, TTS_ENGINE_NAMES.melo);
    assert.equal(voice.language, 'es');
    assert.equal(voice.label, 'MeloTTS ES (es)');
  });

  await check('elegir locutor: el pedido si existe, si no el primero', () => {
    assert.equal(pickMeloSpeaker(['ES'], 'melo:ES'), 'ES');
    assert.equal(pickMeloSpeaker(['ES', 'ES2'], null), 'ES', 'null = "elige tú"');
    assert.equal(pickMeloSpeaker(['ES', 'ES2'], 'edge:es-MX-DaliaNeural'), 'ES');
    assert.equal(pickMeloSpeaker(['ES'], 'melo:no-existe'), 'ES');
    assert.equal(pickMeloSpeaker([], 'melo:lo-que-sea'), null);
  });

  await check('el texto viaja en una sola línea', () => {
    assert.equal(toMeloInputLine('  hola  '), 'hola');
    assert.equal(toMeloInputLine('dos\nlíneas\r\ny tres'), 'dos líneas y tres');
  });

  await check('el motor se puede desactivar por entorno', () => {
    assert.equal(isMeloEnabled({}), true, 'por default está activo');
    for (const value of ['false', 'FALSE', '0', 'no']) {
      assert.equal(isMeloEnabled({ TTS_MELO_ENABLED: value }), false);
    }
    assert.equal(isMeloEnabled({ TTS_MELO_ENABLED: 'true' }), true);
    assert.equal(isMeloEnabled({ TTS_MELO_ENABLED: '   ' }), true, 'vacía = ausente');
  });

  await check('la URL base tiene un default y se puede mover por entorno', () => {
    assert.equal(meloBaseUrl({}), 'http://localhost:8100');
    assert.equal(meloBaseUrl({ TTS_MELO_URL: 'http://otra-maquina:9000' }), 'http://otra-maquina:9000');
  });

  // ---------------------------------------------------------------- bloque 2
  section('catálogo de voces (fetch de mentira)');

  await check('el motor cumple la interfaz TTSEngine y es de servidor', () => {
    const { fetchImpl } = fakeMeloFetch();
    const engine = createMeloEngine({ fetchImpl });
    assertTtsEngine(engine);
    assert.equal(engine.name, TTS_ENGINE_NAMES.melo);
    assert.equal(engine.kind, TTS_ENGINE_KINDS.server);
    assert.equal(typeof engine.synthesize, 'function');
  });

  await check('el catálogo lista lo que devuelve /health, namespaced', async () => {
    const { fetchImpl } = fakeMeloFetch({ speakers: ['ES'], language: 'es' });
    const engine = createMeloEngine({ fetchImpl });
    const voices = await engine.listVoices();
    assert.deepEqual(
      voices.map((voice) => voice.id),
      ['melo:ES'],
    );
    assert.equal(voices[0].language, 'es');
    assert.equal(await engine.isAvailable(), true);
  });

  await check('el catálogo se cachea: no se relanza /health en cada llamada', async () => {
    const { fetchImpl, calls } = fakeMeloFetch();
    const engine = createMeloEngine({ fetchImpl, voiceCacheTtlMs: 60_000 });
    await engine.listVoices();
    await engine.listVoices();
    await engine.isAvailable();
    assert.equal(calls.filter((call) => call.url.endsWith('/health')).length, 1, 'las tres comparten el catálogo cacheado');
  });

  // ---------------------------------------------------------------- bloque 3
  section('degradación limpia: contenedor caído o desactivado');

  await check('contenedor caído (HTTP 500): catálogo vacío, no una excepción', async () => {
    const { fetchImpl } = fakeMeloFetch({ healthOk: false });
    const engine = createMeloEngine({ fetchImpl });
    assert.deepEqual(await engine.listVoices(), []);
    assert.equal(await engine.isAvailable(), false);
  });

  await check('contenedor inalcanzable (fetch rechaza): catálogo vacío', async () => {
    const engine = createMeloEngine({ fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')) });
    assert.deepEqual(await engine.listVoices(), []);
    assert.equal(await engine.isAvailable(), false);
  });

  await check('desactivado por entorno: como si el contenedor no estuviera', async () => {
    const { fetchImpl } = fakeMeloFetch();
    const engine = createMeloEngine({ fetchImpl, env: { TTS_MELO_ENABLED: 'false' } });
    assert.deepEqual(await engine.listVoices(), []);
    assert.equal(await engine.isAvailable(), false);
  });

  await check('synthesize() lanza si el contenedor no tiene locutores', async () => {
    const { fetchImpl } = fakeMeloFetch({ speakers: [] });
    const engine = createMeloEngine({ fetchImpl });
    await assert.rejects(
      () => engine.synthesize({ text: 'hola', voiceId: null, pitch: 1 }),
      /docker compose up -d melotts/,
    );
  });

  await check('el catálogo agregado no se rompe: cero voces melo, las demás siguen', async () => {
    const registry = createTtsEngineRegistry({ engines: [createBrowserEngine()] });
    registry.register({
      name: 'otro',
      kind: TTS_ENGINE_KINDS.client,
      isAvailable: async () => true,
      listVoices: async () => [
        { id: formatVoiceId('otro', 'Ana'), name: 'Ana', engine: 'otro', language: 'es-ES', label: 'Ana' },
      ],
    });
    registry.register(createMeloEngine({ fetchImpl: () => Promise.reject(new Error('caído')) }));

    const voices = await registry.listVoices();
    assert.equal(voices.filter((voice) => voice.engine === TTS_ENGINE_NAMES.melo).length, 0);
    assert.equal(voices.length, 1, 'las de los otros motores siguen ahí');
    assert.ok(registry.has(TTS_ENGINE_NAMES.melo), 'el motor está registrado aunque el contenedor esté caído');
  });

  await check('GET /api/voices responde igual sin el contenedor arriba', async () => {
    const registry = createTtsEngineRegistry();
    registry.register(createMeloEngine({ fetchImpl: () => Promise.reject(new Error('caído')) }));
    const app = express();
    app.use('/api', createTtsRouter({ registry, serverAudio: { get: () => null } }));
    const server = await startApp(app);
    try {
      const response = await server.get('/api/voices');
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(
        body.voices.filter((voice) => voice.engine === TTS_ENGINE_NAMES.melo),
        [],
      );
      assert.deepEqual(
        body.engines.find((engine) => engine.name === TTS_ENGINE_NAMES.melo),
        { name: TTS_ENGINE_NAMES.melo, kind: TTS_ENGINE_KINDS.server },
      );
    } finally {
      await server.close();
    }
  });

  // ---------------------------------------------------------------- bloque 4
  section('síntesis (fetch de mentira: speed, WAV y fallos)');

  await check('sin texto no se ejecuta nada', async () => {
    const { fetchImpl, calls } = fakeMeloFetch();
    const engine = createMeloEngine({ fetchImpl });
    await assert.rejects(() => engine.synthesize({ text: '   ', voiceId: null }), /texto/);
    assert.equal(calls.filter((call) => call.url.endsWith('/speak')).length, 0);
  });

  await check('con pitch 1 se pide speed neutro y el WAV sale a la frecuencia nativa', async () => {
    const { fetchImpl, calls } = fakeMeloFetch({ samples: 500, sampleRate: 24_000 });
    const engine = createMeloEngine({ fetchImpl });
    const audio = await engine.synthesize({ text: 'hola chat', voiceId: 'melo:ES', pitch: 1, volume: 0.5 });

    const speakCall = calls.find((call) => call.url.endsWith('/speak'));
    assert.equal(speakCall.body.text, 'hola chat');
    assert.equal(speakCall.body.speaker, 'ES');
    assert.equal(speakCall.body.speed, 1);

    assert.equal(audio.format, MELO_AUDIO_FORMAT);
    const bytes = Buffer.from(audio.base64, 'base64');
    assert.equal(readWavHeader(bytes).sampleRate, 24_000);
    assert.equal(bytes.length, 44 + 1_000);
  });

  await check('el pitch sube la frecuencia y pide speed inverso para compensar', async () => {
    const { fetchImpl, calls } = fakeMeloFetch({ samples: 500, sampleRate: 24_000 });
    const engine = createMeloEngine({ fetchImpl });

    const agudo = await engine.synthesize({ text: 'hola', voiceId: null, pitch: 1.3 });
    assert.equal(calls.filter((call) => call.url.endsWith('/speak'))[0].body.speed, 1 / 1.3);
    assert.equal(readWavHeader(Buffer.from(agudo.base64, 'base64')).sampleRate, Math.round(24_000 * 1.3));

    const grave = await engine.synthesize({ text: 'hola', voiceId: null, pitch: 0.8 });
    assert.equal(calls.filter((call) => call.url.endsWith('/speak'))[1].body.speed, 1 / 0.8);
    assert.equal(readWavHeader(Buffer.from(grave.base64, 'base64')).sampleRate, Math.round(24_000 * 0.8));

    const extremo = await engine.synthesize({ text: 'hola', voiceId: null, pitch: 5 });
    assert.equal(calls.filter((call) => call.url.endsWith('/speak'))[2].body.speed, 1 / MELO_PITCH_MAX);
    assert.equal(readWavHeader(Buffer.from(extremo.base64, 'base64')).sampleRate, Math.round(24_000 * MELO_PITCH_MAX));
  });

  await check('si el contenedor responde con error, se rechaza', async () => {
    const { fetchImpl } = fakeMeloFetch({ speakMode: 'fail' });
    const engine = createMeloEngine({ fetchImpl });
    await assert.rejects(() => engine.synthesize({ text: 'hola', voiceId: null, pitch: 1 }), /respondió 500/);
  });

  await check('un contenedor colgado se corta por timeout (no congela la cola)', async () => {
    const { fetchImpl } = fakeMeloFetch({ speakMode: 'hang' });
    const engine = createMeloEngine({ fetchImpl, timeoutMs: 300 });
    const started = Date.now();
    await assert.rejects(() => engine.synthesize({ text: 'hola', voiceId: null, pitch: 1 }), /no se pudo hablar/);
    assert.ok(Date.now() - started < 4_000, 'debe cortar por su cuenta, no esperar al contenedor');
  });

  await check('pipeline: un usuario con voz melo recibe audio adjunto', async () => {
    const { fetchImpl } = fakeMeloFetch({ samples: 200 });
    const registry = createTtsEngineRegistry();
    registry.register(createMeloEngine({ fetchImpl }));
    const pipeline = createTtsPipeline({ registry, repositories });

    repos.users.upsert({ twitchUserId: '730', username: 'sole', displayName: 'Sole' });
    repos.users.updatePreferences('730', { voiceId: 'melo:ES', voiceSource: 'override' });

    const decision = pipeline.decide(makeMessage({ userId: '730', username: 'sole', text: 'hola con melo' }));
    assert.equal(decision.tts.engine, TTS_ENGINE_NAMES.melo);
    assert.equal(decision.tts.voiceId, 'melo:ES');
    assert.ok(decision.tts.audio.url.startsWith('/api/tts/audio/'), 'la trama sale al instante con la URL');

    const app = express();
    app.use('/api', createTtsRouter({ registry, serverAudio: pipeline.serverAudio }));
    const server = await startApp(app);
    try {
      const response = await server.get(decision.tts.audio.url);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), AUDIO_MIME_TYPES.wav);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(readWavHeader(bytes).riff, 'RIFF');
      assert.equal(bytes.length, 44 + 400);
    } finally {
      await server.close();
    }
  });

  // ---------------------------------------------------------------- bloque 5
  section('MeloTTS real (se omite si el contenedor no responde)');

  const realEngine = createMeloEngine();
  const realAvailable = !SKIP_REAL && (await realEngine.isAvailable());
  const realVoices = realAvailable ? await realEngine.listVoices() : [];

  if (!realAvailable) {
    const why = SKIP_REAL ? 'SKIP_MELO_REAL=1' : `contenedor no responde en ${meloBaseUrl()}; corre \`docker compose up -d melotts\``;
    skip('síntesis real con el contenedor de MeloTTS', why);
    skip('el pitch cambia la frecuencia sin cambiar mucho la duración', why);
    skip('una voz inexistente cae en el primer locutor', why);
    skip('cadena completa: registro real → pipeline → GET /api/tts/audio/:id', why);
  } else {
    console.log(`  (contenedor arriba: ${realVoices.map((voice) => voice.id).join(', ')})`);

    await check('síntesis real con el contenedor de MeloTTS', async () => {
      assert.ok(
        realVoices.some((voice) => String(voice.language ?? '').startsWith('es')),
        'debe haber al menos una voz en español',
      );
      const audio = await realEngine.synthesize({
        text: 'Hola chat, esto lo dice MeloTTS en un contenedor local.',
        voiceId: realVoices[0].id,
        pitch: 1,
        volume: 1,
      });
      assert.equal(audio.format, MELO_AUDIO_FORMAT);
      const bytes = Buffer.from(audio.base64, 'base64');
      const header = readWavHeader(bytes);
      assert.equal(header.riff, 'RIFF');
      assert.equal(header.wave, 'WAVE');
      assert.equal(header.audioFormat, 1);
      assert.equal(header.dataLength, bytes.length - 44);
      assert.ok(bytes.length > 20_000, `audio real, no un placeholder (${bytes.length} bytes)`);
      assert.ok(wavSeconds(bytes) > 1, `debe durar más de un segundo (${wavSeconds(bytes).toFixed(2)} s)`);
    });

    await check('el pitch cambia la frecuencia sin cambiar mucho la duración', async () => {
      const text = 'Una frase de prueba para medir el tono.';
      const [neutro, agudo] = await Promise.all([
        realEngine.synthesize({ text, voiceId: realVoices[0].id, pitch: 1 }),
        realEngine.synthesize({ text, voiceId: realVoices[0].id, pitch: 1.3 }),
      ]);
      const neutroBytes = Buffer.from(neutro.base64, 'base64');
      const agudoBytes = Buffer.from(agudo.base64, 'base64');
      const neutroRate = readWavHeader(neutroBytes).sampleRate;
      assert.equal(readWavHeader(agudoBytes).sampleRate, Math.round(neutroRate * 1.3));
      const ratio = wavSeconds(agudoBytes) / wavSeconds(neutroBytes);
      assert.ok(
        ratio > 0.7 && ratio < 1.2,
        `la duración debe quedar parecida, no cambiar con el tono (ratio ${ratio.toFixed(3)})`,
      );
    });

    await check('una voz inexistente cae en el primer locutor', async () => {
      const audio = await realEngine.synthesize({ text: 'sigo hablando', voiceId: 'melo:no-existe' });
      assert.ok(Buffer.from(audio.base64, 'base64').length > 10_000);
    });

    await check('cadena completa: registro real → pipeline → GET /api/tts/audio/:id', async () => {
      const registry = createTtsEngineRegistry();
      registry.register(createMeloEngine());
      const pipeline = createTtsPipeline({ registry, repositories });

      repos.users.upsert({ twitchUserId: '731', username: 'tincho', displayName: 'Tincho' });
      repos.users.updatePreferences('731', { voiceId: realVoices[0].id, voiceSource: 'override' });

      const app = express();
      app.use('/api', createTtsRouter({ registry, serverAudio: pipeline.serverAudio }));
      const server = await startApp(app);
      try {
        const decision = pipeline.decide(
          makeMessage({ userId: '731', username: 'tincho', text: 'esto se sintetiza de verdad, con MeloTTS' }),
        );
        assert.equal(decision.tts.engine, TTS_ENGINE_NAMES.melo);
        const response = await server.get(decision.tts.audio.url);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), AUDIO_MIME_TYPES.wav);
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.equal(readWavHeader(bytes).riff, 'RIFF');
        assert.ok(bytes.length > 20_000, `${bytes.length} bytes`);
      } finally {
        await server.close();
      }
    });
  }

  const suffix = skipped === 0 ? '' : ` (${skipped} omitidas: sin contenedor)`;
  console.log(`\n${failures === 0 ? 'TODO OK' : 'HAY FALLOS'}: ${checks - failures}/${checks} comprobaciones${suffix}`);
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
