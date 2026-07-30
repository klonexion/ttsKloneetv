/**
 * Ajustes globales del canal (T-013): la voz global, el volumen maestro del TTS,
 * el timbre maestro del TTS y el tema claro/oscuro de la UI. Todos viven en la
 * tabla `app_settings` (T-002), que es la única fuente: no hay estado en
 * memoria que invalidar.
 *
 * Vive separado de `./router.js` para poder probarse sin HTTP (lo hace
 * `scripts/smoke-settings.js`). El router solo traduce a códigos de estado.
 *
 * Tres reglas que conviene no perder:
 *
 * 1. **Escribir `global_voice_id` es todo lo que hace falta para cambiar la voz
 *    global.** El pipeline TTS la relee en cada mensaje (`../tts/pipeline.js` →
 *    `resolveUserVoice`, T-011), así que el cambio aplica **desde el mensaje
 *    siguiente y sin reiniciar**, y solo mueve a los usuarios sin `override` ni
 *    voz de comando. Aquí no se toca la prioridad ni el pitch de nadie.
 * 2. **El `voiceId` no se valida contra el catálogo**, igual que en las
 *    preferencias por usuario (T-011): el registro de motores ya cae al navegador
 *    si la voz no existe (garantía de T-008), y así guardar un ajuste no depende
 *    de que `GET /api/voices` responda.
 * 3. **Leer nunca falla.** Un valor imposible en la base (editada a mano, o
 *    escrita por una versión anterior) se lee como su default en vez de reventar:
 *    un ajuste corrupto no puede dejar la UI sin tema ni sin voz.
 *
 * El volumen maestro **escala** el volumen individual de cada usuario y se aplica
 * en la reproducción, que vive en el frontend (`stores/tts-queue.js`): el backend
 * solo lo persiste y lo sirve. El timbre maestro es distinto: se **desplaza**
 * (no se escala, ver `combineTimbre()` en `../tts/voice-model.js`) sobre el
 * timbre individual **antes de sintetizar**, porque es un parámetro de síntesis
 * y no de reproducción — el pipeline lo lee en cada mensaje, igual que la voz
 * global.
 */
import { getRepositories } from '../db/index.js';
import { SETTING_KEYS } from '../db/repositories/settings.js';

/**
 * Clave nueva de esta tarea. Las otras dos (`global_voice_id`, `theme`) las siembra
 * la migración de T-002 en `DEFAULT_SETTINGS`; esta **no está sembrada** a
 * propósito: su default vive aquí (`DEFAULT_MASTER_VOLUME`), así que una base
 * creada antes de T-013 funciona sin migración de datos.
 */
export const MASTER_VOLUME_KEY = 'tts_master_volume';

/**
 * Igual criterio que `MASTER_VOLUME_KEY`: no está sembrada, su default vive
 * acá (`DEFAULT_MASTER_TIMBRE`). A diferencia del volumen maestro (que solo se
 * aplica en la reproducción, en el frontend), el timbre maestro **sí lo lee el
 * pipeline** (`../tts/pipeline.js`): el timbre no es un control de reproducción
 * como el volumen, es un parámetro de síntesis (ruido de generador en
 * Piper/MeloTTS, velocidad en edge-tts/SAPI) — no hay forma de aplicarlo
 * después de sintetizado, así que tiene que combinarse **antes**.
 */
export const MASTER_TIMBRE_KEY = 'tts_master_timbre';

/** Las cuatro claves de `app_settings` que expone esta API, por su nombre en JS. */
export const GLOBAL_SETTING_KEYS = Object.freeze({
  globalVoiceId: SETTING_KEYS.globalVoiceId,
  theme: SETTING_KEYS.theme,
  masterVolume: MASTER_VOLUME_KEY,
  masterTimbre: MASTER_TIMBRE_KEY,
});

/** Temas de la UI (los dos que define `frontend/src/plugins/vuetify.js`). */
export const THEMES = Object.freeze(['dark', 'light']);

/** Tema por default, como pide el plan. */
export const DEFAULT_THEME = 'dark';

/** Volumen maestro por default: no atenúa nada. */
export const DEFAULT_MASTER_VOLUME = 1;

/** Timbre maestro por default: no desplaza nada (mismo "neutro" que el pitch/timbre por usuario). */
export const DEFAULT_MASTER_TIMBRE = 1;

/** Rangos y topes que acepta la API. */
export const SETTINGS_LIMITS = Object.freeze({
  masterVolumeMin: 0,
  masterVolumeMax: 1,
  // Mismo rango 0–2 que el timbre por usuario (`PREFERENCE_LIMITS.timbreMin/Max`
  // en `../users/preferences.js`): 1 = neutro, no 0 como el volumen.
  masterTimbreMin: 0,
  masterTimbreMax: 2,
  voiceIdMaxLength: 200,
});

/** Fallo de validación: el router lo traduce a un 400 con `code`. */
export class GlobalSettingsError extends Error {
  constructor(message, { code = 'invalid', status = 400 } = {}) {
    super(message);
    this.name = 'GlobalSettingsError';
    this.code = code;
    this.status = status;
  }
}

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/** Redondeo a 3 decimales: los pasos del slider producen 0.8999999999999999. */
const round3 = (value) => Number(value.toFixed(3));

/** Tema guardado, o el default si lo que hay en la base no es un tema válido. */
export function normalizeTheme(value) {
  return THEMES.includes(value) ? value : DEFAULT_THEME;
}

/** Volumen maestro guardado (TEXT en SQLite), o el default si no es usable. */
export function normalizeMasterVolume(value) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed) || parsed < SETTINGS_LIMITS.masterVolumeMin || parsed > SETTINGS_LIMITS.masterVolumeMax) {
    return DEFAULT_MASTER_VOLUME;
  }
  return round3(parsed);
}

/** Timbre maestro guardado (TEXT en SQLite), o el default si no es usable. */
export function normalizeMasterTimbre(value) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed) || parsed < SETTINGS_LIMITS.masterTimbreMin || parsed > SETTINGS_LIMITS.masterTimbreMax) {
    return DEFAULT_MASTER_TIMBRE;
  }
  return round3(parsed);
}

/**
 * Los tres ajustes globales vigentes. Nunca lanza (ver regla 3).
 *
 * @param {Function} [repositories] getter de repositorios (inyectable en pruebas).
 * @returns {{ globalVoiceId: string|null, theme: string, masterVolume: number, masterTimbre: number }}
 */
export function readGlobalSettings(repositories = getRepositories) {
  const settings = repositories().settings;
  return {
    globalVoiceId: settings.getGlobalVoiceId(),
    theme: normalizeTheme(settings.getTheme()),
    masterVolume: normalizeMasterVolume(settings.get(MASTER_VOLUME_KEY)),
    masterTimbre: normalizeMasterTimbre(settings.get(MASTER_TIMBRE_KEY)),
  };
}

/**
 * Valida el cuerpo de la petición y devuelve **lo que hay que escribir**, ya con
 * los nombres de clave de `app_settings`.
 *
 * @param {unknown} body cualquier subconjunto de
 *   `{ globalVoiceId, theme, masterVolume, masterTimbre }`.
 * @returns {Record<string, string|number>}
 */
export function parseGlobalSettingsPatch(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new GlobalSettingsError('El cuerpo debe ser un objeto con los ajustes a guardar.');
  }

  const accepted = Object.keys(GLOBAL_SETTING_KEYS);
  const unknown = Object.keys(body).filter((key) => !accepted.includes(key));
  if (unknown.length > 0) {
    throw new GlobalSettingsError(`Ajuste desconocido: ${unknown.join(', ')}.`, { code: 'unknown_key' });
  }

  const values = {};

  if (has(body, 'globalVoiceId')) {
    const value = body.globalVoiceId;
    // No admite `null`: siempre hay una voz global (es el nivel 3 de la prioridad,
    // el que usa todo el mundo que no tiene voz propia).
    if (typeof value !== 'string' || value.trim() === '') {
      throw new GlobalSettingsError('«globalVoiceId» debe ser un id de voz del catálogo.');
    }
    if (value.length > SETTINGS_LIMITS.voiceIdMaxLength) {
      throw new GlobalSettingsError('«globalVoiceId» es demasiado largo.');
    }
    values[GLOBAL_SETTING_KEYS.globalVoiceId] = value.trim();
  }

  if (has(body, 'theme')) {
    if (!THEMES.includes(body.theme)) {
      throw new GlobalSettingsError(`«theme» solo admite ${THEMES.join(' o ')}.`);
    }
    values[GLOBAL_SETTING_KEYS.theme] = body.theme;
  }

  if (has(body, 'masterVolume')) {
    const value = body.masterVolume;
    const { masterVolumeMin: min, masterVolumeMax: max } = SETTINGS_LIMITS;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new GlobalSettingsError(`«masterVolume» debe ser un número entre ${min} y ${max}.`);
    }
    if (value < min || value > max) {
      throw new GlobalSettingsError(`«masterVolume» está fuera del rango ${min}–${max}.`, { code: 'out_of_range' });
    }
    values[GLOBAL_SETTING_KEYS.masterVolume] = round3(value);
  }

  if (has(body, 'masterTimbre')) {
    const value = body.masterTimbre;
    const { masterTimbreMin: min, masterTimbreMax: max } = SETTINGS_LIMITS;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new GlobalSettingsError(`«masterTimbre» debe ser un número entre ${min} y ${max}.`);
    }
    if (value < min || value > max) {
      throw new GlobalSettingsError(`«masterTimbre» está fuera del rango ${min}–${max}.`, { code: 'out_of_range' });
    }
    values[GLOBAL_SETTING_KEYS.masterTimbre] = round3(value);
  }

  if (Object.keys(values).length === 0) {
    throw new GlobalSettingsError('No se mandó ningún ajuste que guardar.', { code: 'empty' });
  }

  return values;
}

/**
 * Guarda un subconjunto de los ajustes globales y devuelve los tres ya vigentes.
 * La escritura es una sola transacción (`settings.setAll`), así que un patch con
 * varios ajustes no puede quedar a medias.
 *
 * @param {object} options
 * @param {unknown} options.body
 * @param {Function} [options.repositories]
 */
export function applyGlobalSettings({ body, repositories = getRepositories }) {
  const values = parseGlobalSettingsPatch(body);
  repositories().settings.setAll(values);
  return readGlobalSettings(repositories);
}
