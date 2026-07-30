/**
 * Instalación local de Piper (T-010): dónde vive, para qué plataforma, y qué
 * modelos de voz hay.
 *
 * Piper no es un paquete npm: es un **binario nativo** más uno o varios modelos
 * `.onnx` que hay que descargar. Este módulo es la única fuente de verdad sobre
 * esa instalación y lo comparten las dos mitades de la tarea:
 *
 * - `../../scripts/setup-piper.js` (`npm run setup:piper`) lo usa para saber qué
 *   descargar y dónde ponerlo;
 * - `./piper-engine.js` lo usa para saber si Piper está instalado y qué voces
 *   ofrecer.
 *
 * ## Decisiones
 *
 * - **Todo va a `backend/vendor/`, que está git-ignorado** (lo dejó previsto
 *   T-001). Son ~150 MB de binario + modelos: no se commitean nunca, y el
 *   operador puede no instalarlos jamás.
 * - **Degradación limpia, no error.** Si no hay binario o no hay modelos, esto
 *   devuelve "no instalado" y el motor expone un catálogo vacío: las voces
 *   `piper:*` simplemente no aparecen en `GET /api/voices` y el resto del sistema
 *   funciona igual (criterio de aceptación de T-010). Nada de excepciones al
 *   arrancar.
 * - **Multiplataforma de verdad, sin rutas POSIX ni comandos de Unix.** El mapa
 *   `PIPER_TARGETS` cubre macOS (dev, verificado) y `win_amd64` (la máquina de
 *   producción del proyecto es Windows 11), más Linux de regalo; todas las rutas
 *   se componen con `path.join` y el nombre del ejecutable incluye `.exe` donde
 *   toca.
 * - **Un manifiesto en la propia instalación** (`piper-install.json`): el script
 *   de setup anota qué binario dejó y qué modelos bajó, así el motor no tiene que
 *   adivinar la estructura interna del archivo comprimido (que cambia entre
 *   plataformas). Si el manifiesto no existe se usa la ruta convencional, de modo
 *   que una instalación hecha a mano también funciona.
 * - **Todo se puede apuntar a otro sitio por entorno** (`TTS_PIPER_*`), que es lo
 *   que permite probar el camino "instalado" y el camino "sin instalar" en el
 *   mismo gate sin descargar nada.
 *
 * La configuración de Piper se lee aquí y no en `src/config.js` a propósito: T-010
 * corre en paralelo con otra tarea y `config.js` no es suyo. Es una desviación
 * consciente de la convención de T-002, anotada en las notas del plan.
 */
import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config.js';

/**
 * Release de la que se bajan los binarios. Fijada a propósito (igual que la
 * versión de `edge-tts-universal` en T-009): una release nueva podría cambiar los
 * nombres de los artefactos o los flags del CLI, y el operador no debería
 * descubrirlo el día del directo.
 *
 * `https://github.com/rhasspy/piper` — comprobado el 2026-07-25: es la última
 * release con **binarios** publicados (el desarrollo siguió en otro repositorio y
 * con distribución por Python, que aquí no sirve: el backend es Node).
 */
export const PIPER_RELEASE_TAG = '2023.11.14-2';

/** Base de descarga de los binarios (release de GitHub). */
export const PIPER_RELEASE_BASE_URL = 'https://github.com/rhasspy/piper/releases/download';

/**
 * **Defecto de empaquetado de la release, comprobado el 2026-07-25:** los dos
 * artefactos de macOS (`piper_macos_aarch64.tar.gz` y `piper_macos_x64.tar.gz`)
 * **no traen las bibliotecas dinámicas** que el ejecutable necesita
 * (`libespeak-ng.1.dylib`, `libpiper_phonemize.1.dylib`,
 * `libonnxruntime.1.14.1.dylib`): solo viene el paquete de símbolos de depuración
 * `libonnxruntime.1.14.1.dylib.dSYM`. Sin ellas, `./piper --help` muere con
 * `dyld: Library not loaded: @rpath/libespeak-ng.1.dylib`.
 *
 * El artefacto de Windows (`piper_windows_amd64.zip`) **sí** trae sus DLL
 * (`espeak-ng.dll`, `onnxruntime.dll`, `piper_phonemize.dll`), así que la máquina
 * de producción no necesita nada de esto.
 *
 * Arreglo (lo hace `setup:piper` solo en macOS): las mismas bibliotecas se
 * publican completas en la release de `piper-phonemize`, el proyecto hermano que
 * las compila. Se descargan de ahí y se copian al lado del ejecutable.
 */
export const PIPER_PHONEMIZE_RELEASE_TAG = '2023.11.14-4';
export const PIPER_PHONEMIZE_BASE_URL = 'https://github.com/rhasspy/piper-phonemize/releases/download';

/** Base de descarga de los modelos de voz (repositorio oficial en Hugging Face). */
export const PIPER_VOICES_BASE_URL = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';

/**
 * Artefacto y nombre del ejecutable por plataforma. La clave es
 * `${process.platform}-${process.arch}`.
 *
 * `win32-x64` es el `win_amd64` que pide el plan (la máquina de producción);
 * `darwin-arm64` es la de desarrollo donde se verificó.
 */
export const PIPER_TARGETS = Object.freeze({
  'darwin-arm64': {
    asset: 'piper_macos_aarch64.tar.gz',
    archive: 'tar.gz',
    binaryName: 'piper',
    // Ver `PIPER_PHONEMIZE_RELEASE_TAG`: en macOS hay que completar las dylib.
    libsAsset: 'piper-phonemize_macos_aarch64.tar.gz',
    libsExtension: '.dylib',
  },
  'darwin-x64': {
    asset: 'piper_macos_x64.tar.gz',
    archive: 'tar.gz',
    binaryName: 'piper',
    libsAsset: 'piper-phonemize_macos_x64.tar.gz',
    libsExtension: '.dylib',
  },
  'win32-x64': { asset: 'piper_windows_amd64.zip', archive: 'zip', binaryName: 'piper.exe' },
  'linux-x64': { asset: 'piper_linux_x86_64.tar.gz', archive: 'tar.gz', binaryName: 'piper' },
  'linux-arm64': { asset: 'piper_linux_aarch64.tar.gz', archive: 'tar.gz', binaryName: 'piper' },
  'linux-arm': { asset: 'piper_linux_armv7l.tar.gz', archive: 'tar.gz', binaryName: 'piper' },
});

/** Plataformas soportadas, para mensajes de error. */
export const PIPER_SUPPORTED_TARGETS = Object.freeze(Object.keys(PIPER_TARGETS));

/**
 * Voces que instala `setup:piper` por defecto: **una de España y una de México**
 * (los dos locales que pide el criterio de aceptación). Ambas de calidad `medium`
 * (~63 MB cada una): el mejor equilibrio entre naturalidad y tiempo de síntesis
 * para leer chat en vivo.
 */
export const PIPER_DEFAULT_VOICES = Object.freeze(['es_ES-davefx-medium', 'es_MX-ald-medium']);

/** Nombre del manifiesto que deja el script de setup dentro de la instalación. */
export const PIPER_MANIFEST_FILE = 'piper-install.json';

/** Extensiones de los dos archivos que forman un modelo de voz. */
export const PIPER_MODEL_EXTENSION = '.onnx';
export const PIPER_MODEL_CONFIG_EXTENSION = '.onnx.json';

/** Lee una variable de entorno tratando "" y solo-espacios como ausente. */
const envValue = (name, env = process.env) => {
  const raw = env[name];
  if (typeof raw !== 'string') {
    return null;
  }
  const value = raw.trim();
  return value === '' ? null : value;
};

/** Lee un booleano de entorno (`false`, `0` y `no` son falso), como `config.js`. */
export const isPiperEnabled = (env = process.env) => {
  const raw = envValue('TTS_PIPER_ENABLED', env);
  return raw === null ? true : !['false', '0', 'no'].includes(raw.toLowerCase());
};

/**
 * Descriptor de la plataforma actual (o de la pedida), o `null` si Piper no
 * publica binario para ella.
 */
export function resolvePiperTarget(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const target = PIPER_TARGETS[key];
  if (target === undefined) {
    return null;
  }
  return {
    key,
    ...target,
    url: `${PIPER_RELEASE_BASE_URL}/${PIPER_RELEASE_TAG}/${target.asset}`,
    libsUrl:
      target.libsAsset === undefined
        ? null
        : `${PIPER_PHONEMIZE_BASE_URL}/${PIPER_PHONEMIZE_RELEASE_TAG}/${target.libsAsset}`,
  };
}

/**
 * Variable de entorno con la que el cargador dinámico encuentra las bibliotecas
 * del ejecutable, o `null` si la plataforma no la necesita.
 *
 * Hace falta porque **el binario de Piper no trae `LC_RPATH`** (comprobado con
 * `otool -l`): sus dependencias son `@rpath/lib*.dylib` pero no hay ninguna ruta
 * de búsqueda, así que dyld solo mira `/usr/local/lib` y `/usr/lib` y no encuentra
 * las bibliotecas que están **al lado del propio ejecutable**. La alternativa
 * (`install_name_tool -add_rpath`) exige Xcode y volver a firmar el binario en
 * arm64; una variable de entorno al lanzarlo no toca el artefacto descargado.
 *
 * En Windows no se necesita: el cargador busca los `.dll` en el directorio del
 * `.exe` antes que en cualquier otro sitio.
 */
export function dynamicLibraryPathVar(platform = process.platform) {
  if (platform === 'darwin') {
    return 'DYLD_LIBRARY_PATH';
  }
  if (platform === 'win32') {
    return null;
  }
  return 'LD_LIBRARY_PATH';
}

/**
 * Entorno con el que hay que lanzar el ejecutable de Piper: el de siempre más el
 * directorio del binario en la ruta de bibliotecas (ver `dynamicLibraryPathVar()`).
 */
export function piperSpawnEnv(binary, { env = process.env, platform = process.platform } = {}) {
  const variable = dynamicLibraryPathVar(platform);
  if (variable === null) {
    return { ...env };
  }
  const directory = path.dirname(binary);
  const current = env[variable];
  return {
    ...env,
    [variable]: typeof current === 'string' && current !== '' ? `${directory}${path.delimiter}${current}` : directory,
  };
}

/** Igual que `resolvePiperTarget()` pero lanza con un mensaje útil (lo usa el setup). */
export function piperTargetOrThrow(platform = process.platform, arch = process.arch) {
  const target = resolvePiperTarget(platform, arch);
  if (target === null) {
    throw new Error(
      `Piper no publica binario para ${platform}-${arch}. Plataformas soportadas: ${PIPER_SUPPORTED_TARGETS.join(', ')}.`,
    );
  }
  return target;
}

/**
 * Rutas de la instalación. Todo es relativo a `TTS_PIPER_DIR` (default
 * `backend/vendor`), y cada pieza se puede apuntar a otro sitio por entorno.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.platform]
 * @param {string} [options.arch]
 */
export function piperPaths({ env = process.env, platform = process.platform, arch = process.arch } = {}) {
  const root = envValue('TTS_PIPER_DIR', env) ?? path.join(config.backendRoot, 'vendor');
  const target = resolvePiperTarget(platform, arch);
  // El archivo comprimido de la release trae una carpeta `piper/` en la raíz.
  const releaseDir = path.join(root, 'piper');
  return {
    root,
    releaseDir,
    downloadDir: path.join(root, 'downloads'),
    voicesDir: envValue('TTS_PIPER_VOICES_DIR', env) ?? path.join(root, 'piper-voices'),
    manifestFile: path.join(root, PIPER_MANIFEST_FILE),
    /** Ruta convencional del ejecutable; `resolvePiperBinary()` es la que decide. */
    defaultBinary: path.join(releaseDir, target?.binaryName ?? 'piper'),
    binaryOverride: envValue('TTS_PIPER_BIN', env),
  };
}

/** Lee el manifiesto de la instalación, o `null` si no hay (o está corrupto). */
export function readPiperManifest(paths = piperPaths()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.manifestFile, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/** `true` si la ruta es un archivo que se puede ejecutar. */
export function isExecutableFile(file) {
  try {
    if (!fs.statSync(file).isFile()) {
      return false;
    }
    // En Windows `X_OK` no significa nada (siempre pasa), y ahí basta con que el
    // `.exe` exista.
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ejecutable de Piper a usar, o `null` si no hay ninguno. Orden de preferencia:
 *
 * 1. `TTS_PIPER_BIN` — el operador apunta a un Piper instalado por otra vía.
 * 2. el manifiesto que dejó `setup:piper` (sabe la estructura real del archivo).
 * 3. la ruta convencional `<vendor>/piper/piper[.exe]`.
 */
export function resolvePiperBinary(paths = piperPaths()) {
  if (paths.binaryOverride !== null) {
    return isExecutableFile(paths.binaryOverride) ? paths.binaryOverride : null;
  }

  const manifest = readPiperManifest(paths);
  if (typeof manifest?.binary === 'string' && manifest.binary !== '') {
    const fromManifest = path.isAbsolute(manifest.binary) ? manifest.binary : path.join(paths.root, manifest.binary);
    if (isExecutableFile(fromManifest)) {
      return fromManifest;
    }
  }

  return isExecutableFile(paths.defaultBinary) ? paths.defaultBinary : null;
}

/**
 * Descompone el nombre de un modelo (`es_ES-davefx-medium`) en sus partes.
 * Devuelve `null` si no tiene la forma `<locale>-<voz>-<calidad>`.
 */
export function parsePiperModelName(model) {
  const match = /^([a-z]{2,3}_[A-Za-z]{2,4})-(.+)-(x_low|low|medium|high)$/.exec(String(model ?? ''));
  if (match === null) {
    return null;
  }
  const [, locale, speaker, quality] = match;
  return { locale, speaker, quality, language: locale.replace('_', '-') };
}

/**
 * Ruta del modelo dentro del repositorio de voces de Hugging Face, derivada del
 * propio nombre: `es_ES-davefx-medium` → `es/es_ES/davefx/medium`. Así el operador
 * puede pedir cualquier voz del catálogo (`--voice=es_MX-claude-high`) sin que
 * este archivo tenga una lista cerrada.
 */
export function piperVoiceRemotePath(model) {
  const parsed = parsePiperModelName(model);
  if (parsed === null) {
    throw new Error(`Nombre de modelo de Piper no reconocido: "${model}" (esperado <locale>-<voz>-<calidad>).`);
  }
  const family = parsed.locale.split('_')[0];
  return `${family}/${parsed.locale}/${parsed.speaker}/${parsed.quality}`;
}

/** Las dos URLs (modelo y su configuración) de una voz del catálogo oficial. */
export function piperVoiceUrls(model, base = PIPER_VOICES_BASE_URL) {
  const remote = `${base}/${piperVoiceRemotePath(model)}/${model}`;
  return { model: `${remote}${PIPER_MODEL_EXTENSION}`, config: `${remote}${PIPER_MODEL_CONFIG_EXTENSION}` };
}

/** Rutas locales de los dos archivos de una voz. */
export function piperVoiceFiles(model, voicesDir) {
  return {
    model: path.join(voicesDir, `${model}${PIPER_MODEL_EXTENSION}`),
    config: path.join(voicesDir, `${model}${PIPER_MODEL_CONFIG_EXTENSION}`),
  };
}

/**
 * Modelos instalados en `voicesDir`, ordenados por nombre. Un `.onnx` sin su
 * `.onnx.json` al lado se ignora (una descarga a medias no debe aparecer como voz
 * disponible), igual que un `.onnx.json` con configuración ilegible.
 *
 * Devuelve `[{ name, modelFile, configFile, meta }]`, donde `meta` es el JSON de
 * la voz (trae el sample rate y el idioma).
 */
export function listInstalledPiperModels(voicesDir) {
  let names = [];
  try {
    names = fs.readdirSync(voicesDir);
  } catch {
    return [];
  }

  const models = [];
  for (const entry of names.sort()) {
    if (!entry.endsWith(PIPER_MODEL_EXTENSION) || entry.endsWith(PIPER_MODEL_CONFIG_EXTENSION)) {
      continue;
    }
    const name = entry.slice(0, -PIPER_MODEL_EXTENSION.length);
    const files = piperVoiceFiles(name, voicesDir);
    let meta = null;
    try {
      if (fs.statSync(files.model).size === 0) {
        continue;
      }
      meta = JSON.parse(fs.readFileSync(files.config, 'utf8'));
    } catch {
      continue;
    }
    models.push({ name, modelFile: files.model, configFile: files.config, meta });
  }
  return models;
}

/** Sample rate declarado por el modelo (los de Piper son 16000/22050 según calidad). */
export const piperModelSampleRate = (meta) => {
  const rate = Number(meta?.audio?.sample_rate);
  return Number.isFinite(rate) && rate > 0 ? Math.round(rate) : 22_050;
};

/**
 * `length_scale` propio del modelo (1 = velocidad natural). El motor lo multiplica
 * por el factor de pitch, ver `./piper-engine.js`.
 */
export const piperModelLengthScale = (meta) => {
  const scale = Number(meta?.inference?.length_scale);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
};

/**
 * `noise_scale` propio del modelo (ruido del generador VITS; el default de
 * Piper es 0.667 cuando el `.onnx.json` no lo declara). El motor lo multiplica
 * por el factor de timbre, ver `./piper-engine.js`.
 */
export const piperModelNoiseScale = (meta) => {
  const scale = Number(meta?.inference?.noise_scale);
  return Number.isFinite(scale) && scale > 0 ? scale : 0.667;
};

/**
 * `noise_w` propio del modelo (ruido del ancho de fonema; default de Piper
 * 0.8). Mismo tratamiento que `noise_scale`.
 */
export const piperModelNoiseW = (meta) => {
  const noiseW = Number(meta?.inference?.noise_w);
  return Number.isFinite(noiseW) && noiseW > 0 ? noiseW : 0.8;
};

/**
 * Idioma BCP-47 del modelo: primero lo que declare su configuración
 * (`language.code`), y si no, lo que diga su nombre.
 */
export function piperModelLanguage(model) {
  const code = model?.meta?.language?.code;
  if (typeof code === 'string' && code !== '') {
    return code.replace('_', '-');
  }
  return parsePiperModelName(model?.name)?.language ?? null;
}
