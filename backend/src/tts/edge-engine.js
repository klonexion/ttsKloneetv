/**
 * `EdgeTtsEngine` (T-009): motor TTS **de servidor** sobre el servicio online de
 * Microsoft Edge, vía el paquete `edge-tts-universal`.
 *
 * Es el primer motor `kind: 'server'` del proyecto: el backend sintetiza el audio
 * y el navegador solo lo reproduce (dentro de la misma cola FIFO). Todo lo que no
 * es específico de edge-tts —guardar el audio, servirlo, y el respaldo al motor
 * del navegador si falla— vive en `./server-audio.js` y en
 * `frontend/src/tts/server-audio-engine.js`, para que T-010 (Piper) lo reutilice
 * sin escribir nada de eso.
 *
 * Decisiones de este módulo:
 *
 * - **Paquete: `edge-tts-universal` (versión fijada).** Frente a `node-edge-tts`
 *   (la otra opción del plan) gana por tres razones concretas: (1) devuelve el
 *   audio **en memoria** (`Communicate.stream()` va entregando buffers), mientras
 *   que `node-edge-tts` solo sabe escribir un archivo, lo que obligaría a
 *   gestionar temporales para algo que va a viajar por HTTP; (2) trae
 *   `listVoices()`, que es lo que alimenta `GET /api/voices` con el catálogo real
 *   en vez de una lista copiada a mano; (3) va a la par del `edge-tts` de Python
 *   (rany2), que es la implementación de referencia del protocolo —incluida la
 *   firma `Sec-MS-GEC`/DRM que Microsoft exige— así que es la que sigue
 *   funcionando cuando el servicio cambia.
 * - **Requiere internet.** Es un servicio online: sin red no hay síntesis. Ese
 *   caso no es un error del programa, es el criterio de respaldo de T-009: el
 *   mensaje se lee con el motor del navegador y el fallo queda en el log.
 * - **Timeout propio, no solo el del paquete.** `connectionTimeout` del paquete no
 *   cubre todos los caminos: con un proxy inalcanzable la promesa se queda
 *   colgada **para siempre** (comprobado). Un cuelgue ahí congelaría la cola del
 *   frontend esperando el audio, así que cada llamada va envuelta en un timeout
 *   duro que **rechaza** (`TTS_EDGE_TIMEOUT_MS`).
 * - **El pitch se aplica en la síntesis; el volumen en la reproducción.** El
 *   servicio acepta el pitch como desplazamiento en Hz dentro del SSML, y una vez
 *   sintetizado el audio ya no se puede cambiar de tono en el navegador. El
 *   volumen, en cambio, es exacto y gratis en el `<audio>` del cliente
 *   (`audio.volume = 0–1`), así que **no** se manda también en el SSML: hacerlo
 *   atenuaría dos veces.
 * - **El timbre se traduce a `rate` (velocidad), no a ruido de generador.**
 *   edge-tts es un servicio cerrado, no un modelo VITS local: no expone nada
 *   parecido a `noise_scale`. Lo único que da una variación de "textura" real
 *   sin tocar el pitch es la velocidad de habla — el SSML la acepta aparte
 *   (`rate`, en `CommunicateOptions`), independiente del `pitch` que ya se
 *   manda. No es el mismo mecanismo que Piper/MeloTTS, pero es el único que
 *   este servicio ofrece.
 * - **Catálogo cacheado.** `listVoices()` pega a la red; se cachea con TTL y, si
 *   una recarga falla, se devuelve el último catálogo bueno en vez de vaciar el
 *   selector de voces.
 */
import { config } from '../config.js';
import { logger } from '../logger.js';
import { TTS_ENGINE_KINDS, TTS_ENGINE_NAMES, formatVoiceId, parseVoiceId } from './engine.js';

/** Formato en el que el servicio devuelve el audio. */
export const EDGE_AUDIO_FORMAT = 'mp3';

/**
 * Voz que se usa cuando la instrucción no trae una voz `edge:*` concreta (por
 * ejemplo `voiceId: null`). Es la voz global default del plan.
 */
export const EDGE_DEFAULT_VOICE_NAME = 'es-MX-DaliaNeural';

/**
 * El pitch del proyecto es el de Web Speech (0–2, 1 = neutro) porque es el que
 * viaja en la instrucción TTS y el que usa el motor del navegador. El SSML de
 * edge-tts lo quiere como desplazamiento en Hz (`/^[+-]\d+Hz$/`), así que se
 * convierte: cada unidad de pitch son 50 Hz, recortado a ±50 Hz.
 *
 * Con eso el rango que T-011 va a repartir entre usuarios (0.8–1.4) cae en
 * −10 Hz … +20 Hz: diferencias audibles entre personas sin que la voz se vuelva
 * metálica, que es lo que pasa al pasar de ±50 Hz.
 */
export const EDGE_PITCH_HZ_PER_UNIT = 50;
export const EDGE_PITCH_HZ_LIMIT = 50;

/**
 * El timbre 0–2 (1 = neutro) se convierte a `rate` SSML como un porcentaje de
 * velocidad. Recortado a ±30 %: pasado de ahí la voz se acelera/atrasa tanto
 * que deja de sonar como una variación de textura y empieza a sonar rota.
 */
export const EDGE_TIMBRE_RATE_PERCENT_PER_UNIT = 100;
export const EDGE_TIMBRE_RATE_PERCENT_LIMIT = 30;

/** Cuánto vale el catálogo de voces antes de volver a pedirlo (6 h). */
export const EDGE_VOICE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Convierte el pitch 0–2 del proyecto al `pitch` SSML de edge-tts (`'+20Hz'`). */
export function pitchToEdgeHz(pitch) {
  const value = typeof pitch === 'number' && Number.isFinite(pitch) ? pitch : 1;
  const hz = Math.round((value - 1) * EDGE_PITCH_HZ_PER_UNIT);
  const clamped = Math.min(EDGE_PITCH_HZ_LIMIT, Math.max(-EDGE_PITCH_HZ_LIMIT, hz));
  return `${clamped < 0 ? '-' : '+'}${Math.abs(clamped)}Hz`;
}

/** Convierte el timbre 0–2 del proyecto al `rate` SSML de edge-tts (`'+15%'`). */
export function timbreToEdgeRate(timbre) {
  const value = typeof timbre === 'number' && Number.isFinite(timbre) ? timbre : 1;
  const percent = Math.round((value - 1) * EDGE_TIMBRE_RATE_PERCENT_PER_UNIT);
  const clamped = Math.min(EDGE_TIMBRE_RATE_PERCENT_LIMIT, Math.max(-EDGE_TIMBRE_RATE_PERCENT_LIMIT, percent));
  return `${clamped < 0 ? '-' : '+'}${Math.abs(clamped)}%`;
}

/**
 * Nombre de voz del servicio (`ShortName`) a partir de un id namespaced. Un id de
 * otro motor —o `null`, que significa "elige tú"— cae en la voz default, porque a
 * este punto solo se llega cuando el registro ya decidió que lee edge.
 */
export function toEdgeVoiceName(voiceId) {
  const parsed = parseVoiceId(voiceId);
  if (parsed === null || parsed.engine !== TTS_ENGINE_NAMES.edge || parsed.name === '') {
    return EDGE_DEFAULT_VOICE_NAME;
  }
  return parsed.name;
}

/** `true` si el locale (`'es-MX'`) encaja con alguno de los idiomas pedidos. */
export function matchesLanguages(locale, languages) {
  if (!Array.isArray(languages) || languages.length === 0 || languages.includes('*')) {
    return true;
  }
  const value = String(locale ?? '').toLowerCase();
  return languages.some((language) => {
    const wanted = String(language).toLowerCase();
    return value === wanted || value.startsWith(`${wanted}-`);
  });
}

/**
 * Voz del servicio → `TtsVoice` del catálogo, con su id namespaced. El `label` es
 * lo que verá el selector de T-011: nombre corto de la persona, locale y género.
 */
export function toTtsVoice(voice) {
  const shortName = String(voice?.ShortName ?? '');
  const locale = voice?.Locale ?? null;
  // `FriendlyName` viene como "Microsoft Dalia Online (Natural) - Spanish (Mexico)".
  const person = shortName.split('-').slice(2).join('-').replace(/Neural$/, '') || shortName;
  const gender = voice?.Gender === 'Female' ? 'mujer' : voice?.Gender === 'Male' ? 'hombre' : null;
  return {
    id: formatVoiceId(TTS_ENGINE_NAMES.edge, shortName),
    name: shortName,
    engine: TTS_ENGINE_NAMES.edge,
    language: locale,
    label: `${person} (${locale}${gender === null ? '' : `, ${gender}`})`,
  };
}

/**
 * Carga perezosa del paquete: es la dependencia más pesada del backend y no hace
 * falta para arrancar (ni si el operador desactiva el motor con
 * `TTS_EDGE_ENABLED=false`).
 */
let modulePromise = null;
const loadEdgeTts = () => {
  modulePromise ??= import('edge-tts-universal');
  return modulePromise;
};

/**
 * Envuelve una promesa en un timeout duro que **rechaza**. No basta con el
 * `connectionTimeout` del paquete (ver la cabecera del módulo).
 */
async function withTimeout(label, work, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      work(),
      // El temporizador NO se hace `unref()` a propósito: si la promesa que vigila
      // se queda colgada (le pasa al paquete con un proxy inalcanzable) y el
      // proceso no tiene nada más pendiente, un temporizador sin referencia no
      // llegaría a disparar y el timeout no serviría de nada. El apagado del
      // backend fuerza la salida a los 5 s, así que no puede colgar el proceso.
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`edge-tts: ${label} no respondió en ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

/**
 * Crea el motor `edge`. Cumple la interfaz `TTSEngine` de `./engine.js`.
 *
 * @param {object} [options]
 * @param {number} [options.timeoutMs]        tope por llamada (síntesis y catálogo).
 * @param {string|null} [options.proxy]       proxy HTTP para salir a internet.
 * @param {string[]} [options.languages]      idiomas del catálogo (`['es']`; `['*']` = todos).
 * @param {number} [options.voiceCacheTtlMs]  vigencia del catálogo cacheado.
 * @param {Function} [options.load]           carga del paquete (inyectable en pruebas).
 */
export function createEdgeTtsEngine({
  timeoutMs = config.tts.edgeTimeoutMs,
  proxy = config.tts.edgeProxy,
  languages = config.tts.edgeVoiceLanguages,
  voiceCacheTtlMs = EDGE_VOICE_CACHE_TTL_MS,
  load = loadEdgeTts,
} = {}) {
  /** Último catálogo bueno, con su marca de tiempo. */
  let cache = { at: 0, voices: null };

  const listVoices = async () => {
    if (cache.voices !== null && Date.now() - cache.at < voiceCacheTtlMs) {
      return cache.voices;
    }

    try {
      const voices = await withTimeout(
        'el catálogo de voces',
        async () => {
          const { listVoices: fetchVoices } = await load();
          return fetchVoices(proxy ?? undefined);
        },
        timeoutMs,
      );

      const mapped = (Array.isArray(voices) ? voices : [])
        .filter((voice) => typeof voice?.ShortName === 'string' && matchesLanguages(voice.Locale, languages))
        .map(toTtsVoice)
        .sort((a, b) => a.id.localeCompare(b.id));

      cache = { at: Date.now(), voices: mapped };
      return mapped;
    } catch (error) {
      if (cache.voices !== null) {
        // Mejor un catálogo viejo que un selector de voces vacío.
        logger.warn(`tts: edge no pudo refrescar el catálogo de voces (${error.message}); se usa el anterior`);
        return cache.voices;
      }
      // El registro aísla al motor que falla y devuelve [] en el catálogo agregado.
      throw error;
    }
  };

  return {
    name: TTS_ENGINE_NAMES.edge,
    kind: TTS_ENGINE_KINDS.server,

    /**
     * Hay internet y el servicio responde. Se apoya en el catálogo (cacheado), así
     * que llamarlo repetidamente no castiga la red. **No** se llama en el camino
     * de cada mensaje: el registro resuelve de forma sincrónica y el respaldo se
     * decide al fallar la síntesis.
     */
    async isAvailable() {
      try {
        return (await listVoices()).length > 0;
      } catch {
        return false;
      }
    },

    listVoices,

    /**
     * Sintetiza una instrucción TTS ya resuelta por el pipeline. Lanza si falla
     * (contrato de la interfaz): quien la consume cae al motor del navegador.
     *
     * `volume` se ignora a propósito: se aplica en la reproducción.
     */
    async synthesize({ text, voiceId, pitch, timbre } = {}) {
      const spoken = typeof text === 'string' ? text.trim() : '';
      if (spoken === '') {
        throw new Error('edge-tts: no hay texto que sintetizar');
      }

      const voice = toEdgeVoiceName(voiceId);
      const bytes = await withTimeout(
        `la síntesis con la voz ${voice}`,
        async () => {
          const { Communicate } = await load();
          const communicate = new Communicate(spoken, {
            voice,
            pitch: pitchToEdgeHz(pitch),
            rate: timbreToEdgeRate(timbre),
            proxy: proxy ?? undefined,
            connectionTimeout: timeoutMs,
          });

          const chunks = [];
          for await (const chunk of communicate.stream()) {
            if (chunk.type === 'audio' && chunk.data) {
              chunks.push(Buffer.from(chunk.data));
            }
          }
          if (chunks.length === 0) {
            throw new Error('edge-tts: el servicio no devolvió audio');
          }
          return Buffer.concat(chunks);
        },
        timeoutMs,
      );

      return { format: EDGE_AUDIO_FORMAT, base64: bytes.toString('base64') };
    },
  };
}
