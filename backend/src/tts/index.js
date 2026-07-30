/**
 * Núcleo TTS del backend (T-008). Punto de entrada único del subsistema:
 *
 * - `engine.js`       — la interfaz adapter `TTSEngine` y los ids de voz namespaced.
 * - `registry.js`     — qué motores existen; dónde se enchufa T-010.
 * - `filters.js`      — qué mensajes se leen (ignored/muted, `!`, bots, URLs).
 * - `pipeline.js`     — la decisión por mensaje que viaja en la trama `chat:message`.
 * - `edge-engine.js`  — motor de servidor edge-tts (T-009).
 * - `piper-engine.js` — motor de servidor Piper, síntesis local (T-010).
 * - `piper-install.js`— dónde vive Piper y qué modelos hay instalados (T-010).
 * - `sapi-engine.js`   — motor de servidor sobre las voces SAPI de Windows.
 * - `melo-engine.js`   — motor de servidor sobre MeloTTS (`docker/melotts/`).
 * - `server-audio.js` — audio de **cualquier** motor de servidor: síntesis
 *                       adelantada, almacén en memoria y URL en la instrucción.
 * - `router.js`       — `GET /api/voices` (genérico) y `GET /api/tts/audio/:id`.
 *
 * El resto del backend solo necesita `getTtsPipeline()` (lo usa el relay),
 * `getTtsRegistry()` (los motores nuevos) y `createTtsRouter()` (la app).
 */
export {
  FALLBACK_ENGINE_NAME,
  TTS_ENGINE_KINDS,
  TTS_ENGINE_NAMES,
  assertTtsEngine,
  formatVoiceId,
  isVoiceId,
  parseVoiceId,
} from './engine.js';
export { createBrowserEngine } from './browser-engine.js';
export {
  EDGE_AUDIO_FORMAT,
  EDGE_DEFAULT_VOICE_NAME,
  EDGE_PITCH_HZ_LIMIT,
  EDGE_PITCH_HZ_PER_UNIT,
  createEdgeTtsEngine,
  matchesLanguages,
  pitchToEdgeHz,
  toEdgeVoiceName,
  toTtsVoice,
} from './edge-engine.js';
export {
  PIPER_AUDIO_FORMAT,
  PIPER_PITCH_MAX,
  PIPER_PITCH_MIN,
  createPiperEngine,
  piperPitchFactor,
  toPiperVoice,
} from './piper-engine.js';
export { PIPER_DEFAULT_VOICES, isPiperEnabled, listInstalledPiperModels, piperPaths } from './piper-install.js';
export {
  SAPI_AUDIO_FORMAT,
  SAPI_PITCH_MAX,
  SAPI_PITCH_MIN,
  createLoquendoEngine,
  createSapiEngine,
  isLoquendoEnabled,
  isSapiEnabled,
  sapiPitchFactor,
  toSapiVoice,
} from './sapi-engine.js';
export {
  MELO_AUDIO_FORMAT,
  MELO_PITCH_MAX,
  MELO_PITCH_MIN,
  createMeloEngine,
  isMeloEnabled,
  meloPitchFactor,
  toMeloVoice,
} from './melo-engine.js';
export { createTtsEngineRegistry, getTtsRegistry } from './registry.js';
export {
  AUDIO_MIME_TYPES,
  SERVER_AUDIO_MAX_ENTRIES,
  SERVER_AUDIO_ROUTE,
  SERVER_AUDIO_TTL_MS,
  createServerAudioStore,
  serverAudioUrl,
} from './server-audio.js';
export { PREFERRED_VOICE_LANGUAGES, createTtsRouter, isPreferredLanguage, sortVoiceCatalog } from './router.js';
export {
  COMMAND_PREFIX,
  KNOWN_BOT_USERNAMES,
  TTS_SKIP_REASONS,
  URL_SPOKEN_AS,
  findSkipReason,
  hasUrl,
  isCommand,
  isKnownBot,
  replaceUrls,
  toSpokenText,
} from './filters.js';
export { createTtsPipeline, getTtsPipeline } from './pipeline.js';
