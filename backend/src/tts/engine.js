/**
 * Interfaz adapter `TTSEngine` (T-008).
 *
 * Un motor TTS convierte texto en voz. Hay dos familias, y la diferencia está en
 * **quién sintetiza**, no en quién reproduce: todo el audio suena en el navegador
 * (decisión arquitectónica durable del plan).
 *
 * - `kind: 'client'` — el navegador sintetiza y reproduce (Web Speech API). El
 *   backend solo resuelve los parámetros; no produce audio. Fase 1: `browser`.
 * - `kind: 'server'` — el backend sintetiza y **adjunta** el audio a la
 *   instrucción TTS de la trama; el navegador lo reproduce en la misma cola FIFO.
 *   Fase 1: `edge` (T-009) y `piper` (T-010).
 *
 * Contrato que debe cumplir cualquier implementación:
 *
 * - `name`                     namespace del motor, exactamente el prefijo de sus
 *                              ids de voz (`'browser' | 'edge' | 'piper'`).
 * - `kind`                     uno de `TTS_ENGINE_KINDS`.
 * - `isAvailable()`            `Promise<boolean>`: si el motor puede usarse
 *                              *ahora* (T-010: el binario de Piper instalado;
 *                              T-009: hay internet). El registro nunca lo llama
 *                              en el camino caliente de un mensaje: la resolución
 *                              por mensaje es sincrónica y solo mira si el motor
 *                              está registrado.
 * - `listVoices()`             `Promise<TtsVoice[]>` para `GET /api/voices`
 *                              (T-009/T-011). Puede devolver `[]`.
 * - `synthesize(request)`      **solo** `kind: 'server'`. Recibe
 *                              `{ text, voiceId, pitch, volume }` (una
 *                              instrucción TTS ya resuelta) y devuelve
 *                              `Promise<TtsAudio>`. Debe lanzar si falla, para
 *                              que quien lo consuma pueda caer al motor del
 *                              navegador (criterio de T-009).
 *
 * Shapes:
 *
 *     TtsVoice = { id, name, engine, language, label }
 *     TtsAudio = { format: 'mp3' | 'wav' | 'ogg', base64 }
 *
 * `id` es siempre el id namespaced (`formatVoiceId(engine, name)`), y `language`
 * un BCP-47 (`'es-MX'`) o `null` si el motor no lo sabe.
 */

/** Nombres de motor conocidos de la fase 1. Coinciden con el prefijo de la voz. */
export const TTS_ENGINE_NAMES = Object.freeze({
  /** Web Speech API en el navegador (T-008). */
  browser: 'browser',
  /** edge-tts en el backend (T-009). */
  edge: 'edge',
  /** Piper local en el backend (T-010). */
  piper: 'piper',
  /** SAPI de Windows (`System.Speech`) en el backend. */
  sapi: 'sapi',
  /** Voces Loquendo TTS 7 instaladas aparte, si las hay (mismo SAPI, otro grupo). */
  loquendo: 'loquendo',
  /** MeloTTS en español, servido por el contenedor de `docker/melotts/`. */
  melo: 'melo',
});

/** Familias de motor: quién hace la síntesis. */
export const TTS_ENGINE_KINDS = Object.freeze({
  /** Sintetiza el navegador; el backend no adjunta audio. */
  client: 'client',
  /** Sintetiza el backend y adjunta el audio a la instrucción. */
  server: 'server',
});

/**
 * Motor con el que se lee cuando la voz pedida no se puede usar (su motor no
 * está registrado o su síntesis falló). Siempre disponible: es el del navegador.
 */
export const FALLBACK_ENGINE_NAME = TTS_ENGINE_NAMES.browser;

/** Separador del namespace de un id de voz: `<engine>:<name>`. */
const VOICE_ID_SEPARATOR = ':';

/**
 * Compone un id de voz namespaced. `formatVoiceId('edge', 'es-MX-DaliaNeural')`
 * → `'edge:es-MX-DaliaNeural'`.
 */
export function formatVoiceId(engine, name) {
  return `${engine}${VOICE_ID_SEPARATOR}${name}`;
}

/**
 * Descompone un id de voz namespaced en `{ engine, name }`, o `null` si no lo es.
 * El nombre puede contener `:` (se parte solo en el primer separador).
 */
export function parseVoiceId(voiceId) {
  if (typeof voiceId !== 'string') {
    return null;
  }
  const at = voiceId.indexOf(VOICE_ID_SEPARATOR);
  if (at <= 0 || at === voiceId.length - 1) {
    return null;
  }
  return { engine: voiceId.slice(0, at), name: voiceId.slice(at + 1) };
}

/** `true` si el valor tiene la forma `<engine>:<name>`. */
export const isVoiceId = (value) => parseVoiceId(value) !== null;

/**
 * Comprueba que un objeto cumple la interfaz `TTSEngine` y lo devuelve. Lanza
 * `TypeError` con el detalle si no: los motores se registran al arrancar, así que
 * un error de contrato debe salir ahí y no en el primer mensaje de chat.
 */
export function assertTtsEngine(engine) {
  if (!engine || typeof engine !== 'object') {
    throw new TypeError('TTSEngine: se esperaba un objeto');
  }
  if (typeof engine.name !== 'string' || engine.name === '' || engine.name.includes(VOICE_ID_SEPARATOR)) {
    throw new TypeError('TTSEngine: `name` debe ser un string no vacío y sin ":"');
  }
  if (!Object.values(TTS_ENGINE_KINDS).includes(engine.kind)) {
    throw new TypeError(`TTSEngine "${engine.name}": \`kind\` debe ser 'client' o 'server'`);
  }
  for (const method of ['isAvailable', 'listVoices']) {
    if (typeof engine[method] !== 'function') {
      throw new TypeError(`TTSEngine "${engine.name}": falta el método ${method}()`);
    }
  }
  if (engine.kind === TTS_ENGINE_KINDS.server && typeof engine.synthesize !== 'function') {
    throw new TypeError(`TTSEngine "${engine.name}": un motor de servidor necesita synthesize()`);
  }
  return engine;
}
