/**
 * `BrowserEngine` (T-008): el motor TTS del navegador, sobre la Web Speech API.
 *
 * Es el motor por defecto y el respaldo de todos los demás: el backend cae a
 * `{ engine: 'browser', voiceId: null }` cuando la voz pedida pertenece a un
 * motor que no está registrado (por ejemplo la voz global `edge:*` antes de que
 * T-009 exista). `voiceId: null` significa "elige tú la mejor voz en español".
 *
 * Detalles de la Web Speech API que este módulo encapsula:
 *
 * - **El catálogo llega tarde.** `getVoices()` suele devolver `[]` en el primer
 *   tick y se rellena al disparar `voiceschanged`. Por eso la voz se elige en el
 *   momento de hablar, no al construir el motor.
 * - **Hay que retener la utterance.** Si se le deja recolectar al GC, Chrome
 *   corta el audio a media frase; se guarda una referencia hasta que termina.
 * - **`cancel()` también dispara `end`.** Un guard interno garantiza que la cola
 *   reciba `onEnd`/`onError` una sola vez.
 * - **Puede no arrancar nunca** (Chrome headless, o un SO sin voces instaladas):
 *   sin voces `speak()` no emite ni `start` ni `error`. Un watchdog corta la
 *   espera y la cola avanza en lugar de quedarse bloqueada para siempre.
 */
import { registerTtsEngine } from './engine.js';

/** Nombre del motor: coincide con el namespace de sus ids de voz. */
export const BROWSER_ENGINE_NAME = 'browser';

/** Idioma preferido cuando el backend no pide una voz concreta. */
export const PREFERRED_LANGS = Object.freeze(['es-MX', 'es-US', 'es-419', 'es-ES', 'es']);

/**
 * Si en este tiempo la utterance no ha empezado a sonar, se da por fallida y la
 * cola sigue. Generoso a propósito: en un arranque frío el motor del SO tarda.
 */
export const START_TIMEOUT_MS = 4000;

/** `true` si este navegador tiene Web Speech. */
export const isSpeechSynthesisSupported = () =>
  typeof window !== 'undefined' && typeof window.speechSynthesis !== 'undefined';

/**
 * Voces del navegador, en el formato del catálogo (`TtsVoice`), con sus ids
 * namespaced `browser:<name>`. Puede venir vacía si el catálogo aún no cargó
 * (o siempre, en un navegador sin voces instaladas).
 */
export function listBrowserVoices() {
  if (!isSpeechSynthesisSupported()) {
    return [];
  }
  return window.speechSynthesis.getVoices().map((voice) => ({
    id: `${BROWSER_ENGINE_NAME}:${voice.name}`,
    name: voice.name,
    engine: BROWSER_ENGINE_NAME,
    language: voice.lang ?? null,
    label: `${voice.name} (${voice.lang})`,
  }));
}

/** Nombre de voz pedido dentro de un id `browser:<name>`, o `null`. */
function requestedVoiceName(voiceId) {
  if (typeof voiceId !== 'string') {
    return null;
  }
  const prefix = `${BROWSER_ENGINE_NAME}:`;
  return voiceId.startsWith(prefix) ? voiceId.slice(prefix.length) : null;
}

/**
 * Elige la `SpeechSynthesisVoice` a usar: la pedida por nombre si existe, y si
 * no la mejor voz en español disponible. `null` = que decida el navegador.
 */
export function pickVoice(voiceId, voices = window.speechSynthesis.getVoices()) {
  if (!Array.isArray(voices) || voices.length === 0) {
    return null;
  }

  const wanted = requestedVoiceName(voiceId);
  if (wanted !== null) {
    const exact = voices.find((voice) => voice.name === wanted || voice.voiceURI === wanted);
    if (exact) {
      return exact;
    }
  }

  for (const lang of PREFERRED_LANGS) {
    const match = voices.find((voice) => (voice.lang ?? '').toLowerCase().replace('_', '-').startsWith(lang.toLowerCase()));
    if (match) {
      return match;
    }
  }

  return null;
}

/** Utterances en vuelo: solo están aquí para que el GC no las recoja. */
const held = new Set();

/** Motor de cliente `browser`. Cumple el contrato de `./engine.js`. */
export function createBrowserEngine() {
  return {
    name: BROWSER_ENGINE_NAME,

    isSupported: isSpeechSynthesisSupported,

    speak(item, { onEnd, onError } = {}) {
      if (!isSpeechSynthesisSupported()) {
        onError?.(new Error('este navegador no tiene Web Speech API'));
        return { cancel: () => {}, voice: null };
      }

      const synth = window.speechSynthesis;
      const utterance = new window.SpeechSynthesisUtterance(item.text);
      const voice = pickVoice(item.voiceId, synth.getVoices());

      if (voice) {
        utterance.voice = voice;
      }
      // Aunque no haya voz elegida, el idioma orienta al motor del SO.
      utterance.lang = voice?.lang ?? PREFERRED_LANGS[0];
      utterance.pitch = item.pitch ?? 1;
      utterance.volume = item.volume ?? 1;

      let settled = false;
      let startWatchdog = null;

      const clearWatchdog = () => {
        if (startWatchdog !== null) {
          window.clearTimeout(startWatchdog);
          startWatchdog = null;
        }
      };

      const settle = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearWatchdog();
        // Suelta la referencia que evitaba el GC durante la reproducción.
        held.delete(utterance);
        if (error) {
          onError?.(error);
          return;
        }
        onEnd?.();
      };

      utterance.addEventListener('start', clearWatchdog);
      utterance.addEventListener('end', () => settle(null));
      utterance.addEventListener('error', (event) => {
        // `canceled`/`interrupted` los provoca la propia cola al saltar o vaciar:
        // no son fallos, son un final normal.
        const reason = event?.error ?? 'error desconocido';
        settle(reason === 'canceled' || reason === 'interrupted' ? null : new Error(`web speech: ${reason}`));
      });

      held.add(utterance);
      startWatchdog = window.setTimeout(() => {
        startWatchdog = null;
        settle(new Error('web speech: la síntesis no arrancó (¿sin voces instaladas?)'));
      }, START_TIMEOUT_MS);

      synth.speak(utterance);

      return {
        voice: voice?.name ?? null,
        cancel: () => {
          // Primero se corta y después se resuelve: al revés, el `onEnd` haría
          // que la cola arrancara el siguiente y este `cancel()` lo mataría.
          synth.cancel();
          settle(null);
        },
        pause: () => synth.pause(),
        resume: () => synth.resume(),
      };
    },
  };
}

/** Registra el motor del navegador. Lo llama la cola al inicializarse. */
export const registerBrowserEngine = () => registerTtsEngine(createBrowserEngine());
