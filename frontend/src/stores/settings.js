import { computed, ref } from 'vue';

/**
 * Ajustes globales del canal (T-013): voz global, volumen maestro del TTS,
 * timbre maestro del TTS y tema claro/oscuro. La autoridad es `app_settings` en
 * SQLite, servida por `GET`/`PATCH /api/settings` (`backend/src/settings/`).
 *
 * Cómo se comporta, y por qué:
 *
 * - **Se escribe siempre por el backend**, nunca solo en memoria: así el ajuste
 *   sobrevive recargas y reinicios, que es lo que pide el criterio del tema. El
 *   estado local se refresca con la respuesta del `PATCH`, que trae los cuatro
 *   valores ya persistidos.
 * - **Aplica en vivo, sin recargar.** La voz global y el timbre maestro los
 *   relee el pipeline del backend en cada mensaje, así que afectan al mensaje
 *   siguiente sin reiniciar; el volumen maestro lo lee la cola al arrancar cada
 *   enunciado (`./tts-queue.js`); y el tema lo aplica `App.vue` con `useTheme()`
 *   al ver cambiar `theme`.
 * - **El timbre maestro no se lee en el frontend** (a diferencia del volumen
 *   maestro, que sí lo usa `tts-queue.js`): se combina en el backend, antes de
 *   sintetizar, porque es un parámetro de síntesis y no de reproducción — ver
 *   `combineTimbre()` en `backend/src/tts/voice-model.js`. Acá solo se guarda y
 *   se muestra.
 * - **Se carga una sola vez** al montar la app, incluso sin sesión de Twitch: el
 *   tema tiene que valer también en la pantalla de login.
 * - Si la carga falla, se conservan los defaults (oscuro, sin atenuar, sin
 *   desplazar) y el error queda en el estado para mostrarlo: la app no se queda
 *   sin tema.
 */

/** Endpoint de los ajustes globales (vía proxy de Vite). */
export const SETTINGS_ENDPOINT = '/api/settings';

/** Los dos temas que define `plugins/vuetify.js`. */
export const THEMES = Object.freeze({ dark: 'dark', light: 'light' });

/** Defaults, los mismos que el backend (oscuro, sin atenuar, sin desplazar). */
export const DEFAULT_THEME = THEMES.dark;
export const DEFAULT_MASTER_VOLUME = 1;
export const DEFAULT_MASTER_TIMBRE = 1;

const globalVoiceId = ref(null);
const theme = ref(DEFAULT_THEME);
const masterVolume = ref(DEFAULT_MASTER_VOLUME);
const masterTimbre = ref(DEFAULT_MASTER_TIMBRE);
const status = ref('idle');
const error = ref('');

let inFlight = null;

const clamp01 = (value) => Math.min(1, Math.max(0, value));
/** Mismo rango 0–2 que el timbre por usuario (1 = neutro, no 0 como el volumen). */
const clampTimbre = (value) => Math.min(2, Math.max(0, value));

/** Aplica al estado local la respuesta del backend (los cuatro ajustes vigentes). */
function applySettings(raw) {
  if (!raw || typeof raw !== 'object') {
    return;
  }
  if (typeof raw.globalVoiceId === 'string' && raw.globalVoiceId !== '') {
    globalVoiceId.value = raw.globalVoiceId;
  }
  if (raw.theme === THEMES.dark || raw.theme === THEMES.light) {
    theme.value = raw.theme;
  }
  if (typeof raw.masterVolume === 'number' && Number.isFinite(raw.masterVolume)) {
    masterVolume.value = clamp01(raw.masterVolume);
  }
  if (typeof raw.masterTimbre === 'number' && Number.isFinite(raw.masterTimbre)) {
    masterTimbre.value = clampTimbre(raw.masterTimbre);
  }
}

/**
 * Carga los ajustes globales. No lanza: el fallo queda en el estado (los defaults
 * siguen valiendo). Las llamadas simultáneas comparten la misma petición.
 */
export async function loadGlobalSettings({ force = false } = {}) {
  if (!force && status.value === 'ready') {
    return {
      globalVoiceId: globalVoiceId.value,
      theme: theme.value,
      masterVolume: masterVolume.value,
      masterTimbre: masterTimbre.value,
    };
  }
  if (inFlight !== null) {
    return inFlight;
  }

  status.value = 'loading';
  error.value = '';

  inFlight = (async () => {
    try {
      const response = await fetch(SETTINGS_ENDPOINT, { headers: { accept: 'application/json' } });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      applySettings(data?.settings);
      status.value = 'ready';
    } catch (failure) {
      status.value = 'error';
      error.value = `No se pudieron cargar los ajustes globales (${failure.message}).`;
    } finally {
      inFlight = null;
    }
    return {
      globalVoiceId: globalVoiceId.value,
      theme: theme.value,
      masterVolume: masterVolume.value,
      masterTimbre: masterTimbre.value,
    };
  })();

  return inFlight;
}

/**
 * Guarda un subconjunto de `{ globalVoiceId, theme, masterVolume, masterTimbre }`
 * y aplica la respuesta. Lanza con un mensaje en español si algo falla, para que
 * el panel lo muestre y devuelva su control al valor guardado.
 */
export async function saveGlobalSettings(patch) {
  let response;
  try {
    response = await fetch(SETTINGS_ENDPOINT, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(patch),
    });
  } catch {
    // `fetch` rechaza así cuando no hay backend al otro lado.
    throw new Error('No se pudo contactar al backend.');
  }

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.settings) {
    throw new Error(data?.error || `No se pudo guardar (HTTP ${response.status}).`);
  }

  applySettings(data.settings);
  return data.settings;
}

/**
 * Volumen maestro vigente, para la cola de reproducción. Se expone suelto (y no
 * solo dentro de `useGlobalSettings()`) porque `stores/tts-queue.js` lo lee desde
 * fuera de un componente.
 */
export const ttsMasterVolume = computed(() => masterVolume.value);

/** Tema vigente, para que `App.vue` lo aplique con `useTheme()`. */
export const uiTheme = computed(() => theme.value);

/** Acceso reactivo a los ajustes globales. */
export function useGlobalSettings() {
  return {
    globalVoiceId: computed(() => globalVoiceId.value),
    theme: uiTheme,
    masterVolume: ttsMasterVolume,
    masterTimbre: computed(() => masterTimbre.value),
    isDark: computed(() => theme.value === THEMES.dark),
    status: computed(() => status.value),
    error: computed(() => error.value),
    isLoading: computed(() => status.value === 'loading'),
    isReady: computed(() => status.value === 'ready'),
    load: loadGlobalSettings,
    save: saveGlobalSettings,
  };
}

/** Vuelve a los defaults (pruebas manuales). */
export function resetGlobalSettings() {
  globalVoiceId.value = null;
  theme.value = DEFAULT_THEME;
  masterVolume.value = DEFAULT_MASTER_VOLUME;
  masterTimbre.value = DEFAULT_MASTER_TIMBRE;
  status.value = 'idle';
  error.value = '';
}
