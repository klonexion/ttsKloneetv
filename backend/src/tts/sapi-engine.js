/**
 * `SapiEngine` y `LoquendoEngine`: motores TTS **de servidor** sobre las voces
 * SAPI que ya trae (o tiene instaladas) Windows. `sapi` para las nativas de
 * Windows y cualquier otro fabricante; `loquendo` es un catálogo aparte para
 * las de Loquendo TTS 7, si están instaladas — mismo mecanismo, filtrado por
 * el atributo `Vendor` que SAPI ya expone (no una lista de nombres a mano: si
 * el operador instala más voces Loquendo más adelante, aparecen solas en su
 * grupo). Los dos son locales: sin descarga, sin internet y sin binario propio
 * que instalar — usan lo que el sistema operativo ya tiene.
 *
 * ## Decisiones
 *
 * - **Solo Windows.** SAPI es una API de Windows; en cualquier otra plataforma
 *   los dos motores se degradan limpio (catálogo vacío, `isAvailable() ===
 *   false`), igual que Piper sin instalar. No hace falta comprobar la
 *   plataforma en cada método: se resuelve una vez al crear el motor.
 * - **PowerShell propio, sin el paquete `say`.** Antes se usaba `say` (que
 *   también lanza PowerShell por dentro), pero `say` hardcodea el comando
 *   `'powershell'` resuelto por `PATH` — y eso deja voces afuera, ver el punto
 *   siguiente. Se sintetiza igual que Piper: un proceso hijo por enunciado, el
 *   texto viaja por `stdin` (no se interpola en el script) así que un mensaje
 *   de chat no puede inyectar PowerShell; el nombre de voz sí se interpola,
 *   pero sale de nuestro propio catálogo (`GetInstalledVoices`), nunca del
 *   usuario.
 * - **Se prefiere el PowerShell de 32 bits (`SysWOW64`).** Comprobado en la
 *   máquina de este proyecto: Loquendo TTS 7 solo registra su COM en la vista
 *   de 32 bits del registro (`WOW6432Node`); un PowerShell de 64 bits ni lo ve.
 *   La vista de 32 bits, en cambio, ve **también** las voces nativas de
 *   Microsoft (Windows las registra en ambas), así que usarla siempre da un
 *   catálogo igual o más completo — nunca menos. Si la máquina no tiene
 *   `SysWOW64` (nada que ver en este proyecto: la producción es Windows 11
 *   x64), se cae a `'powershell'` del `PATH`.
 * - **La separación en dos motores usa `Vendor`, un atributo real de SAPI**
 *   (`VoiceInfo.AdditionalInfo['Vendor']`), no el nombre de la voz: es lo que
 *   deja que ambos catálogos aparezcan como grupos separados en el selector
 *   (T-011 agrupa por `engine`), sin mantener una lista de nombres a mano.
 * - **Catálogo con metadatos reales.** Se listan las voces con nuestro propio
 *   PowerShell, pidiendo `Name/Culture/Gender/Vendor` como JSON, para tener
 *   `language` en el `TtsVoice` (lo que pinta el selector de T-011).
 * - **El pitch se consigue igual que en Piper: cambiando la frecuencia de la
 *   cabecera WAV y compensando la velocidad al revés.** SAPI no tiene control de
 *   tono, pero sí de velocidad (`$speak.Rate`, escala −10…10). Se le pide
 *   hablar a `1 / factor` (convertido a la escala de `Rate` con la misma curva
 *   logarítmica que usaba `say`) para que al reproducir el WAV a
 *   `sampleRate × factor` la duración vuelva a la suya y el tono quede
 *   desplazado — mismo truco, mismo rango de recorte que `piperPitchFactor`
 *   para que los usuarios se oigan parecido crucen el motor que crucen.
 * - **Voz de exportación a archivo temporal, no streaming.** A diferencia de
 *   Piper (que entrega PCM por su salida estándar), `SetOutputToWaveFile` de SAPI
 *   solo sabe escribir un archivo; se usa `os.tmpdir()` con un nombre único y se
 *   borra en el `finally`, pase lo que pase.
 * - **Timeout duro y matar el proceso.** Igual criterio que edge-tts y Piper: un
 *   proceso por llamada (no uno compartido) para que matar por timeout no
 *   afecte a una síntesis concurrente.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';

import { buildWavHeader } from './piper-engine.js';
import { TTS_ENGINE_KINDS, TTS_ENGINE_NAMES, formatVoiceId, parseVoiceId } from './engine.js';

/** Formato del audio que producen estos motores (lo envolvemos nosotros). */
export const SAPI_AUDIO_FORMAT = 'wav';

/** Tope por síntesis. Es local: una frase de chat tarda menos de un segundo. */
export const SAPI_DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Recorte del factor de pitch. Mismo rango que `PIPER_PITCH_MIN`/`MAX`: el que
 * reparte T-011 entre usuarios (0.8–1.4) cae dentro, y así los usuarios suenan
 * igual de distinguibles crucen el motor que crucen.
 */
export const SAPI_PITCH_MIN = 0.75;
export const SAPI_PITCH_MAX = 1.35;

/** Mismo rango de entrada que el pitch; ver `sapiTimbreRateDelta()` para qué hace con él. */
export const SAPI_TIMBRE_MIN = 0.75;
export const SAPI_TIMBRE_MAX = 1.35;

/**
 * Tope del delta de `Rate` que aporta el timbre, aparte del que ya pide la
 * compensación de pitch. SAPI no tiene ruido de generador como Piper/MeloTTS
 * (System.Speech no expone nada parecido): la única variación de textura
 * disponible es la velocidad, así que el timbre se traduce a un empujón extra
 * de `Rate` — chico a propósito (3 de los ±10 totales) para no competir con la
 * compensación de pitch ni sonar como un cambio de velocidad en sí mismo.
 */
export const SAPI_TIMBRE_RATE_LIMIT = 3;

/** Cada cuánto se vuelve a preguntar a Windows qué voces hay instaladas. */
export const SAPI_VOICE_CACHE_TTL_MS = 5 * 60 * 1000;

/** Locales preferidos al elegir voz cuando la instrucción no trae voz de este motor. */
const SAPI_PREFERRED_LOCALES = Object.freeze(['es-MX', 'es-ES', 'es']);

/** Vendor SAPI (`AdditionalInfo['Vendor']`) que separa el catálogo de Loquendo. */
const LOQUENDO_VENDOR = 'Loquendo';

/** Lee una variable de entorno tratando "" y solo-espacios como ausente. */
const envValue = (name, env) => {
  const raw = env[name];
  if (typeof raw !== 'string') {
    return null;
  }
  const value = raw.trim();
  return value === '' ? null : value;
};

/** Lee un booleano de entorno (`false`, `0` y `no` son falso), como los otros motores. */
const envFlag = (name, env) => {
  const raw = envValue(name, env);
  return raw === null ? true : !['false', '0', 'no'].includes(raw.toLowerCase());
};

/** `TTS_SAPI_ENABLED`: por default activo. */
export const isSapiEnabled = (env = process.env) => envFlag('TTS_SAPI_ENABLED', env);

/** `TTS_LOQUENDO_ENABLED`: por default activo (no hace nada si no hay voces Loquendo). */
export const isLoquendoEnabled = (env = process.env) => envFlag('TTS_LOQUENDO_ENABLED', env);

/** Factor de tono a aplicar, recortado al rango soportado. `1` = sin cambio. */
export function sapiPitchFactor(pitch) {
  const value = typeof pitch === 'number' && Number.isFinite(pitch) ? pitch : 1;
  return Math.min(SAPI_PITCH_MAX, Math.max(SAPI_PITCH_MIN, value));
}

/**
 * PowerShell a usar para hablar con SAPI. Ver la cabecera del módulo: el de
 * 32 bits ve un superconjunto de voces en esta máquina (Loquendo TTS 7 incluido).
 */
export function resolvePowerShellBinary(platform = process.platform, env = process.env) {
  if (platform !== 'win32') {
    return 'powershell';
  }
  const systemRoot = envValue('SystemRoot', env) ?? envValue('windir', env) ?? 'C:\\Windows';
  const candidate = path.join(systemRoot, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return existsSync(candidate) ? candidate : 'powershell';
}

/**
 * Razón de velocidad (1.0 = normal) → escala `Rate` de SAPI (−10…10, entero).
 * Curva logarítmica: es la misma que usaba el paquete `say` para este mapeo,
 * probada en producción; se conserva al reemplazarlo por PowerShell propio.
 */
export function sapiRateFromSpeed(speed) {
  const value = typeof speed === 'number' && Number.isFinite(speed) && speed > 0 ? speed : 1;
  return Math.max(-10, Math.min(Math.round(9.0686 * Math.log(value) - 0.1806), 10));
}

/**
 * Delta de `Rate` que aporta el timbre, en [−`SAPI_TIMBRE_RATE_LIMIT`,
 * +`SAPI_TIMBRE_RATE_LIMIT`]. Mapeo lineal (no logarítmico como el del pitch:
 * acá no hay que cancelar un cambio de duración, es un empujón aparte) sobre
 * el rango de entrada recortado a [`SAPI_TIMBRE_MIN`, `SAPI_TIMBRE_MAX`]. Se
 * suma (no se compone) con el `Rate` que ya pide la compensación de pitch, y
 * el resultado final se recorta otra vez a −10…10 en `synthesize()`.
 *
 * Los dos lados se escalan **por separado** (el tramo bajo con su propio
 * span, el alto con el suyo) en vez de interpolar linealmente todo el rango
 * de una: `SAPI_TIMBRE_MIN`/`MAX` (0.75/1.35) no son simétricos respecto de 1,
 * así que una interpolación de un solo tramo manda el timbre neutro a un
 * delta que no es exactamente 0 (rompía justo ahí, con un −1 en vez de 0).
 */
export function sapiTimbreRateDelta(timbre) {
  const value = typeof timbre === 'number' && Number.isFinite(timbre) ? timbre : 1;
  const clamped = Math.min(SAPI_TIMBRE_MAX, Math.max(SAPI_TIMBRE_MIN, value));
  if (clamped === 1) {
    return 0;
  }
  const span = clamped > 1 ? SAPI_TIMBRE_MAX - 1 : 1 - SAPI_TIMBRE_MIN;
  return Math.round(((clamped - 1) / span) * SAPI_TIMBRE_RATE_LIMIT);
}

/** Nombre de voz pedido por un id `<engineName>:*`, o `null` si el id es de otro motor. */
export function toSapiVoiceName(voiceId, engineName = TTS_ENGINE_NAMES.sapi) {
  const parsed = parseVoiceId(voiceId);
  if (parsed === null || parsed.engine !== engineName || parsed.name === '') {
    return null;
  }
  return parsed.name;
}

/** Voz de `GetInstalledVoices()` → `TtsVoice` del catálogo, con su id namespaced. */
export function toSapiVoice(voice, engineName = TTS_ENGINE_NAMES.sapi) {
  const name = String(voice?.Name ?? '');
  const culture = typeof voice?.Culture === 'string' && voice.Culture !== '' ? voice.Culture : null;
  const gender = voice?.Gender === 'Female' ? 'mujer' : voice?.Gender === 'Male' ? 'hombre' : null;
  return {
    id: formatVoiceId(engineName, name),
    name,
    engine: engineName,
    language: culture,
    label: `${name}${culture === null && gender === null ? '' : ` (${[culture, gender].filter(Boolean).join(', ')})`}`,
  };
}

/**
 * Elige con qué voz se sintetiza: la pedida si está instalada; si no (o si la
 * instrucción no trae voz de este motor, que es el caso de `voiceId: null`),
 * la mejor en español instalada. Devuelve `null` si el catálogo está vacío.
 */
export function pickSapiVoice(voices, voiceId, engineName = TTS_ENGINE_NAMES.sapi) {
  if (voices.length === 0) {
    return null;
  }
  const requested = toSapiVoiceName(voiceId, engineName);
  if (requested !== null) {
    const exact = voices.find((voice) => voice.Name === requested);
    if (exact !== undefined) {
      return exact;
    }
  }
  for (const locale of SAPI_PREFERRED_LOCALES) {
    const match = voices.find((voice) => String(voice.Culture ?? '').startsWith(locale));
    if (match !== undefined) {
      return match;
    }
  }
  return voices[0];
}

/** Texto tal como se le pasa a SAPI: una sola línea. */
export const toSapiInputLine = (text) =>
  String(text ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim();

/** Escapa comillas simples para interpolar un valor en un script de PowerShell. */
const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * Corre un script de PowerShell con tope de tiempo. `input`, si se da, viaja
 * por `stdin` (nunca interpolado en el script). Devuelve `{ code, stdout }`;
 * nunca rechaza — el llamador decide qué hacer con un `code !== 0`.
 */
function runPowerShell({ binary, script, input = null, spawnImpl, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(binary, ['-NoProfile', '-NonInteractive', '-Command', script], {
        stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      resolve({ code: null, stdout: '', stderr: '' });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };

    // NO se hace unref(): si el proceso se cuelga y no queda nada más pendiente,
    // un temporizador sin referencia no llegaría a disparar (mismo criterio que
    // Piper, ver la cabecera del módulo).
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-500);
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));

    if (input !== null) {
      // Si PowerShell muere antes de leer la entrada, escribir da EPIPE: el
      // fallo real lo reporta el `close` de arriba (mismo criterio que Piper).
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

/**
 * Lista **todas** las voces instaladas (`Name`, `Culture`, `Gender`, `Vendor`)
 * como JSON, sin filtrar por motor — cada `createWindowsVoiceEngine` filtra lo
 * suyo. `@(...)` fuerza que salga siempre un array, incluso con cero o una voz
 * (sin eso `ConvertTo-Json` desenrolla el array de un elemento).
 */
async function listInstalledSapiVoices({ binary, spawnImpl, timeoutMs }) {
  const script =
    'Add-Type -AssemblyName System.Speech;' +
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;' +
    '$voices = @($s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo } | ' +
    'ForEach-Object { [PSCustomObject]@{ Name = $_.Name; Culture = $_.Culture.Name; ' +
    'Gender = $_.Gender.ToString(); Vendor = $_.AdditionalInfo[\'Vendor\'] } });' +
    'ConvertTo-Json -InputObject $voices -Compress';

  const { code, stdout } = await runPowerShell({ binary, script, spawnImpl, timeoutMs });
  if (code !== 0 || stdout.trim() === '') {
    return [];
  }
  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/** Sintetiza con SAPI a un archivo WAV. Lanza si PowerShell falla o se cuelga. */
async function speakToFile({ binary, spawnImpl, timeoutMs, text, voiceName, rate, outputFile, engineName }) {
  const script =
    'Add-Type -AssemblyName System.Speech;' +
    '$speak = New-Object System.Speech.Synthesis.SpeechSynthesizer;' +
    `$speak.SelectVoice(${psQuote(voiceName)});` +
    `$speak.Rate = ${rate};` +
    `$speak.SetOutputToWaveFile(${psQuote(outputFile)});` +
    '$speak.Speak([Console]::In.ReadToEnd());' +
    '$speak.Dispose()';

  const { code, stderr } = await runPowerShell({ binary, script, input: text, spawnImpl, timeoutMs });
  if (code === null) {
    throw new Error(`${engineName}: la síntesis no terminó en ${timeoutMs} ms`);
  }
  if (code !== 0) {
    throw new Error(`${engineName}: PowerShell terminó con código ${code}${stderr === '' ? '' : ` (${stderr.trim()})`}`);
  }
}

/** Cabecera + datos de un WAV PCM: busca el `fmt ` y el `data` recorriendo los bloques. */
function parseWav(buffer, engineName) {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${engineName}: SAPI no devolvió un WAV válido`);
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buffer.subarray(body, body + size);
    }
    offset = body + size + (size % 2); // los bloques van alineados a palabra
  }
  if (fmt === null || data === null) {
    throw new Error(`${engineName}: el WAV de SAPI no trae los bloques fmt/data esperados`);
  }
  return { ...fmt, data };
}

/**
 * Fábrica compartida: crea un motor sobre SAPI filtrado por `voiceFilter`.
 * `createSapiEngine()` y `createLoquendoEngine()` son wrappers finos sobre
 * esto, con el filtro y el nombre de motor que corresponde a cada uno — ver la
 * cabecera del módulo. Cumple la interfaz `TTSEngine` de `./engine.js`.
 *
 * @param {object} options
 * @param {string} options.engineName            namespace del motor (`'sapi'` | `'loquendo'`).
 * @param {(voice: object) => boolean} options.voiceFilter  qué voces de Windows le tocan a este motor.
 * @param {boolean} options.enabledByFlag         resultado de `isSapiEnabled()`/`isLoquendoEnabled()`.
 * @param {number} [options.timeoutMs]            tope por síntesis y por catálogo.
 * @param {number} [options.voiceCacheTtlMs]      cada cuánto se vuelve a preguntar a Windows.
 * @param {Function} [options.spawnImpl]          `child_process.spawn` (inyectable en pruebas).
 * @param {string} [options.powershellBinary]     ejecutable de PowerShell (inyectable en pruebas).
 * @param {NodeJS.ProcessEnv} [options.env]       entorno (para resolver el binario si no se da).
 * @param {string} [options.platform]             plataforma (inyectable en pruebas).
 */
function createWindowsVoiceEngine({
  engineName,
  voiceFilter,
  enabledByFlag,
  timeoutMs = SAPI_DEFAULT_TIMEOUT_MS,
  voiceCacheTtlMs = SAPI_VOICE_CACHE_TTL_MS,
  spawnImpl = nodeSpawn,
  powershellBinary = null,
  env = process.env,
  platform = process.platform,
}) {
  const enabled = enabledByFlag && platform === 'win32';
  const binary = powershellBinary ?? resolvePowerShellBinary(platform, env);

  /** Último catálogo (ya filtrado), con su marca de tiempo. */
  let cache = { at: 0, voices: null };

  const scanVoices = async () => {
    if (!enabled) {
      return [];
    }
    if (cache.voices !== null && Date.now() - cache.at < voiceCacheTtlMs) {
      return cache.voices;
    }
    const all = await listInstalledSapiVoices({ binary, spawnImpl, timeoutMs });
    const voices = all.filter(voiceFilter);
    cache = { at: Date.now(), voices };
    return voices;
  };

  return {
    name: engineName,
    kind: TTS_ENGINE_KINDS.server,

    /** Windows, con al menos una voz de este catálogo instalada. No se llama en el camino de un mensaje. */
    async isAvailable() {
      return (await scanVoices()).length > 0;
    },

    /** Catálogo de voces de este motor. `[]` fuera de Windows, desactivado, o sin voces. */
    async listVoices() {
      return (await scanVoices()).map((voice) => toSapiVoice(voice, engineName));
    },

    /**
     * Sintetiza una instrucción TTS ya resuelta por el pipeline. Lanza si algo
     * falla (contrato de la interfaz): quien la consume lo registra una vez y el
     * enunciado lo lee el motor del navegador.
     *
     * `volume` se ignora a propósito: se aplica en la reproducción (`<audio>`).
     */
    async synthesize({ text, voiceId, pitch, timbre } = {}) {
      const spoken = toSapiInputLine(text);
      if (spoken === '') {
        throw new Error(`${engineName}: no hay texto que sintetizar`);
      }
      if (!enabled) {
        throw new Error(
          `${engineName}: no disponible en esta plataforma (System.Speech es de Windows); ` +
            'este mensaje lo lee el navegador',
        );
      }

      const voices = await scanVoices();
      const voice = pickSapiVoice(voices, voiceId, engineName);
      if (voice === null) {
        throw new Error(`${engineName}: no hay ninguna voz instalada de este catálogo`);
      }

      const factor = sapiPitchFactor(pitch);
      const tmpFile = path.join(os.tmpdir(), `tts-hub-${engineName}-${randomUUID()}.wav`);

      try {
        // Habla más despacio en la proporción inversa al pitch: al reproducir el
        // WAV a `sampleRate × factor` la duración vuelve a la suya (mismo truco
        // que Piper con `length_scale`, ver la cabecera del módulo). El timbre se
        // suma aparte, como un empujón chico de `Rate` (ver `sapiTimbreRateDelta`).
        const rate = Math.max(-10, Math.min(10, sapiRateFromSpeed(1 / factor) + sapiTimbreRateDelta(timbre)));
        await speakToFile({
          binary,
          spawnImpl,
          timeoutMs,
          text: spoken,
          voiceName: voice.Name,
          rate,
          outputFile: tmpFile,
          engineName,
        });

        const raw = await fs.readFile(tmpFile);
        const { channels, bitsPerSample, sampleRate: nativeRate, data } = parseWav(raw, engineName);
        const sampleRate = Math.round(nativeRate * factor);
        const wav = Buffer.concat([buildWavHeader({ sampleRate, dataLength: data.length, channels, bitsPerSample }), data]);
        return { format: SAPI_AUDIO_FORMAT, base64: wav.toString('base64') };
      } finally {
        await fs.rm(tmpFile, { force: true });
      }
    },
  };
}

/**
 * Crea el motor `sapi`: todas las voces de Windows salvo las de Loquendo (que
 * tienen su propio motor, ver `createLoquendoEngine`). Mismas opciones que
 * `createWindowsVoiceEngine`, menos `engineName`/`voiceFilter`/`enabledByFlag`.
 */
export function createSapiEngine({ env = process.env, ...options } = {}) {
  return createWindowsVoiceEngine({
    ...options,
    env,
    engineName: TTS_ENGINE_NAMES.sapi,
    voiceFilter: (voice) => voice?.Vendor !== LOQUENDO_VENDOR,
    enabledByFlag: isSapiEnabled(env),
  });
}

/**
 * Crea el motor `loquendo`: solo las voces cuyo `Vendor` de SAPI es
 * `'Loquendo'`. Si no hay ninguna instalada (la mayoría de las máquinas), el
 * catálogo sale vacío — misma degradación limpia que el resto. Mismas
 * opciones que `createWindowsVoiceEngine`, menos
 * `engineName`/`voiceFilter`/`enabledByFlag`.
 */
export function createLoquendoEngine({ env = process.env, ...options } = {}) {
  return createWindowsVoiceEngine({
    ...options,
    env,
    engineName: TTS_ENGINE_NAMES.loquendo,
    voiceFilter: (voice) => voice?.Vendor === LOQUENDO_VENDOR,
    enabledByFlag: isLoquendoEnabled(env),
  });
}
