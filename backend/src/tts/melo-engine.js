/**
 * `MeloEngine`: motor TTS **de servidor** sobre MeloTTS en español, servido por
 * el contenedor de `docker/melotts/` (`docker compose up -d melotts`).
 *
 * Es una síntesis neuronal de mejor calidad que Piper, con pesos **MIT** (a
 * diferencia de XTTS-v2 o Fish Speech, que son de uso no-comercial) — la única
 * opción de este nivel que no obliga a leer letra chica de licencia para
 * usarla en un canal que genera ingresos. Corre en un contenedor aparte (no en
 * el proceso Node) porque el modelo es PyTorch: no hay binding a Node, y
 * empaquetarlo como proceso hijo (como Piper) exigiría un intérprete Python
 * completo dentro del propio backend.
 *
 * ## Decisiones
 *
 * - **HTTP, no proceso hijo.** El contenedor expone `GET /health` y
 *   `POST /speak`; este módulo es un cliente HTTP con timeout duro, en el
 *   mismo espíritu que edge-tts (motor "de red", aunque acá la red sea
 *   `localhost`). Si el contenedor no está levantado, **no es un error**: es
 *   la misma degradación limpia que Piper sin instalar — el catálogo sale
 *   vacío y el motor no aparece en `GET /api/voices`.
 * - **El pitch se consigue igual que en Piper y SAPI: pidiendo velocidad
 *   inversa y reescribiendo la cabecera del WAV.** El servidor de MeloTTS no
 *   sabe de tono, solo de `speed`; se le pide hablar a `1 / factor` y se
 *   reproduce el WAV resultante a `sampleRate × factor`, que sube el tono y
 *   cancela el cambio de duración. Mismo rango de recorte que
 *   `piperPitchFactor`/`sapiPitchFactor` para que los usuarios suenen
 *   parecido crucen el motor que crucen.
 * - **El timbre sí viaja directo, sin truco.** MeloTTS es VITS como Piper y
 *   expone los mismos `noise_scale`/`noise_scale_w`; a diferencia del pitch,
 *   estos no afectan duración ni frecuencia, así que no hace falta reescribir
 *   nada del WAV — se calculan acá (default MeloTTS 0.6/0.8, multiplicados por
 *   el factor de timbre) y se mandan tal cual en el cuerpo del POST.
 * - **Catálogo cacheado con TTL**, igual que edge-tts: `GET /health` es
 *   barata pero no hay que pegarle en cada mensaje.
 */
import { TTS_ENGINE_KINDS, TTS_ENGINE_NAMES, formatVoiceId, parseVoiceId } from './engine.js';
import { buildWavHeader } from './piper-engine.js';

/** Formato del audio que produce este motor (lo envolvemos nosotros). */
export const MELO_AUDIO_FORMAT = 'wav';

/** Tope por request HTTP (catálogo y síntesis). Es local: no debería tardar. */
export const MELO_DEFAULT_TIMEOUT_MS = 20_000;

/** Mismo rango que Piper/SAPI: el que reparte T-011 entre usuarios (0.8–1.4) cae dentro. */
export const MELO_PITCH_MIN = 0.75;
export const MELO_PITCH_MAX = 1.35;

/** Mismo rango que `PIPER_TIMBRE_MIN`/`MAX`: ver esa constante para el porqué. */
export const MELO_TIMBRE_MIN = 0.75;
export const MELO_TIMBRE_MAX = 1.35;

/** `noise_scale`/`noise_scale_w` por default de MeloTTS (los de `docker/melotts/server.py`). */
export const MELO_DEFAULT_NOISE_SCALE = 0.6;
export const MELO_DEFAULT_NOISE_SCALE_W = 0.8;

/** Cada cuánto se vuelve a preguntar al contenedor si sigue arriba. */
export const MELO_VOICE_CACHE_TTL_MS = 60_000;

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
export const isMeloEnabled = (env = process.env) => {
  const raw = envValue('TTS_MELO_ENABLED', env);
  return raw === null ? true : !['false', '0', 'no'].includes(raw.toLowerCase());
};

/** Base URL del contenedor. Default: el puerto que publica `docker-compose.yml`. */
export const meloBaseUrl = (env = process.env) => envValue('TTS_MELO_URL', env) ?? 'http://localhost:8100';

/** Factor de tono a aplicar, recortado al rango soportado. `1` = sin cambio. */
export function meloPitchFactor(pitch) {
  const value = typeof pitch === 'number' && Number.isFinite(pitch) ? pitch : 1;
  return Math.min(MELO_PITCH_MAX, Math.max(MELO_PITCH_MIN, value));
}

/** Factor de timbre a aplicar, recortado al rango soportado. `1` = sin cambio. */
export function meloTimbreFactor(timbre) {
  const value = typeof timbre === 'number' && Number.isFinite(timbre) ? timbre : 1;
  return Math.min(MELO_TIMBRE_MAX, Math.max(MELO_TIMBRE_MIN, value));
}

/** Nombre de locutor pedido por un id `melo:*`, o `null` si el id es de otro motor. */
export function toMeloSpeakerName(voiceId) {
  const parsed = parseVoiceId(voiceId);
  if (parsed === null || parsed.engine !== TTS_ENGINE_NAMES.melo || parsed.name === '') {
    return null;
  }
  return parsed.name;
}

/**
 * Locutor de `GET /health` → `TtsVoice` del catálogo, con su id namespaced. El
 * contenedor manda el idioma en mayúsculas (`'ES'`, la convención interna de
 * MeloTTS); se pasa a minúsculas para que combine con el estilo `es-MX`/`es-ES`
 * del resto del catálogo (edge, piper) y con `isPreferredLanguage()`.
 */
export function toMeloVoice(speaker, language) {
  const lang = typeof language === 'string' && language !== '' ? language.toLowerCase() : null;
  return {
    id: formatVoiceId(TTS_ENGINE_NAMES.melo, speaker),
    name: speaker,
    engine: TTS_ENGINE_NAMES.melo,
    language: lang,
    label: `MeloTTS ${speaker}${lang ? ` (${lang})` : ''}`,
  };
}

/** Elige el locutor: el pedido si existe en el catálogo; si no, el primero. */
export function pickMeloSpeaker(speakers, voiceId) {
  if (speakers.length === 0) {
    return null;
  }
  const requested = toMeloSpeakerName(voiceId);
  if (requested !== null && speakers.includes(requested)) {
    return requested;
  }
  return speakers[0];
}

/** Texto tal como se le manda al contenedor: una sola línea. */
export const toMeloInputLine = (text) =>
  String(text ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim();

/** `fetch` con un timeout duro que rechaza, para no colgar la cola si el contenedor no responde. */
async function fetchWithTimeout(url, options, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Cabecera + datos de un WAV PCM: busca `fmt ` y `data` recorriendo los bloques. */
function parseWav(buffer) {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('melo: el contenedor no devolvió un WAV válido');
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
    offset = body + size + (size % 2);
  }
  if (fmt === null || data === null) {
    throw new Error('melo: el WAV del contenedor no trae los bloques fmt/data esperados');
  }
  return { ...fmt, data };
}

/**
 * Crea el motor `melo`. Cumple la interfaz `TTSEngine` de `./engine.js`.
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl]           URL del contenedor (`docker compose up -d melotts`).
 * @param {number} [options.timeoutMs]         tope por request HTTP.
 * @param {number} [options.voiceCacheTtlMs]   cada cuánto se vuelve a preguntar `/health`.
 * @param {Function} [options.fetchImpl]       `fetch` (inyectable en pruebas).
 * @param {NodeJS.ProcessEnv} [options.env]    entorno del que se leen las `TTS_MELO_*`.
 */
export function createMeloEngine({
  baseUrl = null,
  timeoutMs = null,
  voiceCacheTtlMs = MELO_VOICE_CACHE_TTL_MS,
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  const enabled = isMeloEnabled(env);
  const url = baseUrl ?? meloBaseUrl(env);
  const resolvedTimeout =
    timeoutMs ?? Number.parseInt(env.TTS_MELO_TIMEOUT_MS ?? String(MELO_DEFAULT_TIMEOUT_MS), 10);

  /** Último catálogo, con su marca de tiempo. `null` = todavía no se preguntó. */
  let cache = { at: 0, speakers: null, language: null };

  const scanHealth = async () => {
    if (!enabled) {
      return { speakers: [], language: null };
    }
    if (cache.speakers !== null && Date.now() - cache.at < voiceCacheTtlMs) {
      return cache;
    }
    try {
      const response = await fetchWithTimeout(`${url}/health`, { method: 'GET' }, resolvedTimeout, fetchImpl);
      if (!response.ok) {
        cache = { at: Date.now(), speakers: [], language: null };
        return cache;
      }
      const body = await response.json();
      const speakers = Array.isArray(body?.speakers) ? body.speakers.filter((s) => typeof s === 'string') : [];
      cache = { at: Date.now(), speakers, language: typeof body?.language === 'string' ? body.language : null };
      return cache;
    } catch {
      // Contenedor caído, timeout, red rara: catálogo vacío, no una excepción
      // (mismo criterio que Piper sin instalar / edge-tts sin internet).
      cache = { at: Date.now(), speakers: [], language: null };
      return cache;
    }
  };

  return {
    name: TTS_ENGINE_NAMES.melo,
    kind: TTS_ENGINE_KINDS.server,

    /** El contenedor responde y tiene al menos un locutor. No se llama por mensaje. */
    async isAvailable() {
      return (await scanHealth()).speakers.length > 0;
    },

    /** Catálogo del contenedor. `[]` si está caído, desactivado, o sin locutores. */
    async listVoices() {
      const { speakers, language } = await scanHealth();
      return speakers.map((speaker) => toMeloVoice(speaker, language));
    },

    /**
     * Sintetiza una instrucción TTS ya resuelta por el pipeline. Lanza si algo
     * falla (contrato de la interfaz): quien la consume lo registra una vez y
     * el enunciado lo lee el motor del navegador.
     *
     * `volume` se ignora a propósito: se aplica en la reproducción (`<audio>`).
     */
    async synthesize({ text, voiceId, pitch, timbre } = {}) {
      const spoken = toMeloInputLine(text);
      if (spoken === '') {
        throw new Error('melo: no hay texto que sintetizar');
      }
      if (!enabled) {
        throw new Error('melo: motor desactivado (TTS_MELO_ENABLED=false); este mensaje lo lee el navegador');
      }

      const { speakers } = await scanHealth();
      const speaker = pickMeloSpeaker(speakers, voiceId);
      if (speaker === null) {
        throw new Error(
          `melo: el contenedor no responde en ${url} (¿corriste \`docker compose up -d melotts\`?); ` +
            'este mensaje lo lee el navegador',
        );
      }

      const factor = meloPitchFactor(pitch);
      const timbreFactor = meloTimbreFactor(timbre);
      let response;
      try {
        response = await fetchWithTimeout(
          `${url}/speak`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              text: spoken,
              // Habla más despacio en la proporción inversa al pitch: al reproducir
              // el WAV a `sampleRate × factor` la duración vuelve a la suya (mismo
              // truco que Piper/SAPI, ver la cabecera del módulo).
              speed: 1 / factor,
              speaker,
              // El timbre no necesita truco: se manda directo, ver la cabecera del módulo.
              noise_scale: Number((MELO_DEFAULT_NOISE_SCALE * timbreFactor).toFixed(4)),
              noise_scale_w: Number((MELO_DEFAULT_NOISE_SCALE_W * timbreFactor).toFixed(4)),
            }),
          },
          resolvedTimeout,
          fetchImpl,
        );
      } catch (error) {
        throw new Error(`melo: no se pudo hablar con el contenedor (${error.message})`);
      }
      if (!response.ok) {
        throw new Error(`melo: el contenedor respondió ${response.status}`);
      }

      const raw = Buffer.from(await response.arrayBuffer());
      const { channels, bitsPerSample, sampleRate: nativeRate, data } = parseWav(raw);
      const sampleRate = Math.round(nativeRate * factor);
      const wav = Buffer.concat([buildWavHeader({ sampleRate, dataLength: data.length, channels, bitsPerSample }), data]);
      return { format: MELO_AUDIO_FORMAT, base64: wav.toString('base64') };
    },
  };
}
