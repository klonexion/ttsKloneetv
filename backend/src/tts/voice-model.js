/**
 * Modelo de voz y pitch por usuario (T-011). Es la pieza que decide **con qué voz
 * y con qué tono** se lee a cada quien, y la única fuente de verdad de esa
 * decisión: el pipeline (`./pipeline.js`), el router de preferencias
 * (`../users/router.js`) y el comando `!cambia-mi-voz` (T-012) la consumen; nadie
 * más debe reimplementar la prioridad.
 *
 * ## Prioridad de la voz (decisión durable del plan)
 *
 *     1. override  — la que le fijó el streamer desde el panel del usuario.
 *     2. command   — la que rodó el propio usuario con `!cambia-mi-voz` (T-012).
 *     3. global    — `app_settings.global_voice_id` (default `edge:es-MX-DaliaNeural`).
 *
 * La columna `users.voice_source` (`'override' | 'command' | NULL`) es la que
 * distingue los niveles 1 y 2; `NULL` significa "usa la global". Consecuencia
 * buscada: **cambiar la voz global (T-013) afecta solo al nivel 3**, porque los
 * otros dos tienen su propio `voice_id` y nunca se lee la global para ellos.
 *
 * La prioridad manda en dos momentos distintos:
 *
 * - **Al leer** (`resolveUserVoice`): si el usuario tiene voz propia se usa esa;
 *   si no, la global.
 * - **Al escribir** (`canAssignVoice` / `assignUserVoice`): una voz de comando
 *   **no pisa** un override del streamer. Este es el enganche de T-012: le basta
 *   llamar a `assignUserVoice(users, id, { voiceId, source: 'command' })` y
 *   respetar el `applied: false` que devuelve cuando hay override.
 *
 * ## Pitch aleatorio persistente
 *
 * Cada usuario recibe en su **primer mensaje** un pitch aleatorio en [0.8, 1.4]
 * que no vuelve a cambiar solo: es lo que hace distinguibles a dos personas que
 * comparten voz. La asignación ocurre **en la inserción de la fila**
 * (`users.upsert()` desde el relay, `users.ensure()` desde el panel), porque
 * `users.pitch` es `NOT NULL DEFAULT 1` en el esquema de T-002 y por lo tanto no
 * existe ningún valor que signifique "todavía sin asignar": si no se asigna al
 * insertar, después es imposible distinguir "nunca se le asignó" de "el streamer
 * lo dejó en 1.00". El upsert de T-002 no pisa el pitch en los mensajes
 * siguientes, así que la persistencia sale gratis.
 *
 * ## Timbre aleatorio persistente
 *
 * Mismo mecanismo que el pitch, mismo rango [0.8, 1.4], misma columna
 * `NOT NULL DEFAULT 1` y mismo momento de asignación (la inserción de la fila).
 * La diferencia es lo que representa: el pitch cambia el tono percibido
 * (frecuencia); el timbre cambia la *textura* de la síntesis — cuánto ruido de
 * generador mete el modelo (Piper/MeloTTS, familia VITS: `noise_scale`/
 * `noise_w`) o, en los motores que no tienen ese control (edge-tts, SAPI,
 * Loquendo), una variación de velocidad independiente de la que ya compensa el
 * pitch. Cada motor decide qué hace con el número (ver `<motor>TimbreFactor()`
 * en cada `*-engine.js`); acá solo vive el sorteo y la persistencia, igual que
 * con el pitch.
 */

/** Rango del pitch aleatorio por usuario (decisión durable del plan). */
export const PITCH_RANDOM_MIN = 0.8;
export const PITCH_RANDOM_MAX = 1.4;

/** Decimales con los que se guarda el pitch (mantiene legible el valor en SQL). */
export const PITCH_DECIMALS = 2;

/** Valores admitidos por la columna `users.voice_source` (más `NULL`). */
export const VOICE_SOURCES = Object.freeze({
  override: 'override',
  command: 'command',
});

/** Niveles de la prioridad, del que más manda al que menos. */
export const VOICE_LEVELS = Object.freeze({
  override: 1,
  command: 2,
  global: 3,
});

/** Redondea un pitch a los decimales con los que se persiste. */
export const roundPitch = (value) => Number(Number(value).toFixed(PITCH_DECIMALS));

/**
 * Pitch aleatorio para un usuario nuevo, dentro de [0.8, 1.4].
 *
 * @param {() => number} [random] fuente de aleatoriedad (inyectable en pruebas).
 */
export function randomUserPitch(random = Math.random) {
  const span = PITCH_RANDOM_MAX - PITCH_RANDOM_MIN;
  const value = PITCH_RANDOM_MIN + random() * span;
  // El redondeo nunca saca el valor del rango (0.8 y 1.4 tienen 2 decimales).
  return roundPitch(Math.min(Math.max(value, PITCH_RANDOM_MIN), PITCH_RANDOM_MAX));
}

/** `true` si el pitch cae en el rango que reparte el modelo. */
export const isRandomPitchInRange = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= PITCH_RANDOM_MIN && value <= PITCH_RANDOM_MAX;

/** Rango del timbre aleatorio por usuario. Mismo rango que el pitch, ver arriba. */
export const TIMBRE_RANDOM_MIN = 0.8;
export const TIMBRE_RANDOM_MAX = 1.4;

/** Decimales con los que se guarda el timbre (igual que el pitch). */
export const TIMBRE_DECIMALS = 2;

/** Redondea un timbre a los decimales con los que se persiste. */
export const roundTimbre = (value) => Number(Number(value).toFixed(TIMBRE_DECIMALS));

/**
 * Timbre aleatorio para un usuario nuevo, dentro de [0.8, 1.4]. Misma fórmula
 * que `randomUserPitch()`, con su propia fuente de aleatoriedad inyectable
 * para que el sorteo de pitch y el de timbre se puedan fijar por separado en
 * las pruebas.
 *
 * @param {() => number} [random] fuente de aleatoriedad (inyectable en pruebas).
 */
export function randomUserTimbre(random = Math.random) {
  const span = TIMBRE_RANDOM_MAX - TIMBRE_RANDOM_MIN;
  const value = TIMBRE_RANDOM_MIN + random() * span;
  return roundTimbre(Math.min(Math.max(value, TIMBRE_RANDOM_MIN), TIMBRE_RANDOM_MAX));
}

/** `true` si el timbre cae en el rango que reparte el modelo. */
export const isRandomTimbreInRange = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= TIMBRE_RANDOM_MIN && value <= TIMBRE_RANDOM_MAX;

/** Rango final del timbre ya combinado (mismo 0–2 que `PREFERENCE_LIMITS.timbreMin/Max`). */
const TIMBRE_MIN = 0;
const TIMBRE_MAX = 2;

/**
 * Combina el timbre individual de un usuario con el timbre maestro del canal.
 * **Se suman los desvíos respecto de 1 (neutro), no se multiplican los
 * valores.** Con dos números centrados en 1 (como el pitch y el timbre),
 * multiplicar compondría el desvío: individual 1.3 × master 1.3 = 1.69, fuera
 * del rango 0–2 con solo dos usuarios "agudos". Sumando los desvíos
 * (individual 1.3 + (master 1.3 − 1) = 1.6) el maestro desplaza a todos por
 * igual, que es el efecto que se espera de un control "maestro" — el mismo
 * criterio que ya usa `effectiveVolume()` del frontend, adaptado a un rango
 * centrado en 1 en vez de 0–1.
 *
 * @param {number} individual  timbre del usuario (`users.timbre`).
 * @param {number} master      timbre maestro del canal (`tts_master_timbre`).
 */
export function combineTimbre(individual, master) {
  const ind = typeof individual === 'number' && Number.isFinite(individual) ? individual : 1;
  const mst = typeof master === 'number' && Number.isFinite(master) ? master : 1;
  return Math.min(TIMBRE_MAX, Math.max(TIMBRE_MIN, ind + (mst - 1)));
}

/** `true` si el valor es uno de los orígenes de voz que admite el esquema. */
export const isVoiceSource = (value) => value === VOICE_SOURCES.override || value === VOICE_SOURCES.command;

/** Normaliza un id de voz: string no vacío, o `null` ("usa la global"). */
export const normalizeVoiceId = (voiceId) =>
  typeof voiceId === 'string' && voiceId.trim() !== '' ? voiceId.trim() : null;

/**
 * Nivel de la prioridad en el que está un usuario.
 *
 * Una fila con `voice_id` pero sin `voice_source` solo se puede producir editando
 * SQLite a mano; se respeta la voz (el operador la puso a propósito) y se trata
 * como nivel 2, así que un override posterior la puede pisar.
 *
 * @param {object|null} user fila de `users` (o `null` si no existe todavía).
 * @returns {{ level: number, source: string|null, voiceId: string|null }}
 */
export function voiceLevelOf(user) {
  const voiceId = normalizeVoiceId(user?.voiceId);
  if (voiceId === null) {
    return { level: VOICE_LEVELS.global, source: null, voiceId: null };
  }

  const source = isVoiceSource(user?.voiceSource) ? user.voiceSource : null;
  if (source === VOICE_SOURCES.override) {
    return { level: VOICE_LEVELS.override, source, voiceId };
  }
  return { level: VOICE_LEVELS.command, source, voiceId };
}

/**
 * Voz con la que hay que leer a un usuario, aplicando la prioridad completa.
 *
 * @param {object|null} user  fila de `users`; `null` = todavía sin fila.
 * @param {string|null} globalVoiceId  `app_settings.global_voice_id`.
 * @returns {{ voiceId: string|null, level: number, source: string|null, fromGlobal: boolean }}
 *          `voiceId: null` significa "que el cliente elija su mejor voz en
 *          español" (mismo contrato que la instrucción TTS de T-008).
 */
export function resolveUserVoice(user, globalVoiceId) {
  const own = voiceLevelOf(user);
  if (own.level !== VOICE_LEVELS.global) {
    return { ...own, fromGlobal: false };
  }
  return {
    voiceId: normalizeVoiceId(globalVoiceId),
    level: VOICE_LEVELS.global,
    source: null,
    fromGlobal: true,
  };
}

/**
 * ¿Puede `nextSource` escribir la voz de un usuario cuyo origen actual es
 * `currentSource`? La única regla es la del plan: **el override del streamer
 * gana**, así que una voz de comando no lo pisa. El panel del streamer (que
 * escribe `override`, o `null` para volver a la global) siempre puede.
 */
export function canAssignVoice(currentSource, nextSource) {
  if (nextSource !== VOICE_SOURCES.command) {
    return true;
  }
  return currentSource !== VOICE_SOURCES.override;
}

/**
 * Escribe la voz de un usuario respetando la prioridad. Es el punto de entrada
 * único de las escrituras de voz (lo usan el panel de T-011 y el comando de
 * T-012), para que la regla "el override gana" viva en un solo sitio.
 *
 * @param {object} users  repositorio de usuarios (`getRepositories().users`).
 * @param {string} twitchUserId
 * @param {{ voiceId: string|null, source: string|null }} assignment
 * @returns {{ applied: boolean, reason: string|null, user: object|null }}
 *          `reason` es `'unknown_user'` (no hay fila: hay que `ensure()` antes) o
 *          `'override_wins'` (el streamer ya le fijó una voz).
 */
export function assignUserVoice(users, twitchUserId, { voiceId, source }) {
  const current = users.get(twitchUserId);
  if (current === null) {
    return { applied: false, reason: 'unknown_user', user: null };
  }

  if (!canAssignVoice(current.voiceSource, source)) {
    return { applied: false, reason: 'override_wins', user: current };
  }

  const nextVoiceId = normalizeVoiceId(voiceId);
  const user = users.updatePreferences(twitchUserId, {
    voiceId: nextVoiceId,
    // Sin voz no hay origen que guardar: el `CHECK` del esquema solo admite
    // `override`, `command` o NULL, y NULL es justo "usa la global".
    voiceSource: nextVoiceId === null || !isVoiceSource(source) ? null : source,
  });

  return { applied: true, reason: null, user };
}
