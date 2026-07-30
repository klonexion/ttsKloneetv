/**
 * Instalador de Piper (T-010):
 *
 *   npm --prefix backend run setup:piper      # desde la raíz del repo
 *   npm run setup:piper                       # desde backend/
 *
 * Descarga el **binario de Piper para el sistema operativo actual** y **dos voces
 * en español** (una de España y una de México) a `backend/vendor/`, que está
 * git-ignorado. Son ~150 MB en total y no se commitea nada.
 *
 * Correrlo es **opcional**: si no se corre, las voces `piper:*` simplemente no
 * aparecen en `GET /api/voices` y todo lo demás funciona igual.
 *
 * Opciones:
 *
 *   --voice=es_MX-claude-high   voz extra (repetible). Cualquier voz del catálogo
 *                               oficial https://huggingface.co/rhasspy/piper-voices
 *   --only=<lista>              instalar SOLO estas voces (en vez de las default)
 *   --force                     volver a descargar aunque ya esté todo
 *   --skip-verify               no sintetizar la frase de prueba al final
 *   --help
 *
 * ## Por qué está escrito así
 *
 * - **Nada de comandos exclusivos de Unix.** La descarga es `fetch` de Node y la
 *   descompresión es `tar`, que viene en macOS y **también en Windows 10/11**
 *   (`C:\Windows\System32\tar.exe`, que es bsdtar y también abre `.zip`). Si en
 *   Windows fallara, se reintenta con `Expand-Archive` de PowerShell. Cero
 *   dependencias npm nuevas.
 * - **Idempotente y reanudable.** Cada archivo se baja a `<nombre>.part` y se
 *   renombra al terminar, así una descarga interrumpida no queda como buena; lo
 *   que ya está no se vuelve a bajar salvo `--force`.
 * - **Con tope de tiempo y progreso.** Son cientos de megas: cada archivo tiene su
 *   propio timeout y va imprimiendo el porcentaje, de modo que un cuelgue de red
 *   se ve y se corta en vez de quedarse esperando.
 * - **Deja un manifiesto** (`vendor/piper-install.json`) con el binario y las
 *   voces instaladas, para que el motor no tenga que adivinar la estructura del
 *   archivo comprimido (que cambia entre plataformas).
 * - **Verifica de verdad al final:** sintetiza una frase con el motor real y
 *   reporta los bytes de audio obtenidos. Si eso pasa, `GET /api/voices` ya tiene
 *   las voces y el chat las puede usar.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';

import { createPiperEngine } from '../src/tts/piper-engine.js';
import {
  PIPER_DEFAULT_VOICES,
  PIPER_RELEASE_TAG,
  listInstalledPiperModels,
  piperPaths,
  piperTargetOrThrow,
  piperVoiceFiles,
  piperVoiceUrls,
} from '../src/tts/piper-install.js';

/** Tope por archivo descargado. El modelo más grande son ~77 MB. */
const DOWNLOAD_TIMEOUT_MS = Number.parseInt(process.env.PIPER_SETUP_TIMEOUT_MS ?? '600000', 10);

/** Tope para descomprimir y para la síntesis de prueba. */
const EXTRACT_TIMEOUT_MS = 120_000;
const VERIFY_TIMEOUT_MS = 60_000;

const log = (message) => console.log(message);

function parseArgs(argv) {
  const options = { voices: [...PIPER_DEFAULT_VOICES], force: false, verify: true, help: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--skip-verify') {
      options.verify = false;
    } else if (arg.startsWith('--voice=')) {
      options.voices.push(arg.slice('--voice='.length));
    } else if (arg.startsWith('--only=')) {
      options.voices = arg
        .slice('--only='.length)
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value !== '');
    } else {
      throw new Error(`Opción no reconocida: ${arg}. Corre con --help para ver las válidas.`);
    }
  }
  options.voices = [...new Set(options.voices)];
  return options;
}

const HELP = `Instalador de Piper (T-010)

  npm --prefix backend run setup:piper [-- <opciones>]

Opciones:
  --voice=<modelo>   voz extra del catálogo oficial (repetible)
  --only=<a,b>       instalar solo estas voces en vez de las default
  --force            volver a descargar todo
  --skip-verify      no sintetizar la frase de prueba final
  --help             esta ayuda

Voces default: ${PIPER_DEFAULT_VOICES.join(', ')}
Catálogo completo: https://huggingface.co/rhasspy/piper-voices
`;

const megabytes = (bytes) => `${(bytes / 1_048_576).toFixed(1)} MB`;

/**
 * Descarga un archivo con progreso y timeout. Escribe en `<destino>.part` y lo
 * renombra al final, para que una descarga cortada no se confunda con una buena.
 */
async function download(url, destination, { force }) {
  if (!force && fs.existsSync(destination) && fs.statSync(destination).size > 0) {
    log(`  ya está: ${path.basename(destination)} (${megabytes(fs.statSync(destination).size)})`);
    return { skipped: true, bytes: fs.statSync(destination).size };
  }

  const partial = `${destination}.part`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.rmSync(partial, { force: true });

  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: 'follow' });
  if (!response.ok || response.body === null) {
    throw new Error(`no se pudo descargar ${url} (HTTP ${response.status})`);
  }

  const total = Number.parseInt(response.headers.get('content-length') ?? '0', 10);
  let received = 0;
  let lastReported = 0;
  const source = Readable.fromWeb(response.body);
  source.on('data', (chunk) => {
    received += chunk.length;
    const step = total > 0 ? Math.floor((received / total) * 10) : Math.floor(received / 20_971_520);
    if (step > lastReported) {
      lastReported = step;
      const percent = total > 0 ? `${step * 10}%` : megabytes(received);
      log(`    ${path.basename(destination)}: ${percent}`);
    }
  });

  await streamPipeline(source, fs.createWriteStream(partial));
  if (total > 0 && received !== total) {
    fs.rmSync(partial, { force: true });
    throw new Error(`descarga incompleta de ${url} (${received} de ${total} bytes)`);
  }
  fs.renameSync(partial, destination);
  log(`  listo: ${path.basename(destination)} (${megabytes(received)})`);
  return { skipped: false, bytes: received };
}

/** Corre un comando con tope de tiempo. Devuelve `{ code, stderr }`. */
function run(command, args, { timeoutMs = EXTRACT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    let timer = setTimeout(() => {
      timer = null;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      resolve({ code: -1, stderr: error.message });
    });
    child.on('close', (code) => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      resolve({ code: code ?? -1, stderr });
    });
  });
}

/**
 * Descomprime el artefacto de la release. `tar` sirve para `.tar.gz` y para `.zip`
 * en macOS y Windows 10/11; en Windows queda `Expand-Archive` como respaldo.
 */
async function extractArchive(archive, targetDir, { archiveKind }) {
  fs.mkdirSync(targetDir, { recursive: true });
  const tarResult = await run('tar', ['-xf', archive, '-C', targetDir]);
  if (tarResult.code === 0) {
    return 'tar';
  }
  if (process.platform === 'win32' && archiveKind === 'zip') {
    const powershell = await run('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${targetDir}' -Force`,
    ]);
    if (powershell.code === 0) {
      return 'Expand-Archive';
    }
    throw new Error(`no se pudo descomprimir ${path.basename(archive)}: ${powershell.stderr || tarResult.stderr}`);
  }
  throw new Error(`no se pudo descomprimir ${path.basename(archive)} con tar: ${tarResult.stderr}`);
}

/**
 * Busca dentro de lo descomprimido (hasta `depth` niveles) la primera entrada con
 * ese nombre **del tipo pedido**. El artefacto trae una carpeta `piper/` en la
 * raíz, pero buscar evita que una estructura distinta en otra plataforma rompa la
 * instalación.
 *
 * El tipo importa: el ejecutable se llama `piper` y vive **dentro** de una carpeta
 * que también se llama `piper`, así que sin el filtro la búsqueda devuelve la
 * carpeta y todo lo que se derive de ahí (la ruta de bibliotecas, por ejemplo)
 * apunta un nivel más arriba de lo que debe.
 */
function findEntry(root, name, { directory = false, depth = 3 } = {}) {
  const direct = path.join(root, name);
  if (fs.existsSync(direct) && fs.statSync(direct).isDirectory() === directory) {
    return direct;
  }
  if (depth === 0) {
    return null;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = findEntry(path.join(root, entry.name), name, { directory, depth: depth - 1 });
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

/**
 * Copia las bibliotecas dinámicas que le faltan al artefacto de macOS (ver
 * `PIPER_PHONEMIZE_RELEASE_TAG` en `src/tts/piper-install.js`).
 *
 * Los enlaces simbólicos se **recrean** en vez de seguirse: la carpeta de origen
 * tiene tres nombres para la misma `libespeak-ng` y dos para `libonnxruntime` (23
 * MB), así que copiar el contenido de cada uno duplicaría decenas de megas sin
 * necesidad.
 */
function copyLibraries(fromDir, toDir, extension) {
  let copied = 0;
  for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
    if (!entry.name.endsWith(extension)) {
      continue;
    }
    const source = path.join(fromDir, entry.name);
    const destination = path.join(toDir, entry.name);
    fs.rmSync(destination, { force: true });
    if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(source), destination);
    } else {
      fs.copyFileSync(source, destination);
    }
    copied += 1;
  }
  return copied;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    log(HELP);
    return 0;
  }

  const target = piperTargetOrThrow();
  const paths = piperPaths();

  log(`Piper ${PIPER_RELEASE_TAG} para ${target.key} (${target.asset})`);
  log(`Destino: ${paths.root}  (git-ignorado)`);
  log(`Voces:   ${options.voices.join(', ')}`);
  log('');

  // 1) Binario.
  log('1/5 Binario');
  const archive = path.join(paths.downloadDir, target.asset);
  await download(target.url, archive, { force: options.force });

  const alreadyExtracted = fs.existsSync(paths.defaultBinary);
  if (options.force || !alreadyExtracted) {
    const how = await extractArchive(archive, paths.root, { archiveKind: target.archive });
    log(`  descomprimido con ${how}`);
  } else {
    log('  ya estaba descomprimido');
  }

  const binary = findEntry(paths.root, target.binaryName);
  if (binary === null) {
    throw new Error(`no se encontró el ejecutable ${target.binaryName} dentro de ${paths.root}`);
  }
  if (process.platform !== 'win32') {
    // El artefacto ya trae el bit de ejecución, pero un `tar` con umask raro puede
    // quitarlo y el fallo sería confuso ("no está instalado").
    fs.chmodSync(binary, 0o755);
  }
  log(`  ejecutable: ${binary}`);

  // 2) Bibliotecas dinámicas: solo en macOS, cuyo artefacto viene incompleto.
  log('');
  log('2/5 Bibliotecas del ejecutable');
  let libraries = 0;
  if (target.libsUrl === null) {
    log('  no hacen falta en esta plataforma (el artefacto ya las trae)');
  } else {
    const libsArchive = path.join(paths.downloadDir, target.libsAsset);
    await download(target.libsUrl, libsArchive, { force: options.force });
    const staging = path.join(paths.downloadDir, 'libs');
    fs.rmSync(staging, { recursive: true, force: true });
    await extractArchive(libsArchive, staging, { archiveKind: 'tar.gz' });
    const libDir = findEntry(staging, 'lib', { directory: true });
    if (libDir === null) {
      throw new Error(`no se encontró la carpeta lib dentro de ${target.libsAsset}`);
    }
    libraries = copyLibraries(libDir, path.dirname(binary), target.libsExtension);
    fs.rmSync(staging, { recursive: true, force: true });
    log(`  ${libraries} bibliotecas copiadas junto al ejecutable`);
  }

  // 3) Voces.
  log('');
  log('3/5 Voces en español');
  fs.mkdirSync(paths.voicesDir, { recursive: true });
  for (const voice of options.voices) {
    const urls = piperVoiceUrls(voice);
    const files = piperVoiceFiles(voice, paths.voicesDir);
    log(`  ${voice}`);
    await download(urls.config, files.config, { force: options.force });
    await download(urls.model, files.model, { force: options.force });
  }

  // 4) Manifiesto: qué quedó instalado (lo lee el motor).
  log('');
  log('4/5 Manifiesto');
  const installed = listInstalledPiperModels(paths.voicesDir);
  const manifest = {
    releaseTag: PIPER_RELEASE_TAG,
    target: target.key,
    asset: target.asset,
    libraries,
    // Relativa a la raíz de la instalación: así mover `vendor/` no la invalida.
    binary: path.relative(paths.root, binary),
    voicesDir: path.relative(paths.root, paths.voicesDir),
    voices: installed.map((model) => model.name),
    installedAt: new Date().toISOString(),
  };
  fs.writeFileSync(paths.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`  ${paths.manifestFile}`);
  log(`  voces instaladas: ${manifest.voices.join(', ') || '(ninguna)'}`);

  // 5) Verificación real: sintetizar una frase corta.
  log('');
  log('5/5 Verificación');
  if (!options.verify) {
    log('  omitida (--skip-verify)');
  } else {
    const engine = createPiperEngine({ timeoutMs: VERIFY_TIMEOUT_MS });
    const voices = await engine.listVoices();
    if (voices.length === 0) {
      throw new Error('el motor no ve ninguna voz instalada; revisa las rutas de arriba');
    }
    const audio = await engine.synthesize({
      text: 'Piper quedó instalado y listo para leer el chat.',
      voiceId: voices[0].id,
      pitch: 1,
      volume: 1,
    });
    const bytes = Buffer.from(audio.base64, 'base64');
    log(`  ${voices.length} voces: ${voices.map((voice) => voice.id).join(', ')}`);
    log(`  síntesis de prueba con ${voices[0].id}: ${audio.format}, ${megabytes(bytes.length)}`);
  }

  log('');
  log('Piper instalado. Siguientes pasos:');
  log('  - `npm --prefix backend run test:piper` para el gate de humo.');
  log('  - Con el backend arriba: `curl http://localhost:3000/api/voices` ya lista las voces `piper:*`.');
  log('  - Para asignar una voz Piper a un usuario, el panel de usuario (T-011) o:');
  log('      UPDATE users SET voice_id = \'piper:es_MX-ald-medium\', voice_source = \'override\' WHERE username = ...;');
  return 0;
}

try {
  process.exit(await main());
} catch (error) {
  console.error('');
  console.error(`No se pudo instalar Piper: ${error.message}`);
  console.error('Piper es opcional: sin él el resto del sistema funciona igual y sus voces no aparecen.');
  process.exit(1);
}
