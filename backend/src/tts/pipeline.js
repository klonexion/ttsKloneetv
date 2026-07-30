/**
 * Pipeline TTS (T-008): por cada mensaje de chat decide **si se muestra**, **si
 * se lee** y **con qué parámetros**.
 *
 * Es la única pieza del backend que conoce a la vez las preferencias del usuario
 * (`users`), los ajustes globales (`app_settings`) y el registro de motores, y su
 * salida es lo que viaja al frontend adjunto a la trama `chat:message`
 * (ver `src/chat/relay.js`):
 *
 *     decide(message) -> {
 *       visible: boolean,          // false SOLO para usuarios `ignored`
 *       reason: string | null,     // por qué no se lee (TTS_SKIP_REASONS)
 *       tts: null | {              // instrucción para el frontend
 *         engine,                  // 'browser' | 'edge' | 'piper'
 *         voiceId,                 // id namespaced, o null = "elige tú"
 *         pitch,                   // 0–2 (Web Speech), default 1
 *         timbre,                  // 0–2, default 1 — ya combinado con el maestro
 *         volume,                  // 0–1, default 1
 *         text,                    // SOLO el texto, sin "usuario dice"
 *         audio,                   // T-009: { url } si lo sintetiza el backend
 *       },
 *     }
 *
 * Decisiones de diseño que las tareas siguientes deben respetar:
 *
 * - **Sincrónico y a prueba de fallos.** Se ejecuta dentro del camino de cada
 *   mensaje: no espera I/O y nunca lanza. Si la base falla, el mensaje se
 *   muestra sin TTS (mejor mudo que invisible).
 * - **`visible: false` solo para `ignored`.** `muted` sí se muestra. La asimetría
 *   es del plan y vive en `./filters.js`.
 * - **La síntesis no se espera aquí.** Con un motor de servidor (T-009 edge, T-010
 *   Piper) `decide()` sigue devolviendo al instante: solo **arranca** la síntesis
 *   y adjunta `audio.url` (`./server-audio.js`), de modo que la trama sale en el
 *   orden del chat y la cola FIFO del frontend no se altera al mezclar motores.
 */
import { logger } from '../logger.js';
import { getRepositories } from '../db/index.js';
import { MASTER_TIMBRE_KEY, normalizeMasterTimbre } from '../settings/settings.js';
import { TTS_SKIP_REASONS, findSkipReason, toSpokenText } from './filters.js';
import { getTtsRegistry } from './registry.js';
import { createServerAudioStore } from './server-audio.js';
import { combineTimbre, resolveUserVoice } from './voice-model.js';

/** Pitch neutro y rango que acepta Web Speech (`SpeechSynthesisUtterance`). */
const PITCH_DEFAULT = 1;
const PITCH_MIN = 0;
const PITCH_MAX = 2;

/** Timbre neutro y rango (mismo 0–2 que el pitch; ver `combineTimbre()`). */
const TIMBRE_DEFAULT = 1;
const TIMBRE_MIN = 0;
const TIMBRE_MAX = 2;

/** Volumen neutro y rango de Web Speech / `HTMLAudioElement`. */
const VOLUME_DEFAULT = 1;
const VOLUME_MIN = 0;
const VOLUME_MAX = 1;

const clamp = (value, min, max, fallback) => {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, number));
};

/** Decisión "se muestra pero no se lee". */
const notSpoken = (reason) => ({ visible: true, reason, tts: null });

/**
 * @param {object} [options]
 * @param {ReturnType<import('./registry.js').createTtsEngineRegistry>} [options.registry]
 * @param {Function} [options.repositories] getter de repositorios (inyectable en pruebas).
 * @param {ReturnType<import('./server-audio.js').createServerAudioStore>} [options.serverAudio]
 *        almacén del audio de los motores de servidor; por default uno sobre este
 *        mismo registro (T-009).
 */
export function createTtsPipeline({
  registry = getTtsRegistry(),
  repositories = getRepositories,
  serverAudio = createServerAudioStore({ registry }),
} = {}) {
  /**
   * Voz, pitch, timbre y volumen del autor (modelo de voz de T-011).
   *
   * La prioridad `override` > `command` > global vive en `./voice-model.js`
   * (`resolveUserVoice`), que es también lo que usan el panel del usuario y el
   * comando `!cambia-mi-voz`: aquí solo se **lee**.
   *
   * El pitch/timbre **no se asignan aquí**: se reparten al insertar la fila del
   * usuario (el relay en su primer mensaje, el panel si se le guarda una
   * preferencia antes de que escriba), porque `users.pitch`/`users.timbre` son
   * `NOT NULL DEFAULT 1` y no hay ningún valor que signifique "sin asignar" — el
   * por qué está en `./voice-model.js`. Así este pipeline sigue siendo de solo
   * lectura y sincrónico dentro del camino de cada mensaje.
   *
   * El timbre sí se **combina** acá con el maestro del canal
   * (`combineTimbre()`), a diferencia del volumen: el volumen maestro se aplica
   * en la reproducción (frontend), pero el timbre es un parámetro de síntesis
   * — tiene que viajar ya combinado en la instrucción, antes de que el motor
   * sintetice nada.
   */
  const resolveVoiceParams = (user, settings) => ({
    requestedVoiceId: resolveUserVoice(user, settings.getGlobalVoiceId()).voiceId,
    pitch: clamp(user?.pitch, PITCH_MIN, PITCH_MAX, PITCH_DEFAULT),
    timbre: combineTimbre(
      clamp(user?.timbre, TIMBRE_MIN, TIMBRE_MAX, TIMBRE_DEFAULT),
      normalizeMasterTimbre(settings.get(MASTER_TIMBRE_KEY)),
    ),
    volume: clamp(user?.volume, VOLUME_MIN, VOLUME_MAX, VOLUME_DEFAULT),
  });

  /**
   * Añade a la instrucción la URL de su audio cuando la lee un motor de servidor
   * (T-009 edge, T-010 Piper), **arrancando** la síntesis sin esperarla: ver
   * `./server-audio.js` para el por qué. Con un motor de cliente devuelve la
   * instrucción tal cual. Nunca lanza: sin audio adjunto, el frontend lo lee con
   * el motor del navegador.
   */
  const attachServerAudio = (messageId, tts) => {
    try {
      return serverAudio.attach(messageId, tts);
    } catch (error) {
      logger.error(`tts: no se pudo preparar el audio del mensaje ${messageId} (${error.message})`);
      return tts;
    }
  };

  return {
    registry,
    serverAudio,

    /**
     * Decide qué hacer con un mensaje normalizado
     * (`{ id, userId, username, displayName, text, timestamp }`).
     */
    decide(message) {
      let user = null;
      let repos;

      try {
        repos = repositories();
        user = repos.users.get(message.userId);
      } catch (error) {
        // Sin preferencias no se puede decidir con criterio: se muestra y no se
        // lee, que es la opción que no pierde información en pantalla.
        logger.error(`tts: no se pudieron leer las preferencias del usuario (${error.message})`);
        return notSpoken(null);
      }

      const reason = findSkipReason(message, user);

      if (reason === TTS_SKIP_REASONS.ignored) {
        return { visible: false, reason, tts: null };
      }
      if (reason !== null) {
        return notSpoken(reason);
      }

      const { requestedVoiceId, pitch, timbre, volume } = resolveVoiceParams(user, repos.settings);
      const { engine, voiceId } = registry.resolve(requestedVoiceId);

      const tts = {
        engine: engine.name,
        voiceId,
        pitch,
        timbre,
        volume,
        text: toSpokenText(message.text),
      };

      return {
        visible: true,
        reason: null,
        tts: attachServerAudio(message.id, tts),
      };
    },
  };
}

let defaultPipeline = null;

/** Pipeline por defecto del proceso (perezoso, sobre el registro por defecto). */
export function getTtsPipeline() {
  if (defaultPipeline === null) {
    defaultPipeline = createTtsPipeline();
  }
  return defaultPipeline;
}

/*
 * Huecos deliberados (documentados también en las notas de T-008 del exec-plan):
 *
 * - **T-009 / T-010 (motores de servidor).** Resuelto de forma genérica y ya no es
 *   un hueco: `decide()` llama a `serverAudio.attach()`, que solo actúa si el
 *   motor resuelto es `kind: 'server'`. T-010 no toca este archivo; le basta
 *   registrar su motor. La forma exacta y el por qué de servir `audio.url` en vez
 *   de `audio.base64` están en `./server-audio.js`.
 * - **T-011 (modelo de voz/pitch).** Resuelto y ya no es un hueco:
 *   `resolveVoiceParams()` aplica la prioridad de `./voice-model.js` y el pitch se
 *   reparte al insertar la fila del usuario (`../chat/relay.js` en su primer
 *   mensaje, `../users/preferences.js` si el streamer le guarda algo antes).
 * - **T-012 (`!cambia-mi-voz`).** No cuelga de aquí: los comandos se procesan con
 *   `relay.onMessage()`, que sigue viendo el mensaje aunque este pipeline lo marque
 *   como `command` y no lo lea. Para escribir la voz que rueda el usuario, el
 *   enganche es `assignUserVoice(users, id, { voiceId, source: 'command' })` de
 *   `./voice-model.js`, que ya respeta el override del streamer.
 */
