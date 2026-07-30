import { computed, ref } from 'vue';

import { listBrowserVoices } from '../tts/browser-engine.js';

/**
 * Catálogo de voces para el selector del panel de usuario (T-011).
 *
 * La fuente es `GET /api/voices` de T-009, que ya llega **agregada de todos los
 * motores registrados, con los ids namespaced, en español primero y agrupable por
 * `engine`**: aquí no se filtra ni se reordena el catálogo del servidor, y **no
 * hay ninguna lista de voces escrita a mano** (cuando T-010 registre Piper, sus
 * voces aparecen solas).
 *
 * Lo único que se suma es el catálogo del motor `browser`, que el backend no
 * puede conocer (devuelve `[]` a propósito): las voces de Web Speech solo existen
 * en esta máquina y se leen con `listBrowserVoices()`. Se toman en una instantánea
 * al cargar y no en un `computed`, porque `speechSynthesis.getVoices()` llega
 * vacío en el primer tick y no es reactivo.
 */

/** Endpoint del catálogo (vía proxy de Vite). */
export const VOICES_ENDPOINT = '/api/voices';

/** Valor del item "voz global" del selector (la ausencia de voz propia). */
export const GLOBAL_VOICE_VALUE = '__global__';

/** Nombre visible de cada motor en las cabeceras del selector. */
export const ENGINE_LABELS = Object.freeze({
  browser: 'Navegador (Web Speech)',
  edge: 'Microsoft edge-tts',
  piper: 'Piper (local)',
  sapi: 'Windows (SAPI)',
  loquendo: 'Loquendo TTS 7',
  melo: 'MeloTTS (Docker)',
});

const voices = ref([]);
const engines = ref([]);
const browserVoices = ref([]);
const status = ref('idle');
const error = ref('');

let inFlight = null;

/** `true` si la voz es de un idioma preferido (español), como ordena el backend. */
const isSpanish = (voice) => String(voice?.language ?? '').toLowerCase().startsWith('es');

/** Español primero, después por etiqueta. Solo se aplica al catálogo local. */
const spanishFirst = (list) =>
  [...list].sort((a, b) => {
    const preferred = Number(isSpanish(b)) - Number(isSpanish(a));
    if (preferred !== 0) {
      return preferred;
    }
    return String(a.label ?? a.name).localeCompare(String(b.label ?? b.name), 'es');
  });

const normalizeVoice = (raw) => {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id === '') {
    return null;
  }
  const name = typeof raw.name === 'string' && raw.name !== '' ? raw.name : raw.id;
  return {
    id: raw.id,
    name,
    engine: typeof raw.engine === 'string' && raw.engine !== '' ? raw.engine : 'browser',
    language: typeof raw.language === 'string' && raw.language !== '' ? raw.language : null,
    label: typeof raw.label === 'string' && raw.label !== '' ? raw.label : name,
  };
};

/**
 * Carga el catálogo una sola vez (las llamadas siguientes reutilizan lo cargado,
 * salvo `force`). Nunca lanza: el error queda en el estado para mostrarlo.
 */
export async function loadVoices({ force = false } = {}) {
  if (!force && status.value === 'ready') {
    return voices.value;
  }
  if (inFlight !== null) {
    return inFlight;
  }

  status.value = 'loading';
  error.value = '';

  inFlight = (async () => {
    try {
      const response = await fetch(VOICES_ENDPOINT, { headers: { accept: 'application/json' } });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();

      voices.value = (Array.isArray(data?.voices) ? data.voices : []).map(normalizeVoice).filter((voice) => voice !== null);
      engines.value = (Array.isArray(data?.engines) ? data.engines : [])
        .filter((engine) => engine && typeof engine.name === 'string')
        .map((engine) => ({ name: engine.name, kind: engine.kind ?? null }));
      // El motor del navegador solo se conoce aquí (T-008/T-009).
      browserVoices.value = spanishFirst(listBrowserVoices().map(normalizeVoice).filter((voice) => voice !== null));
      status.value = 'ready';
    } catch (failure) {
      status.value = 'error';
      error.value = `No se pudo cargar el catálogo de voces (${failure.message}).`;
    } finally {
      inFlight = null;
    }
    return voices.value;
  })();

  return inFlight;
}

/** Catálogo completo: lo que sirve el backend más las voces locales. */
const allVoices = computed(() => [...voices.value, ...browserVoices.value]);

/**
 * Catálogo agrupado por motor, en el orden de registro que informa el backend (y
 * al final los motores que no venían en esa lista). El orden **dentro** de cada
 * grupo es el que ya trae la respuesta: español primero.
 */
const groups = computed(() => {
  const byEngine = new Map();
  for (const voice of allVoices.value) {
    if (!byEngine.has(voice.engine)) {
      byEngine.set(voice.engine, []);
    }
    byEngine.get(voice.engine).push(voice);
  }

  const order = engines.value.map((engine) => engine.name);
  const rank = (name) => {
    const index = order.indexOf(name);
    return index === -1 ? order.length : index;
  };

  return [...byEngine.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([engine, list]) => ({
      engine,
      label: ENGINE_LABELS[engine] ?? engine,
      kind: engines.value.find((item) => item.name === engine)?.kind ?? null,
      voices: list,
    }));
});

/** Etiqueta legible de un id de voz, o `null` si no está en el catálogo. */
export function describeVoiceId(voiceId) {
  const voice = allVoices.value.find((item) => item.id === voiceId);
  return voice ? voice.label : null;
}

/** Acceso reactivo al catálogo. */
export function useVoiceCatalog() {
  return {
    voices: allVoices,
    engines: computed(() => engines.value),
    groups,
    total: computed(() => allVoices.value.length),
    status: computed(() => status.value),
    error: computed(() => error.value),
    isLoading: computed(() => status.value === 'loading'),
    isReady: computed(() => status.value === 'ready'),
    load: loadVoices,
  };
}

/** Vacía el catálogo (pruebas manuales). */
export function clearVoices() {
  voices.value = [];
  engines.value = [];
  browserVoices.value = [];
  status.value = 'idle';
  error.value = '';
}
