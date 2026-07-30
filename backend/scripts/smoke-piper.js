/**
 * Pruebas de humo del motor Piper (T-010):
 *
 *   npm --prefix backend run test:piper
 *
 * **Corre igual con Piper instalado y sin él**, porque eso es exactamente lo que
 * hay que garantizar: la degradación limpia (si el operador nunca corre
 * `npm run setup:piper`, las voces `piper:*` no aparecen y el resto del sistema
 * funciona igual) es un criterio de aceptación de T-010.
 *
 * Cinco bloques:
 *
 * 1. **Plataformas y rutas** (puro): el artefacto que toca a cada sistema
 *    operativo —incluido `win_amd64` para la máquina Windows 11 de producción—, la
 *    variable del cargador dinámico, y las rutas y URLs derivadas del nombre del
 *    modelo. Nada de esto toca disco ni red.
 * 2. **Catálogo e ids** sobre una **instalación falsa** en el tmpdir del sistema:
 *    qué modelos se ven, cómo se mapean a `TtsVoice` y cómo se elige la voz.
 * 3. **Degradación limpia**: sin binario, sin modelos o con el motor desactivado,
 *    el catálogo sale vacío, `GET /api/voices` sigue respondiendo con las voces de
 *    los demás motores, y solo `synthesize()` lanza (para que lea el navegador).
 * 4. **Síntesis con un Piper falso** (un script de Node que imita al binario): fija
 *    los argumentos que se le pasan, el WAV que se construye, y los tres modos de
 *    fallo (código distinto de cero, salida vacía, cuelgue → timeout).
 * 5. **Piper real**, solo si está instalado: audio WAV de verdad, el pitch aplicado
 *    y la cadena completa registro → pipeline → `GET /api/tts/audio/:id`. Si no
 *    está instalado, este bloque se **omite** con un aviso (y el gate pasa).
 *    Se puede omitir a mano con `SKIP_PIPER_REAL=1`.
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
  PIPER_AUDIO_FORMAT,
  PIPER_PITCH_MAX,
  PIPER_PITCH_MIN,
  PIPER_TIMBRE_MAX,
  PIPER_TIMBRE_MIN,
  buildWavHeader,
  createPiperEngine,
  piperPitchFactor,
  piperTimbreFactor,
  pickPiperModel,
  toPiperInputLine,
  toPiperModelName,
  toPiperVoice,
  wrapPcmAsWav,
} from '../src/tts/piper-engine.js';
import {
  PIPER_DEFAULT_VOICES,
  PIPER_PHONEMIZE_RELEASE_TAG,
  PIPER_RELEASE_TAG,
  PIPER_SUPPORTED_TARGETS,
  dynamicLibraryPathVar,
  isPiperEnabled,
  listInstalledPiperModels,
  parsePiperModelName,
  piperPaths,
  piperSpawnEnv,
  piperTargetOrThrow,
  piperVoiceRemotePath,
  piperVoiceUrls,
  resolvePiperBinary,
  resolvePiperTarget,
} from '../src/tts/piper-install.js';

const SKIP_REAL = ['1', 'true', 'yes'].includes(String(process.env.SKIP_PIPER_REAL ?? '').toLowerCase());

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-hub-piper-'));
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

/** Nombre del ejecutable en esta plataforma (`piper` o `piper.exe`). */
const binaryName = resolvePiperTarget()?.binaryName ?? 'piper';

const MODEL_SAMPLE_RATE = 22_050;

/** Configuración de modelo como la que traen los `.onnx.json` de Piper. */
const modelConfig = (locale, { sampleRate = MODEL_SAMPLE_RATE, lengthScale = 1 } = {}) => ({
  audio: { sample_rate: sampleRate, quality: 'medium' },
  espeak: { voice: locale.slice(0, 2) },
  inference: { noise_scale: 0.667, length_scale: lengthScale, noise_w: 0.8 },
  language: { code: locale },
  num_speakers: 1,
});

/**
 * Crea una instalación de Piper de mentira: un ejecutable vacío (pero ejecutable)
 * y los modelos que se pidan. Es lo que permite probar el camino "instalado" sin
 * descargar 150 MB, y el camino "sin instalar" en la misma corrida.
 */
function fakeInstall(name, { voices = ['es_ES-davefx-medium', 'es_MX-ald-medium'], binary = true, espeak = true } = {}) {
  const root = path.join(tempDir, name);
  const releaseDir = path.join(root, 'piper');
  const voicesDir = path.join(root, 'piper-voices');
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.mkdirSync(voicesDir, { recursive: true });
  if (binary) {
    fs.writeFileSync(path.join(releaseDir, binaryName), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(releaseDir, binaryName), 0o755);
  }
  if (espeak) {
    fs.mkdirSync(path.join(releaseDir, 'espeak-ng-data'), { recursive: true });
  }
  for (const voice of voices) {
    const locale = voice.split('-')[0];
    fs.writeFileSync(path.join(voicesDir, `${voice}.onnx`), Buffer.alloc(64, 7));
    fs.writeFileSync(path.join(voicesDir, `${voice}.onnx.json`), JSON.stringify(modelConfig(locale)));
  }
  return { root, releaseDir, voicesDir, env: { TTS_PIPER_DIR: root } };
}

/**
 * Piper de mentira: un script de Node que se comporta como el binario según el
 * modo pedido. Se invoca a través de la costura `spawnImpl` del motor, así que
 * funciona igual en macOS y en Windows (no depende de shebang ni de permisos) y
 * además **captura los argumentos y la entrada**, que es lo que hay que fijar
 * (fijar bytes de audio de un proceso externo es lo que produjo un falso verde en
 * T-009).
 */
const fakePiper = path.join(tempDir, 'fake-piper.mjs');
fs.writeFileSync(
  fakePiper,
  `import fs from 'node:fs';
const [mode, samples, inputFile] = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(inputFile, input);
  if (mode === 'fail') {
    process.stderr.write('modelo ilegible\\n');
    process.exit(2);
  }
  if (mode === 'empty') {
    process.exit(0);
  }
  if (mode === 'hang') {
    setInterval(() => {}, 1000);
    return;
  }
  const total = Number.parseInt(samples, 10);
  const pcm = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i += 1) {
    pcm.writeInt16LE(((i * 37) % 20000) - 10000, i * 2);
  }
  process.stdout.write(pcm, () => process.exit(0));
});
`,
);

let fakeRunSeq = 0;
/** Costura `spawnImpl` que registra la llamada y lanza el Piper de mentira. */
function fakeSpawn({ mode = 'ok', samples = 1_000 } = {}) {
  const calls = [];
  const spawnImpl = (binary, args, options) => {
    fakeRunSeq += 1;
    const inputFile = path.join(tempDir, `fake-input-${fakeRunSeq}.txt`);
    calls.push({ binary, args, options, inputFile, get input() {
      return fs.existsSync(inputFile) ? fs.readFileSync(inputFile, 'utf8') : null;
    } });
    return spawn(process.execPath, [fakePiper, mode, String(samples), inputFile], {
      stdio: options.stdio,
      env: options.env,
    });
  };
  return { spawnImpl, calls };
}

/** Lee la cabecera de un WAV PCM de 44 bytes. */
function readWavHeader(bytes) {
  return {
    riff: bytes.toString('ascii', 0, 4),
    size: bytes.readUInt32LE(4),
    wave: bytes.toString('ascii', 8, 12),
    fmt: bytes.toString('ascii', 12, 16),
    audioFormat: bytes.readUInt16LE(20),
    channels: bytes.readUInt16LE(22),
    sampleRate: bytes.readUInt32LE(24),
    byteRate: bytes.readUInt32LE(28),
    blockAlign: bytes.readUInt16LE(32),
    bitsPerSample: bytes.readUInt16LE(34),
    data: bytes.toString('ascii', 36, 40),
    dataLength: bytes.readUInt32LE(40),
  };
}

const wavSeconds = (bytes) => {
  const header = readWavHeader(bytes);
  return header.dataLength / 2 / header.sampleRate;
};

async function main() {
  console.log('Humo del motor Piper (T-010)');
  console.log(`  temporales: ${tempDir}`);

  // ---------------------------------------------------------------- bloque 1
  section('plataformas y rutas (sin disco ni red)');

  await check('macOS de desarrollo: artefacto y ejecutable correctos', () => {
    const arm = resolvePiperTarget('darwin', 'arm64');
    assert.equal(arm.asset, 'piper_macos_aarch64.tar.gz');
    assert.equal(arm.archive, 'tar.gz');
    assert.equal(arm.binaryName, 'piper');
    assert.equal(arm.url, `https://github.com/rhasspy/piper/releases/download/${PIPER_RELEASE_TAG}/${arm.asset}`);
    assert.equal(resolvePiperTarget('darwin', 'x64').asset, 'piper_macos_x64.tar.gz');
  });

  await check('Windows 11 de producción: win_amd64 contemplado', () => {
    const win = resolvePiperTarget('win32', 'x64');
    assert.notEqual(win, null, 'la máquina de producción es Windows 11: el artefacto debe estar mapeado');
    assert.equal(win.asset, 'piper_windows_amd64.zip');
    assert.equal(win.archive, 'zip');
    assert.equal(win.binaryName, 'piper.exe', 'en Windows el ejecutable lleva extensión');
    assert.equal(win.libsUrl, null, 'el artefacto de Windows ya trae sus DLL');
  });

  await check('en macOS se completan las bibliotecas que le faltan al artefacto', () => {
    // Defecto de empaquetado de la release: los tar de macOS no traen las dylib.
    for (const arch of ['arm64', 'x64']) {
      const target = resolvePiperTarget('darwin', arch);
      assert.ok(target.libsUrl.includes('piper-phonemize'));
      assert.ok(target.libsUrl.includes(PIPER_PHONEMIZE_RELEASE_TAG));
      assert.equal(target.libsExtension, '.dylib');
    }
  });

  await check('una plataforma sin binario no revienta: null, y el setup avisa', () => {
    assert.equal(resolvePiperTarget('sunos', 'sparc'), null);
    assert.throws(
      () => piperTargetOrThrow('sunos', 'sparc'),
      (error) => {
        assert.match(error.message, /sunos-sparc/);
        for (const supported of PIPER_SUPPORTED_TARGETS) {
          assert.ok(error.message.includes(supported), `el error debe nombrar ${supported}`);
        }
        return true;
      },
    );
  });

  await check('la plataforma actual está soportada', () => {
    assert.notEqual(resolvePiperTarget(), null, `${process.platform}-${process.arch} debería estar en PIPER_TARGETS`);
  });

  await check('la variable del cargador dinámico es la de cada sistema', () => {
    assert.equal(dynamicLibraryPathVar('darwin'), 'DYLD_LIBRARY_PATH');
    assert.equal(dynamicLibraryPathVar('linux'), 'LD_LIBRARY_PATH');
    assert.equal(dynamicLibraryPathVar('win32'), null, 'Windows busca los DLL junto al .exe');
  });

  await check('el entorno de lanzamiento añade el directorio del binario', () => {
    const binary = path.join(tempDir, 'x', 'piper', 'piper');
    const macos = piperSpawnEnv(binary, { env: { PATH: '/usr/bin' }, platform: 'darwin' });
    assert.equal(macos.DYLD_LIBRARY_PATH, path.dirname(binary));
    assert.equal(macos.PATH, '/usr/bin', 'el resto del entorno se conserva');

    const conservado = piperSpawnEnv(binary, { env: { DYLD_LIBRARY_PATH: '/opt/lib' }, platform: 'darwin' });
    assert.equal(conservado.DYLD_LIBRARY_PATH, `${path.dirname(binary)}${path.delimiter}/opt/lib`);

    const windows = piperSpawnEnv(binary, { env: { PATH: 'C:\\Windows' }, platform: 'win32' });
    assert.equal(windows.DYLD_LIBRARY_PATH, undefined);
    assert.equal(windows.PATH, 'C:\\Windows');
  });

  await check('las rutas se componen con path.join y se pueden mover por entorno', () => {
    const base = path.join(tempDir, 'rutas');
    const paths = piperPaths({ env: { TTS_PIPER_DIR: base }, platform: 'win32', arch: 'x64' });
    assert.equal(paths.root, base);
    assert.equal(paths.releaseDir, path.join(base, 'piper'));
    assert.equal(paths.voicesDir, path.join(base, 'piper-voices'));
    assert.equal(paths.defaultBinary, path.join(base, 'piper', 'piper.exe'));
    assert.equal(paths.manifestFile, path.join(base, 'piper-install.json'));

    const otras = piperPaths({
      env: { TTS_PIPER_DIR: base, TTS_PIPER_VOICES_DIR: path.join(base, 'otras'), TTS_PIPER_BIN: '/opt/piper' },
    });
    assert.equal(otras.voicesDir, path.join(base, 'otras'));
    assert.equal(otras.binaryOverride, '/opt/piper');
  });

  await check('el default vive en backend/vendor, que está git-ignorado', () => {
    const paths = piperPaths({ env: {} });
    assert.equal(path.basename(paths.root), 'vendor');
    const gitignore = fs.readFileSync(path.join(import.meta.dirname, '..', '..', '.gitignore'), 'utf8');
    assert.ok(gitignore.includes('backend/vendor/'), 'los artefactos de Piper NO se commitean');
  });

  await check('el nombre del modelo se descompone y da su ruta remota', () => {
    assert.deepEqual(parsePiperModelName('es_ES-davefx-medium'), {
      locale: 'es_ES',
      speaker: 'davefx',
      quality: 'medium',
      language: 'es-ES',
    });
    assert.equal(parsePiperModelName('es_MX-ald-x_low').quality, 'x_low');
    assert.equal(parsePiperModelName('cualquier-cosa'), null);
    assert.equal(piperVoiceRemotePath('es_ES-davefx-medium'), 'es/es_ES/davefx/medium');
    assert.equal(piperVoiceRemotePath('es_MX-claude-high'), 'es/es_MX/claude/high');
    assert.throws(() => piperVoiceRemotePath('inventada'), /no reconocido/);
  });

  await check('las URLs de una voz apuntan al repositorio oficial de modelos', () => {
    const urls = piperVoiceUrls('es_MX-ald-medium');
    assert.equal(
      urls.model,
      'https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_MX/ald/medium/es_MX-ald-medium.onnx',
    );
    assert.equal(urls.config, `${urls.model}.json`);
  });

  await check('las voces default son dos: una es_ES y una es_MX', () => {
    assert.equal(PIPER_DEFAULT_VOICES.length >= 2, true);
    assert.ok(
      PIPER_DEFAULT_VOICES.some((voice) => voice.startsWith('es_ES-')),
      'el criterio pide una voz de España',
    );
    assert.ok(
      PIPER_DEFAULT_VOICES.some((voice) => voice.startsWith('es_MX-')),
      'el criterio pide una voz de México',
    );
  });

  await check('el motor se puede desactivar por entorno', () => {
    assert.equal(isPiperEnabled({}), true, 'por default está activo');
    for (const value of ['false', 'FALSE', '0', 'no']) {
      assert.equal(isPiperEnabled({ TTS_PIPER_ENABLED: value }), false);
    }
    assert.equal(isPiperEnabled({ TTS_PIPER_ENABLED: 'true' }), true);
    assert.equal(isPiperEnabled({ TTS_PIPER_ENABLED: '   ' }), true, 'vacía = ausente');
  });

  // ---------------------------------------------------------------- bloque 2
  section('catálogo de voces e ids namespaced');

  const install = fakeInstall('instalado');

  await check('el motor cumple la interfaz TTSEngine y es de servidor', () => {
    const engine = createPiperEngine({ env: install.env });
    assertTtsEngine(engine);
    assert.equal(engine.name, TTS_ENGINE_NAMES.piper);
    assert.equal(engine.kind, TTS_ENGINE_KINDS.server);
    assert.equal(typeof engine.synthesize, 'function');
  });

  await check('se ven los modelos instalados, en orden y con su configuración', () => {
    const models = listInstalledPiperModels(install.voicesDir);
    assert.deepEqual(
      models.map((model) => model.name),
      ['es_ES-davefx-medium', 'es_MX-ald-medium'],
    );
    assert.equal(models[0].meta.audio.sample_rate, MODEL_SAMPLE_RATE);
  });

  await check('una descarga a medias no se anuncia como voz', () => {
    const parcial = fakeInstall('parcial', { voices: [] });
    // `.onnx` sin su `.onnx.json` al lado.
    fs.writeFileSync(path.join(parcial.voicesDir, 'es_ES-solo-medium.onnx'), Buffer.alloc(8, 1));
    // `.onnx` vacío (fetch cortado en el primer byte) con json válido.
    fs.writeFileSync(path.join(parcial.voicesDir, 'es_ES-vacio-medium.onnx'), Buffer.alloc(0));
    fs.writeFileSync(path.join(parcial.voicesDir, 'es_ES-vacio-medium.onnx.json'), JSON.stringify(modelConfig('es_ES')));
    // json corrupto.
    fs.writeFileSync(path.join(parcial.voicesDir, 'es_ES-roto-medium.onnx'), Buffer.alloc(8, 1));
    fs.writeFileSync(path.join(parcial.voicesDir, 'es_ES-roto-medium.onnx.json'), '{ esto no es json');
    assert.deepEqual(listInstalledPiperModels(parcial.voicesDir), []);
  });

  await check('un modelo se mapea a TtsVoice con id piper:<modelo>', () => {
    const [model] = listInstalledPiperModels(install.voicesDir);
    const voice = toPiperVoice(model);
    assert.equal(voice.id, 'piper:es_ES-davefx-medium');
    assert.equal(voice.name, 'es_ES-davefx-medium');
    assert.equal(voice.engine, TTS_ENGINE_NAMES.piper);
    assert.equal(voice.language, 'es-ES');
    assert.equal(voice.label, 'davefx (es-ES, medium)');
  });

  await check('el id namespaced se convierte al nombre del modelo', () => {
    assert.equal(toPiperModelName('piper:es_MX-ald-medium'), 'es_MX-ald-medium');
    assert.equal(toPiperModelName('edge:es-MX-DaliaNeural'), null);
    assert.equal(toPiperModelName(null), null, 'null = "elige tú"');
    assert.equal(toPiperModelName('sin-namespace'), null);
  });

  await check('el catálogo del motor lista las voces instaladas', async () => {
    const engine = createPiperEngine({ env: install.env });
    const voices = await engine.listVoices();
    assert.deepEqual(
      voices.map((voice) => voice.id),
      ['piper:es_ES-davefx-medium', 'piper:es_MX-ald-medium'],
    );
    assert.equal(await engine.isAvailable(), true);
  });

  await check('elegir modelo: el pedido, y si no está, el mejor en español', () => {
    const models = listInstalledPiperModels(install.voicesDir);
    assert.equal(pickPiperModel(models, 'piper:es_ES-davefx-medium').name, 'es_ES-davefx-medium');
    // Voz de otro motor o `null`: se prefiere es-MX (el locale de la voz global).
    assert.equal(pickPiperModel(models, null).name, 'es_MX-ald-medium');
    assert.equal(pickPiperModel(models, 'edge:es-MX-DaliaNeural').name, 'es_MX-ald-medium');
    // Un modelo que ya no está instalado no manda el mensaje al navegador.
    assert.equal(pickPiperModel(models, 'piper:es_ES-borrado-medium').name, 'es_MX-ald-medium');
    assert.equal(pickPiperModel([], 'piper:lo-que-sea'), null);
  });

  // ---------------------------------------------------------------- bloque 3
  section('degradación limpia: Piper no instalado');

  const sinNada = fakeInstall('sin-nada', { voices: [], binary: false });
  const sinBinario = fakeInstall('sin-binario', { binary: false });
  const sinVoces = fakeInstall('sin-voces', { voices: [] });

  await check('sin instalación no hay voces ni error', async () => {
    const engine = createPiperEngine({ env: sinNada.env });
    assert.deepEqual(await engine.listVoices(), []);
    assert.equal(await engine.isAvailable(), false);
    assert.equal(resolvePiperBinary(piperPaths({ env: sinNada.env })), null);
  });

  await check('con modelos pero sin binario tampoco se anuncian voces', async () => {
    const engine = createPiperEngine({ env: sinBinario.env });
    assert.deepEqual(await engine.listVoices(), [], 'no se puede leer lo que no se puede sintetizar');
    assert.equal(await engine.isAvailable(), false);
  });

  await check('con binario pero sin modelos: catálogo vacío', async () => {
    const engine = createPiperEngine({ env: sinVoces.env });
    assert.deepEqual(await engine.listVoices(), []);
    assert.equal(await engine.isAvailable(), false);
  });

  await check('desactivado por entorno: como si no estuviera instalado', async () => {
    const engine = createPiperEngine({ env: { ...install.env, TTS_PIPER_ENABLED: 'false' } });
    assert.deepEqual(await engine.listVoices(), []);
    assert.equal(await engine.isAvailable(), false);
  });

  await check('synthesize() sí lanza (y nombra setup:piper) para que lea el navegador', async () => {
    const engine = createPiperEngine({ env: sinNada.env });
    await assert.rejects(
      () => engine.synthesize({ text: 'hola', voiceId: 'piper:es_MX-ald-medium', pitch: 1, volume: 1 }),
      (error) => {
        assert.match(error.message, /piper/);
        assert.match(error.message, /setup:piper/);
        return true;
      },
    );
  });

  await check('el catálogo agregado no se rompe: cero voces piper, las demás siguen', async () => {
    const registry = createTtsEngineRegistry({ engines: [createBrowserEngine()] });
    registry.register({
      name: 'otro',
      kind: TTS_ENGINE_KINDS.client,
      isAvailable: async () => true,
      listVoices: async () => [
        { id: formatVoiceId('otro', 'Ana'), name: 'Ana', engine: 'otro', language: 'es-ES', label: 'Ana' },
      ],
    });
    registry.register(createPiperEngine({ env: sinNada.env }));

    const voices = await registry.listVoices();
    assert.equal(
      voices.filter((voice) => voice.engine === TTS_ENGINE_NAMES.piper).length,
      0,
      'las voces de Piper simplemente no aparecen',
    );
    assert.equal(voices.length, 1, 'las de los otros motores siguen ahí');
    assert.ok(registry.has(TTS_ENGINE_NAMES.piper), 'el motor está registrado aunque no esté instalado');
  });

  await check('GET /api/voices responde igual sin Piper instalado', async () => {
    const registry = createTtsEngineRegistry();
    registry.register(createPiperEngine({ env: sinNada.env }));
    const app = express();
    app.use('/api', createTtsRouter({ registry, serverAudio: { get: () => null } }));
    const server = await startApp(app);
    try {
      const response = await server.get('/api/voices');
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(
        body.voices.filter((voice) => voice.engine === TTS_ENGINE_NAMES.piper),
        [],
      );
      assert.deepEqual(
        body.engines.find((engine) => engine.name === TTS_ENGINE_NAMES.piper),
        { name: TTS_ENGINE_NAMES.piper, kind: TTS_ENGINE_KINDS.server },
      );
    } finally {
      await server.close();
    }
  });

  await check('GET /api/voices lista las voces piper en cuanto están instaladas', async () => {
    const registry = createTtsEngineRegistry();
    registry.register(createPiperEngine({ env: install.env }));
    const app = express();
    app.use('/api', createTtsRouter({ registry, serverAudio: { get: () => null } }));
    const server = await startApp(app);
    try {
      const body = await (await server.get('/api/voices')).json();
      const piperVoices = body.voices.filter((voice) => voice.engine === TTS_ENGINE_NAMES.piper);
      assert.deepEqual(
        piperVoices.map((voice) => voice.id),
        ['piper:es_ES-davefx-medium', 'piper:es_MX-ald-medium'],
      );
      // El español va primero: el selector de T-011 pinta el catálogo tal cual.
      assert.equal(body.voices[0].language.startsWith('es'), true);
    } finally {
      await server.close();
    }
  });

  // ---------------------------------------------------------------- bloque 4
  section('síntesis (Piper de mentira: argumentos, WAV y fallos)');

  await check('el pitch se recorta al rango soportado', () => {
    assert.equal(piperPitchFactor(1), 1);
    assert.equal(piperPitchFactor(undefined), 1);
    assert.equal(piperPitchFactor(Number.NaN), 1);
    // El rango que reparte T-011 entre usuarios (0.8–1.4).
    assert.equal(piperPitchFactor(0.8), 0.8);
    assert.equal(piperPitchFactor(1.4), PIPER_PITCH_MAX);
    assert.equal(piperPitchFactor(0), PIPER_PITCH_MIN);
    assert.equal(piperPitchFactor(9), PIPER_PITCH_MAX);
  });

  await check('el timbre se recorta al rango soportado', () => {
    assert.equal(piperTimbreFactor(1), 1);
    assert.equal(piperTimbreFactor(undefined), 1);
    assert.equal(piperTimbreFactor(Number.NaN), 1);
    // El rango que reparte T-011 entre usuarios (0.8–1.4) queda dentro del
    // soportado por Piper (0.75–1.35), salvo en la punta alta.
    assert.equal(piperTimbreFactor(0.8), 0.8);
    assert.equal(piperTimbreFactor(1.4), PIPER_TIMBRE_MAX);
    assert.equal(piperTimbreFactor(0), PIPER_TIMBRE_MIN);
    assert.equal(piperTimbreFactor(9), PIPER_TIMBRE_MAX);
  });

  await check('la cabecera WAV es coherente con el PCM de Piper', () => {
    const header = readWavHeader(buildWavHeader({ sampleRate: 22_050, dataLength: 400 }));
    assert.equal(header.riff, 'RIFF');
    assert.equal(header.wave, 'WAVE');
    assert.equal(header.fmt, 'fmt ');
    assert.equal(header.audioFormat, 1, 'PCM sin comprimir');
    assert.equal(header.channels, 1);
    assert.equal(header.bitsPerSample, 16);
    assert.equal(header.sampleRate, 22_050);
    assert.equal(header.byteRate, 22_050 * 2);
    assert.equal(header.blockAlign, 2);
    assert.equal(header.data, 'data');
    assert.equal(header.dataLength, 400);
    assert.equal(header.size, 436);

    const wav = wrapPcmAsWav(Buffer.alloc(9, 3), 16_000);
    assert.equal(wav.length, 44 + 8, 'un byte impar sería medio sample: se recorta');
    assert.equal(readWavHeader(wav).sampleRate, 16_000);
  });

  await check('el texto viaja en una sola línea', () => {
    assert.equal(toPiperInputLine('  hola  '), 'hola');
    assert.equal(toPiperInputLine('dos\nlíneas\r\ny tres'), 'dos líneas y tres');
  });

  await check('sin texto no se ejecuta nada', async () => {
    const { spawnImpl, calls } = fakeSpawn();
    const engine = createPiperEngine({ env: install.env, spawnImpl });
    await assert.rejects(() => engine.synthesize({ text: '   ', voiceId: 'piper:es_MX-ald-medium' }), /texto/);
    assert.equal(calls.length, 0);
  });

  await check('se le pasan modelo, configuración, salida cruda, length_scale y espeak', async () => {
    const { spawnImpl, calls } = fakeSpawn({ samples: 500 });
    const engine = createPiperEngine({ env: install.env, spawnImpl });
    const audio = await engine.synthesize({
      text: 'hola chat',
      voiceId: 'piper:es_ES-davefx-medium',
      pitch: 1,
      volume: 0.5,
    });

    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.binary, path.join(install.releaseDir, binaryName));
    const args = call.args;
    assert.equal(args[args.indexOf('--model') + 1], path.join(install.voicesDir, 'es_ES-davefx-medium.onnx'));
    assert.equal(args[args.indexOf('--config') + 1], path.join(install.voicesDir, 'es_ES-davefx-medium.onnx.json'));
    assert.ok(args.includes('--output_raw'), 'el PCM llega por la salida estándar, sin archivos temporales');
    assert.equal(args[args.indexOf('--length_scale') + 1], '1');
    assert.equal(args[args.indexOf('--espeak_data') + 1], path.join(install.releaseDir, 'espeak-ng-data'));
    assert.equal(call.options.cwd, install.releaseDir);
    assert.equal(call.input, 'hola chat\n');

    assert.equal(audio.format, PIPER_AUDIO_FORMAT);
    const bytes = Buffer.from(audio.base64, 'base64');
    assert.equal(bytes.length, 44 + 1_000);
    assert.equal(readWavHeader(bytes).sampleRate, MODEL_SAMPLE_RATE, 'pitch 1 = frecuencia nativa del modelo');
  });

  await check('el pitch sube la frecuencia y compensa con length_scale', async () => {
    const { spawnImpl, calls } = fakeSpawn({ samples: 500 });
    const engine = createPiperEngine({ env: install.env, spawnImpl });

    const agudo = await engine.synthesize({ text: 'hola', voiceId: 'piper:es_MX-ald-medium', pitch: 1.3 });
    assert.equal(calls[0].args[calls[0].args.indexOf('--length_scale') + 1], '1.3', 'habla más lento en la misma proporción');
    assert.equal(readWavHeader(Buffer.from(agudo.base64, 'base64')).sampleRate, Math.round(MODEL_SAMPLE_RATE * 1.3));

    const grave = await engine.synthesize({ text: 'hola', voiceId: 'piper:es_MX-ald-medium', pitch: 0.8 });
    assert.equal(calls[1].args[calls[1].args.indexOf('--length_scale') + 1], '0.8');
    assert.equal(readWavHeader(Buffer.from(grave.base64, 'base64')).sampleRate, Math.round(MODEL_SAMPLE_RATE * 0.8));

    // Fuera de rango se recorta, y eso se ve en los dos números a la vez.
    const extremo = await engine.synthesize({ text: 'hola', voiceId: 'piper:es_MX-ald-medium', pitch: 5 });
    assert.equal(calls[2].args[calls[2].args.indexOf('--length_scale') + 1], String(PIPER_PITCH_MAX));
    assert.equal(
      readWavHeader(Buffer.from(extremo.base64, 'base64')).sampleRate,
      Math.round(MODEL_SAMPLE_RATE * PIPER_PITCH_MAX),
    );
  });

  await check('sin carpeta de espeak no se inventa el argumento', async () => {
    const sinEspeak = fakeInstall('sin-espeak', { espeak: false });
    const { spawnImpl, calls } = fakeSpawn({ samples: 10 });
    const engine = createPiperEngine({ env: sinEspeak.env, spawnImpl });
    await engine.synthesize({ text: 'hola', voiceId: 'piper:es_MX-ald-medium' });
    assert.equal(calls[0].args.includes('--espeak_data'), false);
  });

  await check('el entorno del proceso lleva la ruta de bibliotecas', async () => {
    const { spawnImpl, calls } = fakeSpawn({ samples: 10 });
    const engine = createPiperEngine({ env: { ...install.env, PATH: process.env.PATH }, spawnImpl });
    await engine.synthesize({ text: 'hola', voiceId: 'piper:es_MX-ald-medium' });
    const variable = dynamicLibraryPathVar();
    if (variable !== null) {
      assert.equal(calls[0].options.env[variable].split(path.delimiter)[0], install.releaseDir);
    } else {
      assert.equal(typeof calls[0].options.env, 'object');
    }
  });

  await check('si Piper falla, se rechaza con su mensaje de error', async () => {
    const { spawnImpl } = fakeSpawn({ mode: 'fail' });
    const engine = createPiperEngine({ env: install.env, spawnImpl });
    await assert.rejects(
      () => engine.synthesize({ text: 'hola', voiceId: 'piper:es_MX-ald-medium' }),
      (error) => {
        assert.match(error.message, /código 2/);
        assert.match(error.message, /modelo ilegible/);
        return true;
      },
    );
  });

  await check('si Piper no devuelve audio, se rechaza', async () => {
    const { spawnImpl } = fakeSpawn({ mode: 'empty' });
    const engine = createPiperEngine({ env: install.env, spawnImpl });
    await assert.rejects(() => engine.synthesize({ text: 'hola', voiceId: 'piper:es_MX-ald-medium' }), /no devolvió audio/);
  });

  await check('un Piper colgado se mata por timeout (no congela la cola)', async () => {
    const { spawnImpl } = fakeSpawn({ mode: 'hang' });
    const engine = createPiperEngine({ env: install.env, spawnImpl, timeoutMs: 400 });
    const started = Date.now();
    await assert.rejects(
      () => engine.synthesize({ text: 'hola', voiceId: 'piper:es_MX-ald-medium' }),
      /no terminó en 400 ms/,
    );
    assert.ok(Date.now() - started < 4_000, 'debe cortar por su cuenta, no esperar al proceso');
  });

  await check('un ejecutable que no arranca se rechaza sin tumbar el proceso', async () => {
    const engine = createPiperEngine({
      env: install.env,
      spawnImpl: () => {
        throw new Error('spawn ENOENT');
      },
    });
    await assert.rejects(() => engine.synthesize({ text: 'hola', voiceId: 'piper:es_MX-ald-medium' }), /ENOENT/);
  });

  await check('pipeline: un usuario con voz piper recibe audio adjunto', async () => {
    const { spawnImpl } = fakeSpawn({ samples: 200 });
    const registry = createTtsEngineRegistry();
    registry.register(createPiperEngine({ env: install.env, spawnImpl }));
    const pipeline = createTtsPipeline({ registry, repositories });

    repos.users.upsert({ twitchUserId: '710', username: 'lupe', displayName: 'Lupe' });
    repos.users.updatePreferences('710', { voiceId: 'piper:es_MX-ald-medium', voiceSource: 'override' });

    const decision = pipeline.decide(makeMessage({ userId: '710', username: 'lupe', text: 'hola con piper' }));
    assert.equal(decision.tts.engine, TTS_ENGINE_NAMES.piper);
    assert.equal(decision.tts.voiceId, 'piper:es_MX-ald-medium');
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
  section('Piper real (se omite si no está instalado)');

  const realEngine = createPiperEngine();
  const realAvailable = !SKIP_REAL && (await realEngine.isAvailable());
  const realVoices = realAvailable ? await realEngine.listVoices() : [];

  if (!realAvailable) {
    const why = SKIP_REAL ? 'SKIP_PIPER_REAL=1' : 'no instalado; corre `npm --prefix backend run setup:piper`';
    skip('síntesis real con el binario de Piper', why);
    skip('el pitch cambia la frecuencia sin cambiar la duración', why);
    skip('una voz inexistente cae en otra voz instalada', why);
    skip('cadena completa: registro real → pipeline → GET /api/tts/audio/:id', why);
  } else {
    console.log(`  (instalado: ${realVoices.map((voice) => voice.id).join(', ')})`);

    await check('síntesis real con el binario de Piper', async () => {
      assert.ok(
        realVoices.some((voice) => String(voice.language ?? '').startsWith('es')),
        'debe haber al menos una voz en español',
      );
      const audio = await realEngine.synthesize({
        text: 'Hola chat, esto lo dice Piper en local.',
        voiceId: realVoices[0].id,
        pitch: 1,
        volume: 1,
      });
      assert.equal(audio.format, PIPER_AUDIO_FORMAT);
      const bytes = Buffer.from(audio.base64, 'base64');
      const header = readWavHeader(bytes);
      assert.equal(header.riff, 'RIFF');
      assert.equal(header.wave, 'WAVE');
      assert.equal(header.audioFormat, 1);
      assert.equal(header.dataLength, bytes.length - 44);
      assert.ok(bytes.length > 20_000, `audio real, no un placeholder (${bytes.length} bytes)`);
      assert.ok(wavSeconds(bytes) > 1, `debe durar más de un segundo (${wavSeconds(bytes).toFixed(2)} s)`);
    });

    await check('el pitch cambia la frecuencia sin cambiar la duración', async () => {
      const text = 'Una frase de prueba para medir el tono.';
      const [neutro, agudo] = await Promise.all([
        realEngine.synthesize({ text, voiceId: realVoices[0].id, pitch: 1 }),
        realEngine.synthesize({ text, voiceId: realVoices[0].id, pitch: 1.3 }),
      ]);
      const neutroBytes = Buffer.from(neutro.base64, 'base64');
      const agudoBytes = Buffer.from(agudo.base64, 'base64');
      const neutroRate = readWavHeader(neutroBytes).sampleRate;
      assert.equal(readWavHeader(agudoBytes).sampleRate, Math.round(neutroRate * 1.3));
      // Compensación con `length_scale`: la duración se mantiene aproximada (el
      // silencio final entre frases no se estira, de ahí el margen).
      const ratio = wavSeconds(agudoBytes) / wavSeconds(neutroBytes);
      assert.ok(
        ratio > 0.75 && ratio < 1.15,
        `la duración debe quedar parecida, no un 30 % más corta (ratio ${ratio.toFixed(3)})`,
      );
    });

    await check('una voz inexistente cae en otra voz instalada', async () => {
      const audio = await realEngine.synthesize({ text: 'sigo hablando', voiceId: 'piper:es_XX-noexiste-medium' });
      assert.ok(Buffer.from(audio.base64, 'base64').length > 10_000);
    });

    await check('cadena completa: registro real → pipeline → GET /api/tts/audio/:id', async () => {
      const registry = createTtsEngineRegistry();
      registry.register(createPiperEngine());
      const pipeline = createTtsPipeline({ registry, repositories });

      repos.users.upsert({ twitchUserId: '711', username: 'memo', displayName: 'Memo' });
      repos.users.updatePreferences('711', { voiceId: realVoices[0].id, voiceSource: 'override' });

      const app = express();
      app.use('/api', createTtsRouter({ registry, serverAudio: pipeline.serverAudio }));
      const server = await startApp(app);
      try {
        const decision = pipeline.decide(
          makeMessage({ userId: '711', username: 'memo', text: 'esto se sintetiza de verdad, en local' }),
        );
        assert.equal(decision.tts.engine, TTS_ENGINE_NAMES.piper);
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

  const suffix = skipped === 0 ? '' : ` (${skipped} omitidas: Piper no instalado)`;
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
