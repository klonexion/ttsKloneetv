/**
 * Capa de audio de los motores **de servidor** (T-009), genérica: no sabe nada de
 * edge-tts. T-010 (Piper) la reutiliza tal cual, sin tocar este archivo ni la
 * ruta: le basta registrar su motor con `kind: 'server'`.
 *
 * ## Qué problema resuelve
 *
 * Un motor de servidor sintetiza el audio en el backend, pero **suena en el
 * navegador y dentro de la única cola FIFO** (decisión arquitectónica durable).
 * Sintetizar tarda ~1 s, así que hay que decidir cuándo viaja el audio. T-008
 * dejó apuntada la vía directa —esperar la síntesis y publicar la trama con
 * `audio: { format, base64 }`—, pero eso rompe dos cosas que el plan exige:
 *
 * - **el orden FIFO entre motores mezclados**: si la trama del mensaje A (edge)
 *   espera un segundo y la del mensaje B (navegador) sale al instante, B llega
 *   antes que A y se lee antes; y
 * - **la latencia del chat**: la trama es una sola para mostrar *y* para leer, así
 *   que retenerla retrasaría también la aparición del mensaje en pantalla (y un
 *   corte de internet congelaría el chat entero durante el timeout).
 *
 * ## Cómo funciona
 *
 * La trama sale **inmediatamente y en orden**, con una **URL** en vez de los bytes
 * (la decisión durable del plan admite «base64 o URL servida»):
 *
 *     tts.audio = { url: '/api/tts/audio/<messageId>' }
 *
 * Al publicar, `attach()` **arranca** la síntesis (sin esperarla) y guarda la
 * promesa aquí; cuando la cola del navegador llega a ese mensaje, pide la URL y el
 * audio ya suele estar listo. Es decir: la síntesis va por delante (prefetch) y
 * ocurre en paralelo con el enunciado anterior, en vez de en serie con él.
 *
 * Consecuencias, todas buscadas:
 *
 * - El orden de las tramas es exactamente el orden del chat → **FIFO intacto**
 *   mezclando motores, sin que la cola del frontend tenga que ordenar nada.
 * - Un fallo de síntesis (sin internet, error del servicio) también se conoce por
 *   adelantado: la petición del navegador responde `503` de inmediato y su motor
 *   de cliente **cae al motor del navegador para ese mismo enunciado**, sin perder
 *   su turno. El error se registra una sola vez, aquí, en el log del backend.
 * - El audio nunca se persiste: vive en memoria, con tope de entradas y TTL.
 *
 * ## Contrato para T-010 (y cualquier motor de servidor futuro)
 *
 * 1. Registrar el motor en `./registry.js` con `kind: 'server'` y `synthesize()`
 *    devolviendo `{ format, base64 }` (o lanzando si falla).
 * 2. Nada más. El pipeline adjunta `audio.url`, la ruta `GET /api/tts/audio/:id`
 *    sirve los bytes con su `Content-Type`, y
 *    `frontend/src/tts/server-audio-engine.js` los reproduce.
 */
import { logger } from '../logger.js';
import { TTS_ENGINE_KINDS } from './engine.js';
import { getTtsRegistry } from './registry.js';

/** Prefijo de la ruta que sirve el audio sintetizado. */
export const SERVER_AUDIO_ROUTE = '/api/tts/audio';

/** Cuántos audios se guardan a la vez (se descarta el más viejo). */
export const SERVER_AUDIO_MAX_ENTRIES = 100;

/**
 * Cuánto se guarda un audio antes de considerarlo caduco. Generoso frente a una
 * cola larga: son ráfagas de chat, no archivo.
 */
export const SERVER_AUDIO_TTL_MS = 10 * 60 * 1000;

/** `Content-Type` por formato declarado en `TtsAudio`. */
export const AUDIO_MIME_TYPES = Object.freeze({
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
});

/** URL desde la que el navegador pedirá el audio de un mensaje. */
export const serverAudioUrl = (messageId) => `${SERVER_AUDIO_ROUTE}/${encodeURIComponent(messageId)}`;

/** Valida el `TtsAudio` que devolvió el motor y lo pasa a bytes servibles. */
function toServedAudio(engineName, audio) {
  const format = String(audio?.format ?? '').toLowerCase();
  const mime = AUDIO_MIME_TYPES[format];
  if (mime === undefined) {
    throw new Error(`el motor "${engineName}" devolvió un formato desconocido (${audio?.format})`);
  }
  if (typeof audio?.base64 !== 'string' || audio.base64 === '') {
    throw new Error(`el motor "${engineName}" no devolvió audio`);
  }
  const bytes = Buffer.from(audio.base64, 'base64');
  if (bytes.length === 0) {
    throw new Error(`el motor "${engineName}" devolvió audio vacío`);
  }
  return { format, mime, bytes };
}

/**
 * Almacén en memoria del audio sintetizado, indexado por id de mensaje.
 *
 * @param {object} [options]
 * @param {ReturnType<import('./registry.js').createTtsEngineRegistry>} [options.registry]
 * @param {number} [options.maxEntries]
 * @param {number} [options.ttlMs]
 * @param {() => number} [options.now] reloj inyectable (pruebas).
 */
export function createServerAudioStore({
  registry = getTtsRegistry(),
  maxEntries = SERVER_AUDIO_MAX_ENTRIES,
  ttlMs = SERVER_AUDIO_TTL_MS,
  now = Date.now,
} = {}) {
  /** `Map` en orden de inserción: la primera clave es la más vieja. */
  const entries = new Map();
  let started = 0;
  let failed = 0;

  const dropExpired = () => {
    const deadline = now() - ttlMs;
    for (const [key, entry] of entries) {
      if (entry.at > deadline) {
        // El Map conserva el orden de inserción: si esta no ha caducado, ninguna
        // de las siguientes tampoco.
        break;
      }
      entries.delete(key);
    }
  };

  const dropOldest = () => {
    while (entries.size > maxEntries) {
      const [oldest] = entries.keys();
      entries.delete(oldest);
    }
  };

  return {
    /**
     * Adjunta a una instrucción TTS la URL de su audio y **arranca** la síntesis.
     *
     * Sincrónico y a prueba de fallos: no espera nada y nunca lanza, porque se
     * llama dentro del camino de cada mensaje. Si el motor es de cliente
     * (`browser`) devuelve la instrucción **tal cual**, sin añadir `audio`.
     */
    attach(messageId, tts) {
      if (!tts || typeof tts !== 'object' || typeof messageId !== 'string' || messageId === '') {
        return tts;
      }

      const engine = registry.get(tts.engine);
      if (!engine || engine.kind !== TTS_ENGINE_KINDS.server || typeof engine.synthesize !== 'function') {
        return tts;
      }

      if (!entries.has(messageId)) {
        started += 1;
        const audio = Promise.resolve()
          .then(() => engine.synthesize({ text: tts.text, voiceId: tts.voiceId, pitch: tts.pitch, volume: tts.volume }))
          .then((result) => toServedAudio(engine.name, result))
          .catch((error) => {
            failed += 1;
            // Único lugar donde se registra el fallo de un motor de servidor: el
            // mensaje no se pierde, lo leerá el motor del navegador.
            logger.error(
              `tts: el motor "${engine.name}" no pudo sintetizar el mensaje ${messageId} ` +
                `(${error.message}); se leerá con el navegador`,
            );
            throw error;
          });

        // La promesa se consume después (por HTTP) o no se consume nunca: sin este
        // observador, un fallo saldría como `unhandledRejection` y tumbaría Node.
        audio.catch(() => {});

        entries.set(messageId, { at: now(), audio });
        dropExpired();
        dropOldest();
      }

      return { ...tts, audio: { url: serverAudioUrl(messageId) } };
    },

    /**
     * Entrada de un mensaje, o `null` si no existe o caducó. `entry.audio` es una
     * promesa de `{ format, mime, bytes }` que **rechaza** si la síntesis falló.
     */
    get(messageId) {
      const entry = entries.get(messageId);
      if (entry === undefined) {
        return null;
      }
      if (entry.at <= now() - ttlMs) {
        entries.delete(messageId);
        return null;
      }
      return entry;
    },

    /** Vacía el almacén (lo usa el apagado y las pruebas). */
    clear() {
      entries.clear();
    },

    /** Diagnóstico: cuántas síntesis se arrancaron, cuántas fallaron, qué hay. */
    getStats: () => ({ size: entries.size, started, failed }),
  };
}
