/**
 * Escritura de las preferencias por usuario (T-011): lo que el panel del usuario
 * del frontend guarda cuando el streamer mutea, ignora, mueve el volumen, el
 * pitch o el timbre, o le asigna una voz.
 *
 * Vive separado de `./router.js` para poder probarse sin HTTP (lo hace
 * `scripts/smoke-voice-model.js`). El router solo traduce a códigos de estado.
 *
 * Tres reglas que conviene no perder:
 *
 * 1. **Asignar voz desde aquí es un `override`.** Este camino es el panel del
 *    streamer, así que la voz que se guarde entra en el nivel 1 de la prioridad
 *    (`../tts/voice-model.js`); `voiceId: null` la quita y devuelve al usuario a
 *    la voz global. El origen **no se acepta desde el cliente**: lo decide el
 *    servidor (T-012 escribe `command` en proceso, no por esta ruta).
 * 2. **Un lurker no tiene fila.** La columna de usuarios (T-007) reporta a los
 *    presentes aunque no hayan escrito (`known: false`), así que antes de guardar
 *    hay que crear la fila con `users.ensure()` — que además le reparte su pitch
 *    y timbre aleatorios persistentes sin marcarlo como activo.
 * 3. **`users.pitch`, `users.timbre` y `users.volume` son `NOT NULL`** en el
 *    esquema: `null` en esos campos no es "sin valor", es un error de validación.
 */
import { getRepositories } from '../db/index.js';
import { VOICE_SOURCES, normalizeVoiceId, randomUserPitch, randomUserTimbre } from '../tts/voice-model.js';

/**
 * Rangos que acepta la API. El pitch usa el rango de Web Speech (T-008); el
 * timbre comparte el mismo rango 0–2 por consistencia (1 = neutro, igual que
 * el pitch), aunque cada motor lo traduzca a algo distinto (ver
 * `<motor>TimbreFactor()` en cada `*-engine.js`).
 */
export const PREFERENCE_LIMITS = Object.freeze({
  volumeMin: 0,
  volumeMax: 1,
  pitchMin: 0,
  pitchMax: 2,
  timbreMin: 0,
  timbreMax: 2,
  voiceIdMaxLength: 200,
  nameMaxLength: 100,
  userIdMaxLength: 64,
});

/** Preferencias que el cliente puede mandar. */
const BOOLEAN_KEYS = Object.freeze(['muted', 'ignored']);
const NUMBER_KEYS = Object.freeze(['volume', 'pitch', 'timbre']);
/** Identidad: solo se usa si hay que **crear** la fila del usuario. */
const IDENTITY_KEYS = Object.freeze(['username', 'displayName']);
/** Acciones que no son un valor: piden al servidor que ruede un pitch/timbre nuevo. */
const ACTION_KEYS = Object.freeze(['rerollPitch', 'rerollTimbre']);

const ACCEPTED_KEYS = Object.freeze([...BOOLEAN_KEYS, ...NUMBER_KEYS, 'voiceId', ...IDENTITY_KEYS, ...ACTION_KEYS]);

/** `true` si el id de usuario tiene una forma admisible (ids de Twitch: dígitos). */
export const isUserId = (value) =>
  typeof value === 'string' && value !== '' && value.length <= PREFERENCE_LIMITS.userIdMaxLength && /^[\w-]+$/.test(value);

/** Fallo de validación: el router lo traduce a un 400 con `code`. */
export class UserPreferencesError extends Error {
  constructor(message, { code = 'invalid', status = 400 } = {}) {
    super(message);
    this.name = 'UserPreferencesError';
    this.code = code;
    this.status = status;
  }
}

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

const assertName = (value, key) => {
  if (typeof value !== 'string' || value.trim() === '' || value.length > PREFERENCE_LIMITS.nameMaxLength) {
    throw new UserPreferencesError(`«${key}» debe ser un nombre no vacío.`);
  }
  return value.trim();
};

/**
 * Valida el cuerpo de la petición y lo separa en lo que se escribe (`patch`), la
 * identidad para crear la fila si hace falta y las acciones pedidas.
 *
 * @param {unknown} body
 * @returns {{ patch: object, identity: object, rerollPitch: boolean, rerollTimbre: boolean }}
 */
export function parsePreferencesPatch(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new UserPreferencesError('El cuerpo debe ser un objeto con las preferencias a guardar.');
  }

  const unknown = Object.keys(body).filter((key) => !ACCEPTED_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new UserPreferencesError(`Preferencia desconocida: ${unknown.join(', ')}.`, { code: 'unknown_key' });
  }

  const patch = {};
  const identity = {};

  for (const key of BOOLEAN_KEYS) {
    if (!has(body, key)) {
      continue;
    }
    if (typeof body[key] !== 'boolean') {
      throw new UserPreferencesError(`«${key}» debe ser true o false.`);
    }
    patch[key] = body[key];
  }

  for (const key of NUMBER_KEYS) {
    if (!has(body, key)) {
      continue;
    }
    const value = body[key];
    const min = PREFERENCE_LIMITS[`${key}Min`];
    const max = PREFERENCE_LIMITS[`${key}Max`];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      // `null` incluido a propósito: las columnas son NOT NULL (T-002).
      throw new UserPreferencesError(`«${key}» debe ser un número entre ${min} y ${max}.`);
    }
    if (value < min || value > max) {
      throw new UserPreferencesError(`«${key}» está fuera del rango ${min}–${max}.`, { code: 'out_of_range' });
    }
    // Los pasos del slider producen ruido de coma flotante (0.05 * 18 =
    // 0.8999999999999999): se redondea para no guardar eso en SQLite ni
    // devolverlo en la respuesta. Tres decimales sobran para voz y volumen.
    patch[key] = Number(value.toFixed(3));
  }

  if (has(body, 'voiceId')) {
    const value = body.voiceId;
    if (value !== null && typeof value !== 'string') {
      throw new UserPreferencesError('«voiceId» debe ser un id de voz o null para usar la voz global.');
    }
    if (typeof value === 'string' && value.length > PREFERENCE_LIMITS.voiceIdMaxLength) {
      throw new UserPreferencesError('«voiceId» es demasiado largo.');
    }
    // No se valida contra el catálogo a propósito: el registro de motores ya cae
    // al navegador si la voz no existe (garantía de T-008), y así guardar una
    // preferencia nunca depende de que `GET /api/voices` esté disponible.
    patch.voiceId = normalizeVoiceId(value);
    patch.voiceSource = patch.voiceId === null ? null : VOICE_SOURCES.override;
  }

  for (const key of IDENTITY_KEYS) {
    if (has(body, key)) {
      identity[key] = assertName(body[key], key);
    }
  }

  let rerollPitch = false;
  if (has(body, 'rerollPitch')) {
    if (body.rerollPitch !== true) {
      throw new UserPreferencesError('«rerollPitch» solo admite true.');
    }
    if (has(patch, 'pitch')) {
      throw new UserPreferencesError('«pitch» y «rerollPitch» no se pueden mandar juntos.');
    }
    rerollPitch = true;
  }

  let rerollTimbre = false;
  if (has(body, 'rerollTimbre')) {
    if (body.rerollTimbre !== true) {
      throw new UserPreferencesError('«rerollTimbre» solo admite true.');
    }
    if (has(patch, 'timbre')) {
      throw new UserPreferencesError('«timbre» y «rerollTimbre» no se pueden mandar juntos.');
    }
    rerollTimbre = true;
  }

  if (Object.keys(patch).length === 0 && !rerollPitch && !rerollTimbre) {
    throw new UserPreferencesError('No se mandó ninguna preferencia que guardar.', { code: 'empty' });
  }

  return { patch, identity, rerollPitch, rerollTimbre };
}

/** Forma en la que viajan las preferencias al frontend (igual que `users:list`). */
export function toUserPreferences(user) {
  return {
    userId: user.twitchUserId,
    username: user.username,
    displayName: user.displayName,
    muted: user.muted,
    ignored: user.ignored,
    volume: user.volume,
    pitch: user.pitch,
    timbre: user.timbre,
    voiceId: user.voiceId,
    voiceSource: user.voiceSource,
    firstSeenAt: user.firstSeenAt,
    lastActiveAt: user.lastActiveAt,
  };
}

/**
 * Guarda las preferencias de un usuario y devuelve la fila resultante ya
 * normalizada. Crea la fila si el usuario todavía no había escrito.
 *
 * @param {object} options
 * @param {string} options.userId       `twitch_user_id`.
 * @param {unknown} options.body        cuerpo de la petición.
 * @param {Function} [options.repositories] getter de repositorios (inyectable).
 * @param {() => number} [options.random]  fuente del pitch aleatorio (pruebas).
 */
export function applyUserPreferences({ userId, body, repositories = getRepositories, random = Math.random }) {
  if (!isUserId(userId)) {
    throw new UserPreferencesError('El id de usuario no es válido.', { code: 'invalid_user' });
  }

  const { patch, identity, rerollPitch, rerollTimbre } = parsePreferencesPatch(body);
  const users = repositories().users;

  // Un presente que nunca escribió no tiene fila (T-007, `known: false`): se crea
  // ya con su pitch y timbre aleatorios y sin marcarlo como activo.
  let user = users.get(userId);
  if (user === null) {
    user = users.ensure({
      twitchUserId: userId,
      username: identity.username ?? userId,
      displayName: identity.displayName ?? identity.username ?? userId,
      pitch: randomUserPitch(random),
      timbre: randomUserTimbre(random),
    });
  }

  const finalPatch = { ...patch };
  if (rerollPitch) {
    finalPatch.pitch = randomUserPitch(random);
  }
  if (rerollTimbre) {
    finalPatch.timbre = randomUserTimbre(random);
  }
  const updated = users.updatePreferences(userId, finalPatch);

  return toUserPreferences(updated ?? user);
}
