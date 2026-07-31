/**
 * Comandos de chat (T-012, T-017). Hay dos: `!cambia-mi-voz` (quien lo escribe
 * se lleva una voz aleatoria en español del catálogo completo, persistida con
 * `voice_source = 'command'`) y `!configura-mi-voz` (postea el link a la
 * pantalla propia de configuración, T-015/`viewer/`).
 *
 * ## Dónde encaja
 *
 * No cuelga del pipeline TTS: los comandos llegan por el flujo de mensajes del
 * relay (`../chat/relay.js`), que entrega **todos** los mensajes normalizados,
 * incluso los que el pipeline decide no mostrar ni leer. Por eso:
 *
 * - el mensaje `!cambia-mi-voz` **se ve en el chat y no se lee** sin que este
 *   módulo haga nada: el filtro de comandos de T-008 (`../tts/filters.js`,
 *   `TTS_SKIP_REASONS.command`) ya lo salta;
 * - un usuario `muted` o incluso `ignored` puede usar el comando.
 *
 * ## Decisiones
 *
 * - **La escritura de la voz pasa por `assignUserVoice()`** (T-011,
 *   `../tts/voice-model.js`), que es el único sitio donde vive la regla "el
 *   override del streamer gana". Aquí no se reimplementa la prioridad: si el
 *   streamer le había fijado la voz, el comando no escribe nada.
 * - **El catálogo se lee del registro de motores** (`registry.listVoices()`, la
 *   misma fuente que `GET /api/voices`), así que las voces disponibles son las de
 *   todos los motores registrados en esta instalación. **No hay ninguna lista de
 *   voces escrita a mano**: si mañana Piper no está instalado, o edge-tts está
 *   apagado, el comando sortea sobre lo que quede.
 * - **Sin cooldown, a propósito.** El plan lo pone en los no-objetivos ("Cooldown
 *   o anti-spam del comando — decisión consciente, revisable"), así que repetir el
 *   comando vuelve a rodar la voz siempre. Si algún día hace falta limitarlo, este
 *   es el sitio y basta con recordar la última tirada por usuario.
 * - **La voz nueva es siempre distinta de la actual** (la que se le está oyendo:
 *   la suya si tiene, la global si no), para que la tirada se note. Si el catálogo
 *   no ofrece ninguna alternativa en español, no se escribe nada.
 * - **Nunca lanza.** Se ejecuta en el camino de un mensaje de chat: un fallo de la
 *   base, del catálogo o de la red se registra en el log y el chat sigue.
 */
import { config } from '../config.js';
import { getRepositories } from '../db/index.js';
import { logger } from '../logger.js';
import { sendChatMessage } from './send.js';
import { COMMAND_PREFIX } from '../tts/filters.js';
import { isPreferredLanguage } from '../tts/router.js';
import { getTtsRegistry } from '../tts/registry.js';
import {
  VOICE_SOURCES,
  assignUserVoice,
  canAssignVoice,
  normalizeVoiceId,
  randomUserPitch,
  randomUserTimbre,
  resolveUserVoice,
} from '../tts/voice-model.js';

/**
 * El comando de este proyecto, tal como lo nombra el plan. Lleva el mismo
 * `COMMAND_PREFIX` que ya usa el filtro TTS de T-008 (`../tts/filters.js`), que es
 * justo por lo que el mensaje no se lee en voz alta.
 */
export const VOICE_ROLL_COMMAND = `${COMMAND_PREFIX}cambia-mi-voz`;

/** T-017: postea el link a la pantalla de configuración de voz (`viewer/`). */
export const VOICE_CONFIG_COMMAND = `${COMMAND_PREFIX}configura-mi-voz`;

/**
 * Resultado de `handle()`. `matched: false` significa "el mensaje no era un
 * comando conocido" (el caso normal: la inmensa mayoría de los mensajes).
 */
export const COMMAND_OUTCOMES = Object.freeze({
  /** Se asignó la voz nueva. */
  applied: 'applied',
  /** El streamer le había fijado la voz: el comando no la pisa. */
  overrideWins: 'override_wins',
  /** El catálogo no ofrece ninguna voz en español distinta de la actual. */
  noVoices: 'no_voices',
  /** Algo falló (base, catálogo, red); queda en el log y el chat sigue. */
  failed: 'failed',
});

/**
 * Nombre del comando que trae un texto de chat, en minúsculas y con el prefijo
 * (`'!cambia-mi-voz'`), o `null` si el texto no es un comando.
 *
 * Se admite lo que un espectador escribe de verdad: espacios delante, mayúsculas
 * y argumentos de más (`'  !Cambia-Mi-Voz ya!'`). Lo que sigue al primer espacio
 * se ignora, así que un comando con cola sigue funcionando.
 */
export function parseChatCommand(text) {
  if (typeof text !== 'string') {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed.startsWith(COMMAND_PREFIX)) {
    return null;
  }
  const [word] = trimmed.split(/\s+/);
  return word.toLowerCase();
}

/** `true` si la voz del catálogo sirve para el sorteo: en español y con id. */
export const isSpanishVoice = (voice) =>
  normalizeVoiceId(voice?.id) !== null && isPreferredLanguage(voice?.language);

/**
 * Elige una voz en español del catálogo, distinta de `excludeVoiceId`.
 *
 * @param {Array<{ id: string, language?: string }>} voices catálogo agregado.
 * @param {string|null} excludeVoiceId  la voz que el usuario ya tiene.
 * @param {() => number} [random]       fuente de aleatoriedad (inyectable).
 * @returns {object|null} la voz elegida, o `null` si no hay ninguna alternativa.
 */
export function pickRandomSpanishVoice(voices, excludeVoiceId, random = Math.random) {
  const current = normalizeVoiceId(excludeVoiceId);
  const candidates = (Array.isArray(voices) ? voices : []).filter(
    (voice) => isSpanishVoice(voice) && voice.id !== current,
  );

  if (candidates.length === 0) {
    return null;
  }

  const index = Math.min(candidates.length - 1, Math.floor(random() * candidates.length));
  return candidates[index];
}

/**
 * @param {object} [options]
 * @param {Function} [options.repositories] getter de repositorios (inyectable en pruebas).
 * @param {object} [options.registry] registro de motores TTS; por default
 *        el del proceso, **resuelto tarde** (en el primer comando) para no
 *        construir motores solo por crear el relay.
 * @param {() => number} [options.random] fuente de aleatoriedad (inyectable).
 * @param {Function} [options.sendMessage] `!configura-mi-voz` postea con esto
 *        (T-017); por default `sendChatMessage()` real, que habla con la
 *        sesión de Twitch **global** del proceso (no con `repositories`
 *        inyectado). **Cualquier prueba que ejercite ese comando tiene que
 *        inyectar acá un doble** — de lo contrario el comando termina
 *        publicando de verdad en el canal real (pasó una vez, ver el
 *        historial de T-017: una prueba sin este parámetro posteó un mensaje
 *        real durante un smoke test).
 */
export function createChatCommands({
  repositories = getRepositories,
  registry = null,
  random = Math.random,
  sendMessage = sendChatMessage,
} = {}) {
  const resolveRegistry = () => registry ?? getTtsRegistry();

  /** Fila del usuario, creándola si su primer mensaje es justo el comando. */
  const ensureUser = (users, message) =>
    users.get(message.userId) ??
    users.ensure({
      twitchUserId: message.userId,
      username: message.username,
      displayName: message.displayName,
      // Mismo reparto que el relay en el primer mensaje (T-011): el pitch y el
      // timbre se asignan al INSERTAR, que es el único momento en que se puede.
      pitch: randomUserPitch(random),
      timbre: randomUserTimbre(random),
    });

  const rollVoice = async (message) => {
    const repos = repositories();
    const user = ensureUser(repos.users, message);

    // La regla de la prioridad es de `voice-model.js`; aquí solo se consulta para
    // no salir a pedir el catálogo cuando no se va a poder escribir.
    if (!canAssignVoice(user?.voiceSource, VOICE_SOURCES.command)) {
      logger.info(`chat: ${message.username} pidió cambiar de voz, pero tiene una voz asignada por ti`);
      return { matched: true, applied: false, outcome: COMMAND_OUTCOMES.overrideWins, voiceId: null };
    }

    const currentVoiceId = resolveUserVoice(user, repos.settings.getGlobalVoiceId()).voiceId;
    const voice = pickRandomSpanishVoice(await resolveRegistry().listVoices(), currentVoiceId, random);

    if (voice === null) {
      logger.warn(`chat: no hay ninguna voz en español distinta de la actual para ${message.username}`);
      return { matched: true, applied: false, outcome: COMMAND_OUTCOMES.noVoices, voiceId: null };
    }

    const result = assignUserVoice(repos.users, message.userId, {
      voiceId: voice.id,
      source: VOICE_SOURCES.command,
    });

    if (!result.applied) {
      // Solo llega aquí si la fila cambió entre la lectura y la escritura.
      logger.info(`chat: la voz de ${message.username} no se cambió (${result.reason})`);
      return {
        matched: true,
        applied: false,
        outcome: result.reason === 'override_wins' ? COMMAND_OUTCOMES.overrideWins : COMMAND_OUTCOMES.failed,
        voiceId: null,
      };
    }

    logger.info(`chat: ${message.username} rodó voz nueva con ${VOICE_ROLL_COMMAND} (${voice.id})`);
    return {
      matched: true,
      applied: true,
      outcome: COMMAND_OUTCOMES.applied,
      voiceId: voice.id,
      previousVoiceId: currentVoiceId,
    };
  };

  /**
   * T-017: postea el link a la pantalla de configuración (`viewer/`), propio
   * de cada streamer vía `config.viewerService.publicUrl`. No toca SQLite ni
   * el catálogo de voces — el guardado real lo hace `viewer/preferences-router.js`
   * cuando el viewer confirma en la pantalla, autenticado con SU sesión de
   * Twitch, no con este comando (que cualquiera puede escribir sin probar
   * quién es).
   */
  const configureVoice = async (message) => {
    const url = config.viewerService.publicUrl;
    try {
      await sendMessage(`@${message.displayName} configurá tu voz acá: ${url}`);
    } catch (error) {
      logger.error(`chat: no se pudo publicar el link de ${VOICE_CONFIG_COMMAND} (${error.message})`);
      return { matched: true, applied: false, outcome: COMMAND_OUTCOMES.failed, voiceId: null };
    }
    return { matched: true, applied: true, outcome: COMMAND_OUTCOMES.applied, voiceId: null };
  };

  /** Qué comando ejecuta qué. Añadir uno nuevo es una entrada más aquí. */
  const handlers = new Map([
    [VOICE_ROLL_COMMAND, rollVoice],
    [VOICE_CONFIG_COMMAND, configureVoice],
  ]);

  return {
    /** Los comandos que este backend entiende. */
    names: () => [...handlers.keys()],

    /**
     * Procesa un mensaje normalizado. Devuelve una promesa que **nunca rechaza**:
     * el relay no puede quedarse a medias por un comando.
     *
     * @returns {Promise<{ matched: boolean, applied?: boolean, outcome?: string, voiceId?: string|null }>}
     */
    async handle(message) {
      const name = parseChatCommand(message?.text);
      const run = name === null ? undefined : handlers.get(name);
      if (run === undefined) {
        return { matched: false };
      }

      try {
        return await run(message);
      } catch (error) {
        logger.error(`chat: el comando ${name} falló (${error.message})`);
        return { matched: true, applied: false, outcome: COMMAND_OUTCOMES.failed, voiceId: null };
      }
    },
  };
}
