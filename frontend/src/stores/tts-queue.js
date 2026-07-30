/**
 * Cola de reproducción TTS (T-008). Vive en el frontend porque todo el audio
 * suena en el navegador (decisión arquitectónica durable del plan).
 *
 * Propiedades que el plan exige y que aquí son invariantes:
 *
 * - **FIFO y sin límite.** La cola nunca descarta por sí sola, ni con ráfagas:
 *   solo el operador vacía (o salta) con los controles globales. Por eso no hay
 *   ningún `MAX_` en este archivo, a diferencia del store de mensajes.
 * - **Un solo flujo de audio.** Se lee de uno en uno; el siguiente empieza cuando
 *   el anterior termina (o falla). Los motores de servidor (T-009 edge, T-010
 *   Piper) entran por la misma cola sin cambiarla: se registran en
 *   `../tts/engine.js` y se enrutan por `item.engine`. El orden FIFO mezclando
 *   motores sale del orden de llegada de las tramas, y el backend las publica sin
 *   esperar la síntesis (ver `backend/src/tts/server-audio.js`).
 * - **La cola no filtra.** Qué se lee lo decide el backend (`src/tts/pipeline.js`)
 *   y viaja en `payload.tts` de la trama `chat:message`; si es `null`, el mensaje
 *   se muestra y no se encola. Aquí no hay reglas de negocio duplicadas.
 *
 * Semántica de los tres controles globales:
 *
 * - `skipCurrent()` — corta lo que suena y pasa al siguiente.
 * - `clearQueue()`  — silencio ya: corta lo actual **y** tira lo pendiente.
 * - `pause()` / `resume()` — pausa lo que suena y deja de arrancar nuevos; lo
 *   pendiente se sigue acumulando (no se pierde nada) y `resume()` continúa por
 *   donde iba.
 *
 * **Volumen maestro (T-013).** El único cálculo de volumen del sistema vive aquí:
 * el backend manda el volumen **individual** del usuario en la instrucción y la
 * cola lo multiplica por el volumen maestro de `app_settings` al arrancar cada
 * enunciado (`stores/settings.js`). Se lee en ese momento, no al encolar, así que
 * un cambio del maestro se nota **en vivo desde el enunciado siguiente** sin
 * recargar; lo que ya está sonando conserva su volumen (los motores fijan el
 * volumen del `<audio>` o de la utterance al empezar).
 */
import { computed, ref } from 'vue';

import { registerBrowserEngine } from '../tts/browser-engine.js';
import { getTtsEngine, listTtsEngineNames, registerTtsEngine } from '../tts/engine.js';
import { registerServerAudioEngine } from '../tts/server-audio-engine.js';
import { onServerMessage } from '../ws/client.js';
import { CHAT_MESSAGE_TYPE } from './chat-messages.js';
import { ttsMasterVolume } from './settings.js';

/** Cuántos enunciados guarda el registro de diagnóstico (solo observabilidad). */
export const SPEAK_LOG_LIMIT = 200;

/** Cuántos ids de mensaje recuerda la cola para no leer el mismo dos veces. */
export const SEEN_IDS_LIMIT = 1000;

/** Pendientes, en orden de llegada. */
const pending = ref([]);
/** El que se está leyendo ahora, o `null`. */
const current = ref(null);
/** Si la reproducción está pausada por el operador. */
const paused = ref(false);
/** Total encolado desde el arranque (para comprobar que no se descarta nada). */
const enqueuedTotal = ref(0);
/** Total terminado (bien o mal), incluidos los saltados. */
const finishedTotal = ref(0);

/**
 * `true` si el navegador rechazó hablar por política de permisos
 * (`not-allowed`). Pasa en un Chrome sin dispositivo de audio y puede pasar
 * mientras la página no haya recibido ninguna interacción del usuario: la voz se
 * desbloquea con el primer clic. Se expone para que el indicador lo diga, en vez
 * de que el operador vea una cola que avanza en silencio sin saber por qué.
 */
const blocked = ref(false);

/** Marca de error que Web Speech usa cuando el navegador no permite hablar. */
const BLOCKED_ERROR_MARK = 'not-allowed';

/**
 * Registro de lo que se pidió hablar, en orden. Es la instrumentación con la que
 * se verifica el comportamiento sin depender de oír nada (Chrome headless no
 * reproduce audio audible y puede no tener ninguna voz instalada).
 */
const speakLog = ref([]);

let handle = null;
let engineRegistered = false;
let pumpTimer = null;
/** Ids ya encolados, para no leer dos veces el mismo mensaje. */
const seenIds = new Set();

/** Tamaño de la cola tal como lo muestra el indicador: pendientes + el actual. */
const size = computed(() => pending.value.length + (current.value === null ? 0 : 1));

/**
 * Volumen con el que se reproduce un enunciado: el individual del usuario (lo
 * resuelve el backend) **escalado** por el volumen maestro del canal (T-013).
 */
export function effectiveVolume(itemVolume, master = ttsMasterVolume.value) {
  const individual = typeof itemVolume === 'number' && Number.isFinite(itemVolume) ? itemVolume : 1;
  const scale = typeof master === 'number' && Number.isFinite(master) ? master : 1;
  return Math.min(1, Math.max(0, individual * scale));
}

function ensureEngines() {
  if (!engineRegistered) {
    registerBrowserEngine();
    // Motores de servidor: el backend sintetiza y aquí solo se reproduce el audio
    // que adjuntó (`item.audio.url`). Sumar uno es una línea.
    registerServerAudioEngine('edge'); // T-009 (edge-tts, MP3)
    registerServerAudioEngine('piper'); // T-010 (Piper en local, WAV)
    registerServerAudioEngine('sapi'); // voces de Windows (WAV)
    registerServerAudioEngine('loquendo'); // voces Loquendo TTS 7, si están instaladas (WAV)
    registerServerAudioEngine('melo'); // MeloTTS en Docker (WAV)
    engineRegistered = true;
  }
}

/** Programa el siguiente arranque fuera del tick actual (ver `cancel()` del motor). */
function schedulePump() {
  if (pumpTimer !== null) {
    return;
  }
  pumpTimer = window.setTimeout(() => {
    pumpTimer = null;
    pump();
  }, 0);
}

function finish() {
  handle = null;
  current.value = null;
  finishedTotal.value += 1;
  schedulePump();
}

function pump() {
  if (paused.value || current.value !== null || pending.value.length === 0) {
    return;
  }

  ensureEngines();

  const item = pending.value.shift();
  const engine = getTtsEngine(item.engine);

  if (engine === null) {
    // Un motor sin contraparte de cliente (p. ej. una voz `piper:` antes de
    // T-010) no puede bloquear la cola: se descarta ese enunciado y se sigue.
    console.warn(`tts: no hay motor de cliente "${item.engine}"; el mensaje no se leerá`);
    finishedTotal.value += 1;
    schedulePump();
    return;
  }

  current.value = item;

  let settled = false;
  const settle = (error) => {
    if (settled) {
      return;
    }
    settled = true;
    if (error) {
      blocked.value = String(error?.message ?? error).includes(BLOCKED_ERROR_MARK);
      console.warn(`tts: fallo al leer el mensaje ${item.id}`, error);
    } else {
      blocked.value = false;
    }
    finish();
  };

  // El volumen maestro se lee **aquí**, al arrancar el enunciado, para que un
  // cambio de los ajustes globales se note sin recargar ni vaciar la cola.
  const master = ttsMasterVolume.value;
  const volume = effectiveVolume(item.volume, master);

  handle = engine.speak({ ...item, volume }, { onEnd: () => settle(null), onError: settle });

  speakLog.value.push({
    id: item.id,
    engine: item.engine,
    voiceId: item.voiceId,
    voice: handle?.voice ?? null,
    text: item.text,
    pitch: item.pitch,
    volume,
    userVolume: item.volume,
    masterVolume: master,
    at: Date.now(),
  });
  while (speakLog.value.length > SPEAK_LOG_LIMIT) {
    speakLog.value.shift();
  }
}

/**
 * Encola una instrucción TTS ya resuelta por el backend, más el `id` del mensaje:
 * `{ id, engine, voiceId, pitch, volume, text }`. Devuelve el item encolado o
 * `null` si se descartó (sin texto, sin motor o `id` repetido).
 */
export function enqueueTts(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  const engine = typeof raw.engine === 'string' && raw.engine !== '' ? raw.engine : null;
  if (text === '' || engine === null) {
    return null;
  }

  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : `tts-${enqueuedTotal.value}`;
  if (seenIds.has(id)) {
    return null;
  }
  seenIds.add(id);
  // El set de ids vistos no es la cola: solo evita leer dos veces el mismo
  // mensaje si el relay lo entrega repetido. Se poda para no crecer sin fin.
  if (seenIds.size > SEEN_IDS_LIMIT) {
    for (const old of [...seenIds].slice(0, seenIds.size - SEEN_IDS_LIMIT)) {
      seenIds.delete(old);
    }
  }

  const item = {
    id,
    engine,
    voiceId: typeof raw.voiceId === 'string' ? raw.voiceId : null,
    pitch: typeof raw.pitch === 'number' ? raw.pitch : 1,
    volume: typeof raw.volume === 'number' ? raw.volume : 1,
    text,
    audio: raw.audio ?? null,
  };

  pending.value.push(item);
  enqueuedTotal.value += 1;
  pump();

  return item;
}

/** Corta lo que suena y pasa al siguiente (si no está pausada). */
export function skipCurrent() {
  if (current.value === null) {
    return false;
  }
  handle?.cancel?.();
  finish();
  return true;
}

/** Silencio inmediato: corta lo actual y descarta todo lo pendiente. */
export function clearQueue() {
  const dropped = pending.value.length;
  pending.value = [];
  skipCurrent();
  return dropped;
}

/** Pausa la lectura (lo pendiente se sigue acumulando). */
export function pauseQueue() {
  if (paused.value) {
    return;
  }
  paused.value = true;
  handle?.pause?.();
}

/** Reanuda la lectura donde iba. */
export function resumeQueue() {
  if (!paused.value) {
    return;
  }
  paused.value = false;
  if (current.value !== null) {
    handle?.resume?.();
    return;
  }
  schedulePump();
}

/** Alterna pausa/reanudación (lo que hace el botón de la app bar). */
export function togglePauseQueue() {
  if (paused.value) {
    resumeQueue();
  } else {
    pauseQueue();
  }
}

/** Deja la cola como recién arrancada (lo usa el desmontaje del shell). */
export function resetTtsQueue() {
  clearQueue();
  if (pumpTimer !== null) {
    window.clearTimeout(pumpTimer);
    pumpTimer = null;
  }
  paused.value = false;
  blocked.value = false;
  seenIds.clear();
  speakLog.value = [];
  enqueuedTotal.value = 0;
  finishedTotal.value = 0;
}

/**
 * Conecta la cola al hub: cada trama `chat:message` con `tts` no nulo se encola.
 * Es la **misma** trama que alimenta el chat (T-004 la enriquece en el relay), no
 * un canal aparte. Devuelve la función de baja.
 */
export function startTtsQueueFeed() {
  ensureEngines();

  const handleFrame = (payload) => {
    if (!payload || typeof payload !== 'object' || !payload.tts) {
      return;
    }
    enqueueTts({ id: payload.id, ...payload.tts });
  };

  return onServerMessage(CHAT_MESSAGE_TYPE, (payload) => {
    if (Array.isArray(payload)) {
      for (const item of payload) {
        handleFrame(item);
      }
      return;
    }
    handleFrame(payload);
  });
}

/** Acceso reactivo de solo lectura al estado de la cola, para la UI. */
export function useTtsQueue() {
  return {
    size,
    blocked: computed(() => blocked.value),
    paused: computed(() => paused.value),
    current: computed(() => current.value),
    speakingId: computed(() => current.value?.id ?? null),
    pendingCount: computed(() => pending.value.length),
    enqueuedTotal: computed(() => enqueuedTotal.value),
    finishedTotal: computed(() => finishedTotal.value),
    speakLog: computed(() => speakLog.value),
  };
}

/**
 * Superficie de diagnóstico en `window.__ttsHub` (solo en desarrollo).
 *
 * Existe porque el TTS no se puede verificar "oyendo" en un navegador headless:
 * con esto un script por CDP puede leer el orden exacto de la cola, lo que se
 * pidió hablar, y accionar los controles. También es el enganche por el que
 * T-009/T-010 pueden probar su motor sin credenciales.
 */
export function exposeTtsDiagnostics() {
  if (!import.meta.env.DEV || typeof window === 'undefined') {
    return;
  }
  ensureEngines();
  window.__ttsHub = {
    get state() {
      return {
        size: size.value,
        pending: pending.value.map((item) => ({ id: item.id, text: item.text })),
        current: current.value === null ? null : { id: current.value.id, text: current.value.text },
        paused: paused.value,
        blocked: blocked.value,
        enqueuedTotal: enqueuedTotal.value,
        finishedTotal: finishedTotal.value,
        // T-013: el volumen maestro vigente, para poder verificar el escalado.
        masterVolume: ttsMasterVolume.value,
      };
    },
    get spoken() {
      return speakLog.value.map((entry) => ({ ...entry }));
    },
    enqueue: enqueueTts,
    skip: skipCurrent,
    clear: clearQueue,
    pause: pauseQueue,
    resume: resumeQueue,
    reset: resetTtsQueue,
    /** Permite sustituir un motor por uno instrumentado (o probar T-009/T-010). */
    registerEngine: registerTtsEngine,
    engines: listTtsEngineNames,
  };
}
