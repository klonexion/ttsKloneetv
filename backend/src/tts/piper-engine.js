/**
 * `PiperEngine` (T-010): motor TTS **de servidor** que sintetiza **en local**, sin
 * internet y sin credenciales, invocando el binario de Piper
 * (`https://github.com/rhasspy/piper`) sobre un modelo `.onnx` en español.
 *
 * Es el segundo motor `kind: 'server'` del proyecto y **no añade nada de
 * infraestructura**: la síntesis adelantada, el almacén en memoria, la ruta
 * `GET /api/tts/audio/:id`, el catálogo agregado de `GET /api/voices` y el
 * respaldo al motor del navegador ya son genéricos desde T-009. Aquí solo vive lo
 * que es específico de Piper.
 *
 * ## Decisiones de este módulo
 *
 * - **Proceso hijo, no binding nativo.** Piper se distribuye como ejecutable; no
 *   hay paquete npm oficial y compilar un binding sería una dependencia nativa más
 *   (con node-gyp) para la máquina Windows 11 de producción. Un `spawn` por
 *   enunciado cuesta unos milisegundos frente a los ~500 ms de la síntesis, y como
 *   la síntesis va **por delante** de la cola (ver `./server-audio.js`) ni eso se
 *   nota.
 * - **`--output_raw` y la cabecera WAV la ponemos nosotros.** Piper puede escribir
 *   un `.wav`, pero eso obligaría a gestionar archivos temporales para algo que va
 *   a viajar por HTTP; con `--output_raw` entrega PCM 16 bits mono por su salida
 *   estándar y aquí se envuelve en una cabecera WAV de 44 bytes correcta. `wav` ya
 *   está en `AUDIO_MIME_TYPES`, así que la ruta lo sirve como `audio/wav`.
 * - **El pitch se consigue con la frecuencia de muestreo, compensando la
 *   velocidad.** Piper **no** tiene control de tono (a diferencia del SSML de
 *   edge-tts). Reproducir el PCM a `sampleRate × f` sube el tono un factor `f`
 *   pero también acelera la voz; pedirle a Piper `length_scale × f` (habla más
 *   lento en la misma proporción) devuelve la velocidad a su sitio. El resultado
 *   es un cambio de tono real y barato —solo cambia un número de la cabecera— que
 *   es lo que hace distinguibles a los usuarios cuando T-011 les reparta un pitch
 *   aleatorio en 0.8–1.4. También desplaza los formantes, así que suena "otra
 *   persona", que es justo lo que se busca.
 * - **Si Piper no está instalado, no hay error: hay silencio de voces.**
 *   `listVoices()` devuelve `[]` (las voces `piper:*` no aparecen en
 *   `GET /api/voices`) e `isAvailable()` es `false`. Solo `synthesize()` lanza —y
 *   lanzar es su contrato— para que el enunciado lo lea el motor del navegador. El
 *   registro nunca llama a `isAvailable()` en el camino de un mensaje, así que
 *   tener el motor registrado sin instalación **no cuesta nada**.
 * - **El catálogo se relee cada 30 s.** Es un escaneo de directorio local
 *   (barato), y así el operador que corre `npm run setup:piper` con el backend ya
 *   arriba ve aparecer sus voces sin reiniciar nada.
 * - **Timeout duro y matar el proceso.** Un modelo enorme o un binario a medio
 *   descargar podría quedarse colgado; la síntesis se cancela y el mensaje se lee
 *   con el navegador. Misma lección que T-009 con edge-tts, aquí con un `spawn`.
 * - **Una voz por modelo instalado**, con id `piper:<modelo>`
 *   (`piper:es_ES-davefx-medium`). Los modelos multi-locutor (`num_speakers > 1`)
 *   se exponen solo con su locutor por defecto: el plan fija el id como
 *   `piper:<model>` y no hay UI para elegir locutor.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { TTS_ENGINE_KINDS, TTS_ENGINE_NAMES, formatVoiceId, parseVoiceId } from './engine.js';
import {
  isPiperEnabled,
  listInstalledPiperModels,
  parsePiperModelName,
  piperModelLanguage,
  piperModelLengthScale,
  piperModelNoiseScale,
  piperModelNoiseW,
  piperModelSampleRate,
  piperPaths,
  piperSpawnEnv,
  resolvePiperBinary,
} from './piper-install.js';

/** Formato del audio que produce este motor (lo envolvemos nosotros). */
export const PIPER_AUDIO_FORMAT = 'wav';

/** Tope por síntesis. Es local: una frase de chat tarda menos de un segundo. */
export const PIPER_DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Recorte del factor de pitch. El rango del proyecto (0.8–1.4, Web Speech) cae
 * dentro; pasado de ahí la voz se vuelve ardilla o monstruo y, sobre todo, la
 * compensación de velocidad empieza a sonar artificial.
 */
export const PIPER_PITCH_MIN = 0.75;
export const PIPER_PITCH_MAX = 1.35;

/**
 * Recorte del factor de timbre. Mismo rango que el pitch: `noise_scale` cerca
 * de 0 suena plano/robótico y muy por encima del default se vuelve un
 * borboteo ilegible, así que se recorta al mismo margen "audible sin romperse"
 * que ya probó el pitch.
 */
export const PIPER_TIMBRE_MIN = 0.75;
export const PIPER_TIMBRE_MAX = 1.35;

/** Cada cuánto se vuelve a mirar qué voces hay instaladas. */
export const PIPER_VOICE_CACHE_TTL_MS = 30_000;

/** Formato PCM que entrega Piper con `--output_raw`: 16 bits, mono. */
export const PIPER_PCM_BITS_PER_SAMPLE = 16;
export const PIPER_PCM_CHANNELS = 1;

/** Locales preferidos al elegir voz cuando la instrucción no trae una `piper:*`. */
const PIPER_PREFERRED_LOCALES = Object.freeze(['es-MX', 'es-ES', 'es']);

/** Factor de tono a aplicar, recortado al rango soportado. `1` = sin cambio. */
export function piperPitchFactor(pitch) {
  // Un valor ausente o absurdo es tono neutro; uno legal pero extremo (Web Speech
  // admite 0–2) se recorta, no se ignora.
  const value = typeof pitch === 'number' && Number.isFinite(pitch) ? pitch : 1;
  return Math.min(PIPER_PITCH_MAX, Math.max(PIPER_PITCH_MIN, value));
}

/**
 * Factor de timbre a aplicar, recortado al rango soportado. `1` = el
 * `noise_scale`/`noise_w` propios del modelo, sin cambios. Mismo criterio que
 * `piperPitchFactor()`: se multiplica por el default del modelo (no un valor
 * fijo), así que una voz que ya viene más expresiva sigue estando más
 * expresiva que las demás, solo que también varía con el timbre del usuario.
 */
export function piperTimbreFactor(timbre) {
  const value = typeof timbre === 'number' && Number.isFinite(timbre) ? timbre : 1;
  return Math.min(PIPER_TIMBRE_MAX, Math.max(PIPER_TIMBRE_MIN, value));
}

/**
 * Cabecera WAV (RIFF/PCM) de 44 bytes para el PCM que devuelve Piper. Se genera
 * aquí porque el `sampleRate` que se declara **no** es el del modelo: es el del
 * modelo multiplicado por el factor de pitch (ver la cabecera del módulo).
 */
export function buildWavHeader({
  sampleRate,
  dataLength,
  channels = PIPER_PCM_CHANNELS,
  bitsPerSample = PIPER_PCM_BITS_PER_SAMPLE,
}) {
  const bytesPerSample = (bitsPerSample / 8) * channels;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // tamaño del bloque fmt
  header.writeUInt16LE(1, 20); // 1 = PCM sin comprimir
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * bytesPerSample, 28); // bytes por segundo
  header.writeUInt16LE(bytesPerSample, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLength, 40);
  return header;
}

/** Envuelve el PCM crudo de Piper en un WAV completo y reproducible. */
export function wrapPcmAsWav(pcm, sampleRate) {
  // Un byte impar sería medio sample: los reproductores lo toleran mal.
  const bytes = pcm.length % 2 === 0 ? pcm : pcm.subarray(0, pcm.length - 1);
  return Buffer.concat([buildWavHeader({ sampleRate, dataLength: bytes.length }), bytes]);
}

/** Nombre del modelo pedido por un id `piper:*`, o `null` si el id es de otro motor. */
export function toPiperModelName(voiceId) {
  const parsed = parseVoiceId(voiceId);
  if (parsed === null || parsed.engine !== TTS_ENGINE_NAMES.piper || parsed.name === '') {
    return null;
  }
  return parsed.name;
}

/** Modelo instalado → `TtsVoice` del catálogo, con su id namespaced. */
export function toPiperVoice(model) {
  const language = piperModelLanguage(model);
  const parsed = parsePiperModelName(model.name);
  const speaker = parsed?.speaker ?? model.name;
  const quality = parsed?.quality ?? null;
  return {
    id: formatVoiceId(TTS_ENGINE_NAMES.piper, model.name),
    name: model.name,
    engine: TTS_ENGINE_NAMES.piper,
    language,
    label: `${speaker} (${language ?? 'local'}${quality === null ? '' : `, ${quality}`})`,
  };
}

/**
 * Elige con qué modelo se sintetiza: el pedido si está instalado; si no (o si la
 * instrucción no trae voz `piper:*`, que es el caso de `voiceId: null`), el mejor
 * en español disponible. Devuelve `null` si no hay ningún modelo instalado.
 *
 * Se prefiere caer en otra voz antes que fallar: fallar mandaría el enunciado al
 * motor del navegador, y si el operador instaló Piper es porque quiere oírlo.
 */
export function pickPiperModel(models, voiceId) {
  if (models.length === 0) {
    return null;
  }
  const requested = toPiperModelName(voiceId);
  if (requested !== null) {
    const exact = models.find((model) => model.name === requested);
    if (exact !== undefined) {
      return exact;
    }
  }
  for (const locale of PIPER_PREFERRED_LOCALES) {
    const match = models.find((model) => String(piperModelLanguage(model) ?? '').startsWith(locale));
    if (match !== undefined) {
      return match;
    }
  }
  return models[0];
}

/** Texto tal como se le pasa a Piper: una sola línea (lee línea a línea). */
export const toPiperInputLine = (text) =>
  String(text ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim();

/**
 * Ejecuta Piper y devuelve el PCM crudo de su salida estándar. Rechaza si el
 * proceso falla, no arranca, no devuelve audio o se pasa del tiempo.
 */
function runPiper({ binary, args, input, cwd, env, timeoutMs, spawnImpl }) {
  return new Promise((resolve, reject) => {
    let child = null;
    try {
      child = spawnImpl(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      reject(new Error(`piper: no se pudo ejecutar ${binary} (${error.message})`));
      return;
    }

    const chunks = [];
    let stderr = '';
    let settled = false;

    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error === null) {
        resolve(value);
      } else {
        reject(error);
      }
    };

    // El temporizador NO se hace `unref()`, por la misma razón que en el motor
    // edge-tts (T-009): si no queda nada más pendiente en el bucle de eventos, un
    // temporizador sin referencia no llega a disparar y el timeout no serviría.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`piper: la síntesis no terminó en ${timeoutMs} ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => {
      // Solo el final: el modo verboso de Piper puede escribir mucho.
      stderr = `${stderr}${chunk.toString()}`.slice(-500);
    });
    child.on('error', (error) => finish(new Error(`piper: no se pudo ejecutar ${binary} (${error.message})`)));
    child.on('close', (code) => {
      if (code !== 0) {
        finish(new Error(`piper: terminó con código ${code}${stderr === '' ? '' : ` (${stderr.trim()})`}`));
        return;
      }
      const pcm = Buffer.concat(chunks);
      if (pcm.length === 0) {
        finish(new Error(`piper: no devolvió audio${stderr === '' ? '' : ` (${stderr.trim()})`}`));
        return;
      }
      finish(null, pcm);
    });

    // Si Piper muere antes de leer la entrada, escribir da EPIPE: el fallo real lo
    // reporta el `close` de arriba, así que aquí solo se evita que tumbe el proceso.
    child.stdin.on('error', () => {});
    child.stdin.end(`${input}\n`);
  });
}

/**
 * Crea el motor `piper`. Cumple la interfaz `TTSEngine` de `./engine.js`.
 *
 * @param {object} [options]
 * @param {ReturnType<import('./piper-install.js').piperPaths>} [options.paths] rutas de la instalación.
 * @param {number} [options.timeoutMs]       tope por síntesis.
 * @param {number} [options.voiceCacheTtlMs] cada cuánto se reescanean las voces.
 * @param {Function} [options.spawnImpl]     `child_process.spawn` (inyectable en pruebas).
 * @param {NodeJS.ProcessEnv} [options.env]  entorno del que se leen las `TTS_PIPER_*`.
 */
export function createPiperEngine({
  paths = null,
  timeoutMs = null,
  voiceCacheTtlMs = PIPER_VOICE_CACHE_TTL_MS,
  spawnImpl = nodeSpawn,
  env = process.env,
} = {}) {
  const resolvedPaths = paths ?? piperPaths({ env });
  const resolvedTimeout =
    timeoutMs ?? Number.parseInt(env.TTS_PIPER_TIMEOUT_MS ?? String(PIPER_DEFAULT_TIMEOUT_MS), 10);
  const enabled = isPiperEnabled(env);

  /** Último escaneo de la carpeta de voces, con su marca de tiempo. */
  let cache = { at: 0, models: null };

  const scanModels = () => {
    if (cache.models !== null && Date.now() - cache.at < voiceCacheTtlMs) {
      return cache.models;
    }
    const models = enabled ? listInstalledPiperModels(resolvedPaths.voicesDir) : [];
    cache = { at: Date.now(), models };
    return models;
  };

  /** El ejecutable, o `null` si Piper no está instalado (o está desactivado). */
  const binaryOrNull = () => (enabled ? resolvePiperBinary(resolvedPaths) : null);

  return {
    name: TTS_ENGINE_NAMES.piper,
    kind: TTS_ENGINE_KINDS.server,

    /**
     * Piper está instalado y utilizable: hay ejecutable **y** al menos un modelo.
     * No se llama por mensaje (el registro resuelve de forma sincrónica); sirve
     * para el script de setup y para diagnóstico.
     */
    async isAvailable() {
      return binaryOrNull() !== null && scanModels().length > 0;
    },

    /**
     * Catálogo de voces instaladas. **`[]` si Piper no está instalado**: es la
     * degradación limpia que pide el criterio de T-010 —las voces `piper:*`
     * simplemente no aparecen en `GET /api/voices`— y no un error.
     */
    async listVoices() {
      if (binaryOrNull() === null) {
        return [];
      }
      return scanModels().map(toPiperVoice);
    },

    /**
     * Sintetiza una instrucción TTS ya resuelta por el pipeline. **Lanza** si algo
     * falla (contrato de la interfaz): quien la consume —la capa de audio de
     * servidor— lo registra una vez y el enunciado lo lee el motor del navegador.
     *
     * `volume` se ignora a propósito: se aplica en la reproducción (`<audio>`).
     */
    async synthesize({ text, voiceId, pitch, timbre } = {}) {
      const spoken = toPiperInputLine(text);
      if (spoken === '') {
        throw new Error('piper: no hay texto que sintetizar');
      }

      const binary = binaryOrNull();
      if (binary === null) {
        throw new Error(
          `piper: no está instalado (no hay ejecutable en ${resolvedPaths.releaseDir}); ` +
            'corre `npm --prefix backend run setup:piper`',
        );
      }

      const model = pickPiperModel(scanModels(), voiceId);
      if (model === null) {
        throw new Error(
          `piper: no hay modelos de voz en ${resolvedPaths.voicesDir}; corre \`npm --prefix backend run setup:piper\``,
        );
      }

      const factor = piperPitchFactor(pitch);
      // Habla más despacio en la misma proporción en la que se va a reproducir más
      // rápido: el tono sube y la velocidad queda como estaba.
      const lengthScale = Number((piperModelLengthScale(model.meta) * factor).toFixed(4));
      const sampleRate = Math.round(piperModelSampleRate(model.meta) * factor);

      // Timbre: multiplica el `noise_scale`/`noise_w` propios del modelo, sin
      // tocar la velocidad ni el tono — es un eje aparte del pitch.
      const timbreFactor = piperTimbreFactor(timbre);
      const noiseScale = Number((piperModelNoiseScale(model.meta) * timbreFactor).toFixed(4));
      const noiseW = Number((piperModelNoiseW(model.meta) * timbreFactor).toFixed(4));

      const args = [
        '--model',
        model.modelFile,
        '--config',
        model.configFile,
        '--output_raw',
        '--length_scale',
        String(lengthScale),
        '--noise_scale',
        String(noiseScale),
        '--noise_w',
        String(noiseW),
      ];

      // El binario de la release lleva su fonemizador al lado; pasarle la ruta
      // explícita evita depender de cuál sea el directorio de trabajo.
      const espeakData = path.join(path.dirname(binary), 'espeak-ng-data');
      if (fs.existsSync(espeakData)) {
        args.push('--espeak_data', espeakData);
      }

      const pcm = await runPiper({
        binary,
        args,
        input: spoken,
        cwd: path.dirname(binary),
        // Sin esto el binario de macOS no arranca: no trae `LC_RPATH` y no
        // encuentra sus propias bibliotecas (ver `piperSpawnEnv()`).
        env: piperSpawnEnv(binary, { env }),
        timeoutMs: resolvedTimeout,
        spawnImpl,
      });

      return { format: PIPER_AUDIO_FORMAT, base64: wrapPcmAsWav(pcm, sampleRate).toString('base64') };
    },
  };
}
