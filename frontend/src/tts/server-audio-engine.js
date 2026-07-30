/**
 * Motor de cliente **genérico** para cualquier motor TTS de servidor (T-009).
 *
 * Es la contraparte de `backend/src/tts/server-audio.js`: el backend ya sintetizó
 * el audio y adjuntó su URL a la instrucción; aquí solo se descarga y se
 * reproduce. No sabe nada de edge-tts, así que **T-010 (Piper) lo reutiliza tal
 * cual**: le basta una línea en `../stores/tts-queue.js`
 * (`registerServerAudioEngine('piper')`).
 *
 * Contrato con la cola (`../stores/tts-queue.js`), que **no se toca**:
 *
 * - `speak(item, { onEnd, onError })` llama a `onEnd`/`onError` exactamente una
 *   vez, así que un mensaje de servidor ocupa su turno en la misma cola FIFO que
 *   los del navegador. El orden entre motores mezclados sale del orden de llegada
 *   de las tramas, y esas salen del backend sin esperar la síntesis.
 * - `item.audio = { url }` (T-009). Si falta, o si algo falla, se recurre al motor
 *   del navegador **para ese mismo enunciado**, sin perder su turno.
 *
 * Reparto de pitch y volumen (ver la cabecera de `backend/src/tts/edge-engine.js`):
 *
 * - **pitch** → ya viene aplicado en la síntesis; un `<audio>` no puede cambiar el
 *   tono sin cambiar la velocidad, así que aquí no se toca.
 * - **volumen** → se aplica aquí, exacto, con `audio.volume` (0–1). Por eso el
 *   backend no lo mete además en el SSML: se atenuaría dos veces.
 *
 * ## El respaldo (criterio de T-009)
 *
 * Cualquier fallo —`503` porque la síntesis falló, red caída, audio ilegible, o el
 * navegador negándose a reproducir— acaba en el motor del navegador con la misma
 * instrucción. `voiceId` sigue siendo `edge:*`/`piper:*`, y el motor del navegador
 * ya trata un id de otro namespace como "elige la mejor voz en español"
 * (`pickVoice()`), así que no hay que reescribir la instrucción. La cola no se
 * rompe ni se salta el mensaje: solo cambia quién lo lee.
 */
import { createBrowserEngine } from './browser-engine.js';
import { registerTtsEngine } from './engine.js';

/** Tope para descargar el audio del backend antes de recurrir al navegador. */
export const AUDIO_FETCH_TIMEOUT_MS = 10_000;

const clampVolume = (value) => {
  const volume = typeof value === 'number' && Number.isFinite(value) ? value : 1;
  return Math.min(1, Math.max(0, volume));
};

/**
 * Crea el motor de cliente de un motor de servidor.
 *
 * @param {string} name nombre del motor, igual que en el backend (`'edge'`).
 * @param {object} [options] costuras para las pruebas.
 */
export function createServerAudioEngine(name, options = {}) {
  const {
    browserEngine = createBrowserEngine(),
    fetchImpl = (...args) => window.fetch(...args),
    createAudio = (src) => new window.Audio(src),
    timeoutMs = AUDIO_FETCH_TIMEOUT_MS,
  } = options;

  return {
    name,

    /** Hace falta poder reproducir audio; si no, que lo intente el navegador. */
    isSupported: () => typeof window !== 'undefined' && typeof window.Audio === 'function',

    speak(item, { onEnd, onError } = {}) {
      let settled = false;
      let cancelled = false;
      let audio = null;
      let objectUrl = null;
      let fallbackHandle = null;

      const releaseObjectUrl = () => {
        if (objectUrl !== null) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = null;
        }
      };

      const settle = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        releaseObjectUrl();
        if (error) {
          onError?.(error);
          return;
        }
        onEnd?.();
      };

      /** Respaldo: que lo lea el motor del navegador, sin perder el turno. */
      const speakWithBrowser = (reason) => {
        if (settled) {
          return;
        }
        releaseObjectUrl();
        console.warn(`tts: ${name} no pudo reproducir el audio del backend (${reason}); se leerá con el navegador`);
        if (cancelled) {
          settle(null);
          return;
        }
        fallbackHandle = browserEngine.speak(item, { onEnd: () => settle(null), onError: settle });
      };

      const play = async () => {
        const url = item?.audio?.url ?? null;
        if (typeof url !== 'string' || url === '') {
          throw new Error('la instrucción no trae audio del backend');
        }

        // `AbortSignal.timeout` evita quedarse esperando un backend que no responde
        // (la cola se pararía en este enunciado).
        const response = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) {
          throw new Error(`el backend respondió ${response.status}`);
        }

        const blob = await response.blob();
        if (blob.size === 0) {
          throw new Error('el audio llegó vacío');
        }
        if (cancelled) {
          return;
        }

        objectUrl = URL.createObjectURL(blob);
        audio = createAudio(objectUrl);
        audio.volume = clampVolume(item?.volume);
        audio.addEventListener('ended', () => settle(null));
        audio.addEventListener('error', () => speakWithBrowser('el navegador no pudo decodificar el audio'));

        await audio.play();
      };

      play().catch((error) => speakWithBrowser(error?.message ?? String(error)));

      return {
        /** Informativo para el registro de diagnóstico de la cola. */
        voice: item?.voiceId ?? null,

        cancel: () => {
          cancelled = true;
          if (fallbackHandle !== null) {
            fallbackHandle.cancel?.();
            settle(null);
            return;
          }
          // Igual que el motor del navegador: primero se corta, después se
          // resuelve, para que el `onEnd` no arranque el siguiente antes de tiempo.
          audio?.pause?.();
          settle(null);
        },

        pause: () => {
          if (fallbackHandle !== null) {
            fallbackHandle.pause?.();
            return;
          }
          audio?.pause?.();
        },

        resume: () => {
          if (fallbackHandle !== null) {
            fallbackHandle.resume?.();
            return;
          }
          // Si el navegador vuelve a negarse, se recurre al respaldo.
          audio?.play?.()?.catch?.((error) => speakWithBrowser(error?.message ?? String(error)));
        },
      };
    },
  };
}

/** Registra el motor de cliente de un motor de servidor. Devuelve el motor. */
export const registerServerAudioEngine = (name, options) => registerTtsEngine(createServerAudioEngine(name, options));
