/**
 * Pruebas de humo del motor SAPI (voces de Windows, nativas o de terceros como
 * Loquendo):
 *
 *   npm --prefix backend run test:sapi
 *
 * **Corre igual en Windows y fuera de Windows**, porque eso es justo lo que hay
 * que garantizar: fuera de Windows (o con el motor desactivado) el catálogo sale
 * vacío y el resto del sistema sigue igual — la misma degradación limpia que
 * Piper sin instalar.
 *
 * Cinco bloques:
 *
 * 1. **Lógica pura**: recorte de pitch, la curva pitch→`Rate` de SAPI, ids
 *    namespaded, mapeo a `TtsVoice`, la elección de voz y la bandera de
 *    entorno. Nada de esto toca disco ni red.
 * 2. **Catálogo** con un PowerShell de mentira (un script de Node que imita su
 *    salida JSON): qué voces se ven y cómo se cachean.
 * 3. **Degradación limpia**: fuera de Windows, desactivado por entorno, o sin
 *    voces instaladas, el catálogo sale vacío, `GET /api/voices` sigue
 *    respondiendo con las voces de los demás motores, y solo `synthesize()`
 *    lanza (para que lea el navegador).
 * 4. **Síntesis con un PowerShell de mentira**: fija la voz, el `Rate` y el
 *    texto (por `stdin`) que se le mandan, el WAV que resulta, y los tres
 *    modos de fallo (error, colgado → timeout, plataforma sin soporte).
 * 5. **SAPI real**, solo en Windows y con al menos una voz instalada: audio WAV
 *    de verdad, el pitch aplicado y la cadena completa registro → pipeline →
 *    `GET /api/tts/audio/:id`. Fuera de Windows este bloque se **omite** con un
 *    aviso (y el gate pasa). Se puede omitir a mano con `SKIP_SAPI_REAL=1`.
 *
 * No necesita `.env`, ni credenciales, ni red, ni puertos fijos.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
  SAPI_AUDIO_FORMAT,
  SAPI_PITCH_MAX,
  SAPI_PITCH_MIN,
  SAPI_TIMBRE_MAX,
  SAPI_TIMBRE_MIN,
  SAPI_TIMBRE_RATE_LIMIT,
  createLoquendoEngine,
  createSapiEngine,
  isLoquendoEnabled,
  isSapiEnabled,
  pickSapiVoice,
  resolvePowerShellBinary,
  sapiPitchFactor,
  sapiRateFromSpeed,
  sapiTimbreRateDelta,
  toSapiInputLine,
  toSapiVoice,
  toSapiVoiceName,
} from '../src/tts/sapi-engine.js';

const SKIP_REAL = ['1', 'true', 'yes'].includes(String(process.env.SKIP_SAPI_REAL ?? '').toLowerCase());

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-hub-sapi-'));
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

/**
 * Script de Node que imita al PowerShell de listado: según el modo, imprime el
 * JSON pedido, no imprime nada, sale con error, o se cuelga. Se invoca a través
 * de la costura `spawnImpl`, así que funciona igual en macOS y en Windows.
 */
const fakePsList = path.join(tempDir, 'fake-ps-list.mjs');
fs.writeFileSync(
  fakePsList,
  `const [mode, payload] = process.argv.slice(2);
if (mode === 'fail') process.exit(1);
else if (mode === 'empty') process.exit(0);
else if (mode === 'hang') setInterval(() => {}, 1000);
else { process.stdout.write(payload ?? '', () => process.exit(0)); }
`,
);

/** Costura `spawnImpl` para `listInstalledSapiVoices()`: ignora el binario real y lanza el script de mentira. */
function fakeListSpawn(mode, payload) {
  return () => spawn(process.execPath, [fakePsList, mode, payload ?? ''], { stdio: ['ignore', 'pipe', 'pipe'] });
}

const SABINA = { Name: 'Microsoft Sabina Desktop', Culture: 'es-MX', Gender: 'Female', Vendor: 'Microsoft' };
const ZIRA = { Name: 'Microsoft Zira Desktop', Culture: 'en-US', Gender: 'Female', Vendor: 'Microsoft' };
const JORGE = { Name: 'Jorge', Culture: 'es-ES_tradnl', Gender: 'Male', Vendor: 'Loquendo' };
const CARMEN = { Name: 'Carmen', Culture: 'es-ES_tradnl', Gender: 'Female', Vendor: 'Loquendo' };

/**
 * Script de Node que imita al PowerShell de síntesis: lee el texto por `stdin`
 * (igual que el real), lo vuelca a `textFile` para que la prueba lo pueda leer,
 * y según el modo escribe un WAV de verdad en `outputFile`, no escribe nada, o
 * se cuelga.
 */
const fakePsSpeak = path.join(tempDir, 'fake-ps-speak.mjs');
fs.writeFileSync(
  fakePsSpeak,
  `import fs from 'node:fs';
const [mode, outputFile, textFile, samplesArg, sampleRateArg, channelsArg, bitsArg] = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(textFile, input);
  if (mode === 'fail') { process.stderr.write('no se pudo hablar\\n'); process.exit(1); }
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  const samples = Number.parseInt(samplesArg, 10);
  const sampleRate = Number.parseInt(sampleRateArg, 10);
  const channels = Number.parseInt(channelsArg, 10);
  const bitsPerSample = Number.parseInt(bitsArg, 10);
  const bytesPerSample = (bitsPerSample / 8) * channels;
  const dataLength = samples * bytesPerSample;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * bytesPerSample, 28);
  header.writeUInt16LE(bytesPerSample, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLength, 40);
  const pcm = Buffer.alloc(dataLength);
  for (let i = 0; i < samples; i += 1) {
    pcm.writeInt16LE(((i * 37) % 20000) - 10000, i * 2);
  }
  fs.writeFileSync(outputFile, Buffer.concat([header, pcm]));
  process.exit(0);
});
`,
);

let fakeSpeakSeq = 0;
/**
 * Costura `spawnImpl` para `synthesize()`: el motor real arma el script de
 * PowerShell como un único string (`SelectVoice`, `Rate`, `SetOutputToWaveFile`)
 * y lo pasa por `-Command`; acá se lee ese string con regex para saber qué le
 * pidió el motor, y se lanza el script de mentira de arriba con esos mismos
 * datos ya resueltos (así el script de mentira no tiene que parsear PowerShell).
 */
function fakeSpeakSpawn({ mode = 'ok', sampleRate = 22_050, channels = 1, bitsPerSample = 16, samples = 500 } = {}) {
  const calls = [];
  const spawnImpl = (binary, args) => {
    fakeSpeakSeq += 1;
    const script = args[3];
    const voice = /SelectVoice\('([^']*)'\)/.exec(script)?.[1] ?? null;
    const rate = /\.Rate = (-?\d+);/.exec(script)?.[1] ?? null;
    const outputFile = /SetOutputToWaveFile\('([^']*)'\)/.exec(script)?.[1] ?? null;
    const textFile = path.join(tempDir, `fake-speak-text-${fakeSpeakSeq}.txt`);
    const call = {
      voice,
      rate: rate === null ? null : Number(rate),
      outputFile,
      get text() {
        return fs.existsSync(textFile) ? fs.readFileSync(textFile, 'utf8') : null;
      },
    };
    calls.push(call);
    const child = spawn(
      process.execPath,
      [fakePsSpeak, mode, outputFile, textFile, String(samples), String(sampleRate), String(channels), String(bitsPerSample)],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const originalKill = child.kill.bind(child);
    child.kill = (signal) => {
      child.wasKilled = true;
      return originalKill(signal);
    };
    call.child = child;
    return child;
  };
  return { spawnImpl, calls };
}

async function main() {
  console.log('Humo del motor SAPI');
  console.log(`  temporales: ${tempDir}`);

  // ---------------------------------------------------------------- bloque 1
  section('lógica pura (sin disco ni red)');

  await check('el pitch se recorta al rango soportado', () => {
    assert.equal(sapiPitchFactor(1), 1);
    assert.equal(sapiPitchFactor(undefined), 1);
    assert.equal(sapiPitchFactor(Number.NaN), 1);
    // El rango que reparte T-011 entre usuarios (0.8–1.4).
    assert.equal(sapiPitchFactor(0.8), 0.8);
    assert.equal(sapiPitchFactor(1.4), SAPI_PITCH_MAX);
    assert.equal(sapiPitchFactor(0), SAPI_PITCH_MIN);
    assert.equal(sapiPitchFactor(9), SAPI_PITCH_MAX);
  });

  await check('la curva pitch→Rate: 1.0 es neutro y se recorta a -10..10', () => {
    // `Math.round(-0.1806)` da `-0`: distinto de `0` para `assert.equal` (usa
    // `Object.is`), igual para todo lo demás (`-0 === 0`, y en un template
    // string `${-0}` da `"0"`). Se compara con `===` a propósito.
    assert.ok(sapiRateFromSpeed(1) === 0, 'pitch neutro = Rate 0');
    assert.ok(sapiRateFromSpeed(undefined) === 0);
    assert.ok(sapiRateFromSpeed(0) === 0, 'una razón inválida no rompe: cae al neutro');
    assert.ok(sapiRateFromSpeed(2) > 0, 'más rápido = Rate positivo');
    assert.ok(sapiRateFromSpeed(0.5) < 0, 'más lento = Rate negativo');
    assert.equal(sapiRateFromSpeed(1000), 10, 'se recorta arriba');
    assert.equal(sapiRateFromSpeed(0.0001), -10, 'se recorta abajo');
  });

  await check('el timbre se recorta al rango soportado', () => {
    assert.equal(sapiTimbreRateDelta(1), 0);
    assert.equal(sapiTimbreRateDelta(undefined), 0);
    assert.equal(sapiTimbreRateDelta(Number.NaN), 0);
  });

  await check('la curva timbre→Rate: 1.0 es neutro exacto (rango asimétrico, ver comentario del código)', () => {
    assert.equal(sapiTimbreRateDelta(1), 0, 'el punto neutro tiene que dar 0 exacto, no -1 por redondeo');
    assert.ok(sapiTimbreRateDelta(SAPI_TIMBRE_MAX) > 0, 'más timbre = Rate positivo');
    assert.ok(sapiTimbreRateDelta(SAPI_TIMBRE_MIN) < 0, 'menos timbre = Rate negativo');
    assert.equal(sapiTimbreRateDelta(SAPI_TIMBRE_MAX), SAPI_TIMBRE_RATE_LIMIT, 'se recorta arriba al límite');
    assert.equal(sapiTimbreRateDelta(SAPI_TIMBRE_MIN), -SAPI_TIMBRE_RATE_LIMIT, 'se recorta abajo al límite');
    assert.equal(sapiTimbreRateDelta(9), SAPI_TIMBRE_RATE_LIMIT, 'un valor absurdo se recorta, no rompe');
    assert.equal(sapiTimbreRateDelta(-9), -SAPI_TIMBRE_RATE_LIMIT);
  });

  await check('fuera de Windows se usa "powershell" del PATH sin tocar disco', () => {
    assert.equal(resolvePowerShellBinary('darwin', {}), 'powershell');
    assert.equal(resolvePowerShellBinary('linux', {}), 'powershell');
  });

  await check('el id namespaced se convierte al nombre de la voz', () => {
    assert.equal(toSapiVoiceName('sapi:Microsoft Sabina Desktop'), 'Microsoft Sabina Desktop');
    assert.equal(toSapiVoiceName('edge:es-MX-DaliaNeural'), null);
    assert.equal(toSapiVoiceName(null), null, 'null = "elige tú"');
    assert.equal(toSapiVoiceName('sin-namespace'), null);
  });

  await check('una voz de Windows se mapea a TtsVoice con id sapi:<nombre>', () => {
    const voice = toSapiVoice(SABINA);
    assert.equal(voice.id, 'sapi:Microsoft Sabina Desktop');
    assert.equal(voice.name, 'Microsoft Sabina Desktop');
    assert.equal(voice.engine, TTS_ENGINE_NAMES.sapi);
    assert.equal(voice.language, 'es-MX');
    assert.equal(voice.label, 'Microsoft Sabina Desktop (es-MX, mujer)');

    const sinMeta = toSapiVoice({ Name: 'Voz Rara' });
    assert.equal(sinMeta.language, null);
    assert.equal(sinMeta.label, 'Voz Rara', 'sin cultura ni género no quedan paréntesis vacíos');
  });

  await check('elegir voz: la pedida, y si no está, la mejor en español', () => {
    const voices = [ZIRA, SABINA];
    assert.equal(pickSapiVoice(voices, 'sapi:Microsoft Zira Desktop').Name, ZIRA.Name);
    // Voz de otro motor o `null`: se prefiere español.
    assert.equal(pickSapiVoice(voices, null).Name, SABINA.Name);
    assert.equal(pickSapiVoice(voices, 'edge:es-MX-DaliaNeural').Name, SABINA.Name);
    // Una voz que ya no está instalada no manda el mensaje al navegador.
    assert.equal(pickSapiVoice(voices, 'sapi:No Existe').Name, SABINA.Name);
    assert.equal(pickSapiVoice([], 'sapi:lo-que-sea'), null);
  });

  await check('el texto viaja en una sola línea', () => {
    assert.equal(toSapiInputLine('  hola  '), 'hola');
    assert.equal(toSapiInputLine('dos\nlíneas\r\ny tres'), 'dos líneas y tres');
  });

  await check('el motor se puede desactivar por entorno (sapi y loquendo, aparte)', () => {
    assert.equal(isSapiEnabled({}), true, 'por default está activo');
    assert.equal(isLoquendoEnabled({}), true, 'por default está activo');
    for (const value of ['false', 'FALSE', '0', 'no']) {
      assert.equal(isSapiEnabled({ TTS_SAPI_ENABLED: value }), false);
      assert.equal(isLoquendoEnabled({ TTS_LOQUENDO_ENABLED: value }), false);
    }
    assert.equal(isSapiEnabled({ TTS_SAPI_ENABLED: 'true' }), true);
    assert.equal(isSapiEnabled({ TTS_SAPI_ENABLED: '   ' }), true, 'vacía = ausente');
    // Son independientes: apagar uno no apaga el otro.
    assert.equal(isLoquendoEnabled({ TTS_SAPI_ENABLED: 'false' }), true);
    assert.equal(isSapiEnabled({ TTS_LOQUENDO_ENABLED: 'false' }), true);
  });

  await check('toSapiVoice/pickSapiVoice aceptan el namespace de loquendo', () => {
    const voice = toSapiVoice(JORGE, TTS_ENGINE_NAMES.loquendo);
    assert.equal(voice.id, 'loquendo:Jorge');
    assert.equal(voice.engine, TTS_ENGINE_NAMES.loquendo);

    assert.equal(toSapiVoiceName('loquendo:Jorge', TTS_ENGINE_NAMES.loquendo), 'Jorge');
    assert.equal(toSapiVoiceName('sapi:Jorge', TTS_ENGINE_NAMES.loquendo), null, 'namespace equivocado no cuenta');

    assert.equal(pickSapiVoice([JORGE, CARMEN], 'loquendo:Carmen', TTS_ENGINE_NAMES.loquendo).Name, CARMEN.Name);
  });

  // ---------------------------------------------------------------- bloque 2
  section('catálogo de voces (PowerShell de mentira)');

  await check('el motor cumple la interfaz TTSEngine y es de servidor', () => {
    const engine = createSapiEngine({ platform: 'win32', spawnImpl: fakeListSpawn('ok', '[]') });
    assertTtsEngine(engine);
    assert.equal(engine.name, TTS_ENGINE_NAMES.sapi);
    assert.equal(engine.kind, TTS_ENGINE_KINDS.server);
    assert.equal(typeof engine.synthesize, 'function');
  });

  await check('el catálogo lista lo que devuelve PowerShell, namespaced', async () => {
    const engine = createSapiEngine({
      platform: 'win32',
      spawnImpl: fakeListSpawn('ok', JSON.stringify([SABINA, ZIRA])),
    });
    const voices = await engine.listVoices();
    assert.deepEqual(
      voices.map((voice) => voice.id),
      ['sapi:Microsoft Sabina Desktop', 'sapi:Microsoft Zira Desktop'],
    );
    assert.equal(await engine.isAvailable(), true);
  });

  await check('una sola voz también sale como array (ConvertTo-Json no la desenrolla)', async () => {
    const engine = createSapiEngine({ platform: 'win32', spawnImpl: fakeListSpawn('ok', JSON.stringify(SABINA)) });
    const voices = await engine.listVoices();
    assert.equal(voices.length, 1);
    assert.equal(voices[0].id, 'sapi:Microsoft Sabina Desktop');
  });

  await check('el catálogo se cachea: no se relanza PowerShell en cada llamada', async () => {
    let calls = 0;
    const spawnImpl = (...args) => {
      calls += 1;
      return fakeListSpawn('ok', JSON.stringify([SABINA]))(...args);
    };
    const engine = createSapiEngine({ platform: 'win32', spawnImpl, voiceCacheTtlMs: 60_000 });
    await engine.listVoices();
    await engine.listVoices();
    await engine.isAvailable();
    assert.equal(calls, 1, 'las tres llamadas comparten el catálogo cacheado');
  });

  await check('sapi y loquendo separan el mismo catálogo de PowerShell por Vendor', async () => {
    const mixedPayload = JSON.stringify([SABINA, JORGE, ZIRA, CARMEN]);

    const sapi = createSapiEngine({ platform: 'win32', spawnImpl: fakeListSpawn('ok', mixedPayload) });
    const sapiVoices = await sapi.listVoices();
    assert.deepEqual(
      sapiVoices.map((voice) => voice.id),
      ['sapi:Microsoft Sabina Desktop', 'sapi:Microsoft Zira Desktop'],
      'sapi no lista las voces Loquendo',
    );

    const loquendo = createLoquendoEngine({ platform: 'win32', spawnImpl: fakeListSpawn('ok', mixedPayload) });
    const loquendoVoices = await loquendo.listVoices();
    assert.deepEqual(
      loquendoVoices.map((voice) => voice.id),
      ['loquendo:Jorge', 'loquendo:Carmen'],
      'loquendo solo lista las de Vendor Loquendo',
    );
    assert.equal(loquendo.name, TTS_ENGINE_NAMES.loquendo);
  });

  await check('sin voces Loquendo instaladas, el motor loquendo sale vacío (no un error)', async () => {
    const loquendo = createLoquendoEngine({
      platform: 'win32',
      spawnImpl: fakeListSpawn('ok', JSON.stringify([SABINA, ZIRA])),
    });
    assert.deepEqual(await loquendo.listVoices(), []);
    assert.equal(await loquendo.isAvailable(), false);
  });

  // ---------------------------------------------------------------- bloque 3
  section('degradación limpia: sin Windows, sin voces, o desactivado');

  await check('fuera de Windows no hay voces ni error, y ni se llama a PowerShell', async () => {
    let called = false;
    const spawnImpl = (...args) => {
      called = true;
      return fakeListSpawn('ok', JSON.stringify([SABINA]))(...args);
    };
    const engine = createSapiEngine({ platform: 'darwin', spawnImpl });
    assert.deepEqual(await engine.listVoices(), []);
    assert.equal(await engine.isAvailable(), false);
    assert.equal(called, false, 'no tiene sentido preguntarle a PowerShell fuera de Windows');
  });

  await check('Windows sin voces instaladas: catálogo vacío', async () => {
    const engine = createSapiEngine({ platform: 'win32', spawnImpl: fakeListSpawn('empty') });
    assert.deepEqual(await engine.listVoices(), []);
    assert.equal(await engine.isAvailable(), false);
  });

  await check('PowerShell falla o da JSON roto: catálogo vacío, no una excepción', async () => {
    const conError = createSapiEngine({ platform: 'win32', spawnImpl: fakeListSpawn('fail') });
    assert.deepEqual(await conError.listVoices(), []);

    const conJsonRoto = createSapiEngine({ platform: 'win32', spawnImpl: fakeListSpawn('ok', '{ esto no es json') });
    assert.deepEqual(await conJsonRoto.listVoices(), []);
  });

  await check('desactivado por entorno: como si no hubiera voces', async () => {
    const engine = createSapiEngine({
      platform: 'win32',
      env: { TTS_SAPI_ENABLED: 'false' },
      spawnImpl: fakeListSpawn('ok', JSON.stringify([SABINA])),
    });
    assert.deepEqual(await engine.listVoices(), []);
    assert.equal(await engine.isAvailable(), false);
  });

  await check('synthesize() sí lanza fuera de Windows, para que lea el navegador', async () => {
    const engine = createSapiEngine({ platform: 'darwin' });
    await assert.rejects(
      () => engine.synthesize({ text: 'hola', voiceId: 'sapi:Microsoft Sabina Desktop', pitch: 1 }),
      /sapi/,
    );
  });

  await check('synthesize() lanza si Windows no tiene ninguna voz instalada', async () => {
    const engine = createSapiEngine({ platform: 'win32', spawnImpl: fakeListSpawn('empty') });
    await assert.rejects(() => engine.synthesize({ text: 'hola', voiceId: null, pitch: 1 }), /ninguna voz instalada/);
  });

  await check('el catálogo agregado no se rompe: cero voces sapi, las demás siguen', async () => {
    const registry = createTtsEngineRegistry({ engines: [createBrowserEngine()] });
    registry.register({
      name: 'otro',
      kind: TTS_ENGINE_KINDS.client,
      isAvailable: async () => true,
      listVoices: async () => [
        { id: formatVoiceId('otro', 'Ana'), name: 'Ana', engine: 'otro', language: 'es-ES', label: 'Ana' },
      ],
    });
    registry.register(createSapiEngine({ platform: 'darwin' }));

    const voices = await registry.listVoices();
    assert.equal(
      voices.filter((voice) => voice.engine === TTS_ENGINE_NAMES.sapi).length,
      0,
      'las voces de sapi simplemente no aparecen',
    );
    assert.equal(voices.length, 1, 'las de los otros motores siguen ahí');
    assert.ok(registry.has(TTS_ENGINE_NAMES.sapi), 'el motor está registrado aunque no haya voces');
  });

  await check('GET /api/voices responde igual sin voces sapi', async () => {
    const registry = createTtsEngineRegistry();
    registry.register(createSapiEngine({ platform: 'darwin' }));
    const app = express();
    app.use('/api', createTtsRouter({ registry, serverAudio: { get: () => null } }));
    const server = await startApp(app);
    try {
      const response = await server.get('/api/voices');
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(
        body.voices.filter((voice) => voice.engine === TTS_ENGINE_NAMES.sapi),
        [],
      );
      assert.deepEqual(
        body.engines.find((engine) => engine.name === TTS_ENGINE_NAMES.sapi),
        { name: TTS_ENGINE_NAMES.sapi, kind: TTS_ENGINE_KINDS.server },
      );
    } finally {
      await server.close();
    }
  });

  await check('GET /api/voices lista las voces sapi en cuanto hay', async () => {
    const registry = createTtsEngineRegistry();
    registry.register(createSapiEngine({ platform: 'win32', spawnImpl: fakeListSpawn('ok', JSON.stringify([SABINA, ZIRA])) }));
    const app = express();
    app.use('/api', createTtsRouter({ registry, serverAudio: { get: () => null } }));
    const server = await startApp(app);
    try {
      const body = await (await server.get('/api/voices')).json();
      const sapiVoices = body.voices.filter((voice) => voice.engine === TTS_ENGINE_NAMES.sapi);
      assert.deepEqual(
        sapiVoices.map((voice) => voice.id),
        ['sapi:Microsoft Sabina Desktop', 'sapi:Microsoft Zira Desktop'],
      );
    } finally {
      await server.close();
    }
  });

  // ---------------------------------------------------------------- bloque 4
  section('síntesis (PowerShell de mentira: voz, Rate, texto por stdin, WAV y fallos)');

  /** Costura combinada: listado con `fakeListSpawn`, síntesis con `fakeSpeakSpawn`. */
  function combinedSpawn(listPayload, speakFake) {
    return (binary, args, options) => {
      const isSpeak = typeof args[3] === 'string' && args[3].includes('SetOutputToWaveFile');
      return isSpeak ? speakFake.spawnImpl(binary, args, options) : fakeListSpawn('ok', listPayload)(binary, args, options);
    };
  }

  await check('sin texto no se ejecuta nada', async () => {
    const speakFake = fakeSpeakSpawn();
    const engine = createSapiEngine({ platform: 'win32', spawnImpl: combinedSpawn(JSON.stringify([SABINA]), speakFake) });
    await assert.rejects(() => engine.synthesize({ text: '   ', voiceId: 'sapi:Microsoft Sabina Desktop' }), /texto/);
    assert.equal(speakFake.calls.length, 0);
  });

  await check('se le pasan la voz pedida, Rate neutro y el texto por stdin con pitch 1', async () => {
    const speakFake = fakeSpeakSpawn({ samples: 500, sampleRate: 22_050 });
    const engine = createSapiEngine({
      platform: 'win32',
      spawnImpl: combinedSpawn(JSON.stringify([SABINA, ZIRA]), speakFake),
    });
    const audio = await engine.synthesize({ text: 'hola chat', voiceId: 'sapi:Microsoft Zira Desktop', pitch: 1, volume: 0.5 });

    assert.equal(speakFake.calls.length, 1);
    assert.equal(speakFake.calls[0].voice, 'Microsoft Zira Desktop');
    assert.equal(speakFake.calls[0].rate, 0, 'pitch neutro = Rate 0');
    assert.equal(speakFake.calls[0].text, 'hola chat');

    assert.equal(audio.format, SAPI_AUDIO_FORMAT);
    const bytes = Buffer.from(audio.base64, 'base64');
    assert.equal(readWavHeader(bytes).sampleRate, 22_050);
    assert.equal(bytes.length, 44 + 1_000);
  });

  await check('el pitch sube la frecuencia y pide un Rate inverso para compensar', async () => {
    const speakFake = fakeSpeakSpawn({ samples: 500, sampleRate: 22_050 });
    const engine = createSapiEngine({ platform: 'win32', spawnImpl: combinedSpawn(JSON.stringify([SABINA]), speakFake) });

    const agudo = await engine.synthesize({ text: 'hola', voiceId: null, pitch: 1.3 });
    assert.equal(speakFake.calls[0].rate, sapiRateFromSpeed(1 / 1.3), 'habla más despacio en la proporción inversa');
    assert.equal(readWavHeader(Buffer.from(agudo.base64, 'base64')).sampleRate, Math.round(22_050 * 1.3));

    const grave = await engine.synthesize({ text: 'hola', voiceId: null, pitch: 0.8 });
    assert.equal(speakFake.calls[1].rate, sapiRateFromSpeed(1 / 0.8));
    assert.equal(readWavHeader(Buffer.from(grave.base64, 'base64')).sampleRate, Math.round(22_050 * 0.8));

    // Fuera de rango se recorta, y eso se ve en los dos números a la vez.
    const extremo = await engine.synthesize({ text: 'hola', voiceId: null, pitch: 5 });
    assert.equal(speakFake.calls[2].rate, sapiRateFromSpeed(1 / SAPI_PITCH_MAX));
    assert.equal(readWavHeader(Buffer.from(extremo.base64, 'base64')).sampleRate, Math.round(22_050 * SAPI_PITCH_MAX));
  });

  await check('si SAPI falla, se rechaza con su mensaje de error', async () => {
    const speakFake = fakeSpeakSpawn({ mode: 'fail' });
    const engine = createSapiEngine({ platform: 'win32', spawnImpl: combinedSpawn(JSON.stringify([SABINA]), speakFake) });
    await assert.rejects(
      () => engine.synthesize({ text: 'hola', voiceId: null, pitch: 1 }),
      /no se pudo hablar/,
    );
  });

  await check('un SAPI colgado se mata por timeout (no congela la cola)', async () => {
    const speakFake = fakeSpeakSpawn({ mode: 'hang' });
    const engine = createSapiEngine({
      platform: 'win32',
      spawnImpl: combinedSpawn(JSON.stringify([SABINA]), speakFake),
      timeoutMs: 400,
    });
    const started = Date.now();
    await assert.rejects(() => engine.synthesize({ text: 'hola', voiceId: null, pitch: 1 }), /no terminó en 400 ms/);
    assert.ok(Date.now() - started < 4_000, 'debe cortar por su cuenta, no esperar a PowerShell');
    assert.equal(speakFake.calls[0].child.wasKilled, true, 'se mata el proceso colgado');
  });

  await check('pipeline: un usuario con voz sapi recibe audio adjunto', async () => {
    const speakFake = fakeSpeakSpawn({ samples: 200 });
    const registry = createTtsEngineRegistry();
    registry.register(createSapiEngine({ platform: 'win32', spawnImpl: combinedSpawn(JSON.stringify([SABINA]), speakFake) }));
    const pipeline = createTtsPipeline({ registry, repositories });

    repos.users.upsert({ twitchUserId: '720', username: 'nico', displayName: 'Nico' });
    repos.users.updatePreferences('720', { voiceId: 'sapi:Microsoft Sabina Desktop', voiceSource: 'override' });

    const decision = pipeline.decide(makeMessage({ userId: '720', username: 'nico', text: 'hola con sapi' }));
    assert.equal(decision.tts.engine, TTS_ENGINE_NAMES.sapi);
    assert.equal(decision.tts.voiceId, 'sapi:Microsoft Sabina Desktop');
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
  section('SAPI real (se omite fuera de Windows o sin voces)');

  const realEngine = createSapiEngine();
  const realAvailable = !SKIP_REAL && (await realEngine.isAvailable());
  const realVoices = realAvailable ? await realEngine.listVoices() : [];

  if (!realAvailable) {
    const why =
      SKIP_REAL
        ? 'SKIP_SAPI_REAL=1'
        : process.platform !== 'win32'
          ? `SAPI es de Windows (esta máquina es ${process.platform})`
          : 'Windows sin voces instaladas';
    skip('síntesis real con una voz de Windows', why);
    skip('el pitch cambia la frecuencia sin cambiar mucho la duración', why);
    skip('una voz inexistente cae en otra voz instalada', why);
    skip('cadena completa: registro real → pipeline → GET /api/tts/audio/:id', why);
  } else {
    console.log(`  (instaladas: ${realVoices.map((voice) => voice.id).join(', ')})`);

    await check('síntesis real con una voz de Windows', async () => {
      const audio = await realEngine.synthesize({
        text: 'Hola chat, esto lo dice una voz de Windows en local.',
        voiceId: realVoices[0].id,
        pitch: 1,
        volume: 1,
      });
      assert.equal(audio.format, SAPI_AUDIO_FORMAT);
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

    await check('una voz inexistente cae en otra voz instalada', async () => {
      const audio = await realEngine.synthesize({ text: 'sigo hablando', voiceId: 'sapi:No Existe' });
      assert.ok(Buffer.from(audio.base64, 'base64').length > 10_000);
    });

    await check('cadena completa: registro real → pipeline → GET /api/tts/audio/:id', async () => {
      const registry = createTtsEngineRegistry();
      registry.register(createSapiEngine());
      const pipeline = createTtsPipeline({ registry, repositories });

      repos.users.upsert({ twitchUserId: '721', username: 'vale', displayName: 'Vale' });
      repos.users.updatePreferences('721', { voiceId: realVoices[0].id, voiceSource: 'override' });

      const app = express();
      app.use('/api', createTtsRouter({ registry, serverAudio: pipeline.serverAudio }));
      const server = await startApp(app);
      try {
        const decision = pipeline.decide(
          makeMessage({ userId: '721', username: 'vale', text: 'esto se sintetiza de verdad, con Windows' }),
        );
        assert.equal(decision.tts.engine, TTS_ENGINE_NAMES.sapi);
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

  section('Loquendo real (se omite si no está instalado)');

  const realLoquendo = createLoquendoEngine();
  const loquendoAvailable = !SKIP_REAL && (await realLoquendo.isAvailable());
  const loquendoVoices = loquendoAvailable ? await realLoquendo.listVoices() : [];

  if (!loquendoAvailable) {
    const why = SKIP_REAL ? 'SKIP_SAPI_REAL=1' : 'Loquendo TTS no está instalado en esta máquina';
    skip('las voces Loquendo quedan separadas de las de Windows en /api/voices', why);
    skip('síntesis real con una voz Loquendo', why);
  } else {
    console.log(`  (Loquendo instalado: ${loquendoVoices.map((voice) => voice.id).join(', ')})`);

    await check('las voces Loquendo quedan separadas de las de Windows en /api/voices', async () => {
      const registry = createTtsEngineRegistry();
      registry.register(createSapiEngine());
      registry.register(createLoquendoEngine());
      const app = express();
      app.use('/api', createTtsRouter({ registry, serverAudio: { get: () => null } }));
      const server = await startApp(app);
      try {
        const body = await (await server.get('/api/voices')).json();
        const sapiIds = body.voices.filter((voice) => voice.engine === TTS_ENGINE_NAMES.sapi).map((voice) => voice.id);
        const loquendoIds = body.voices
          .filter((voice) => voice.engine === TTS_ENGINE_NAMES.loquendo)
          .map((voice) => voice.id);
        assert.ok(loquendoIds.length > 0, 'debe haber al menos una voz loquendo');
        assert.ok(
          loquendoIds.every((id) => !sapiIds.includes(id)),
          'ninguna voz Loquendo debe aparecer también bajo sapi',
        );
        assert.deepEqual(
          body.engines.map((engine) => engine.name).filter((name) => name === TTS_ENGINE_NAMES.loquendo),
          [TTS_ENGINE_NAMES.loquendo],
          'loquendo aparece como su propio motor en el catálogo agregado',
        );
      } finally {
        await server.close();
      }
    });

    await check('síntesis real con una voz Loquendo', async () => {
      const audio = await realLoquendo.synthesize({
        text: 'Hola, esto lo dice una voz de Loquendo, separada de las de Windows.',
        voiceId: loquendoVoices[0].id,
        pitch: 1,
        volume: 1,
      });
      assert.equal(audio.format, SAPI_AUDIO_FORMAT);
      const bytes = Buffer.from(audio.base64, 'base64');
      const header = readWavHeader(bytes);
      assert.equal(header.riff, 'RIFF');
      assert.ok(bytes.length > 20_000, `audio real, no un placeholder (${bytes.length} bytes)`);
    });
  }

  const suffix = skipped === 0 ? '' : ` (${skipped} omitidas: sin SAPI/Loquendo real)`;
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
