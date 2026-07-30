import { computed, ref } from 'vue';

import { onServerMessage } from '../ws/client.js';

/**
 * Store de la columna de usuarios (T-007).
 *
 * El backend publica la lista completa por `/ws` cada vez que cambia algo
 * (poll de Get Chatters ~60 s, alguien escribe, o un navegador se conecta), así
 * que aquí no se acumula ni se ordena nada: la trama **reemplaza** el estado y
 * ya viene ordenada (activos por actividad reciente, después los presentes).
 *
 * Shape de cada usuario (ver `backend/src/users/presence.js`):
 *
 *     { userId, username, displayName, present, active, muted, ignored,
 *       volume, pitch, timbre, voiceId, voiceSource, firstSeenAt, lastActiveAt, known }
 *
 * - `present` — lo reportó Get Chatters en el último poll (incluye lurkers).
 * - `active`  — ha escrito en esta sesión del backend.
 * - `known`   — tiene fila en `users`; un presente que nunca escribió no la tiene.
 *
 * Las acciones del panel de detalle (T-011) escriben por el backend con
 * `saveUserPreferences()`: **no se adivina nada en el cliente**, se mezcla la fila
 * que devuelve el `PATCH` (`applyStoredPreferences`) para que la UI no espere
 * hasta el siguiente poll, y la trama siguiente —que es la autoridad— trae
 * exactamente esos mismos valores desde SQLite.
 */

/** Tipo de trama que emite el backend con la lista de usuarios. */
export const USERS_LIST_TYPE = 'users:list';

/** Endpoint de las preferencias de un usuario (T-011). */
export const userPreferencesEndpoint = (userId) => `/api/users/${encodeURIComponent(userId)}/preferences`;

/** Claves que el `PATCH` devuelve y que sí se mezclan en la columna. */
const PREFERENCE_KEYS = Object.freeze(['muted', 'ignored', 'volume', 'pitch', 'timbre', 'voiceId', 'voiceSource']);

const users = ref([]);
const updatedAt = ref(null);
const rosterAvailable = ref(false);
const selectedUserId = ref(null);

const bool = (value) => value === true;
const numberOr = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const stringOrNull = (value) => (typeof value === 'string' && value !== '' ? value : null);

function normalizeUser(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const userId = typeof raw.userId === 'string' && raw.userId !== '' ? raw.userId : null;
  if (userId === null) {
    return null;
  }
  const username = typeof raw.username === 'string' && raw.username !== '' ? raw.username : userId;

  return {
    userId,
    username,
    displayName: typeof raw.displayName === 'string' && raw.displayName !== '' ? raw.displayName : username,
    present: bool(raw.present),
    active: bool(raw.active),
    muted: bool(raw.muted),
    ignored: bool(raw.ignored),
    volume: numberOr(raw.volume, 1),
    pitch: numberOr(raw.pitch, 1),
    timbre: numberOr(raw.timbre, 1),
    voiceId: stringOrNull(raw.voiceId),
    voiceSource: stringOrNull(raw.voiceSource),
    firstSeenAt: numberOr(raw.firstSeenAt, null),
    lastActiveAt: numberOr(raw.lastActiveAt, null),
    known: bool(raw.known),
  };
}

/**
 * Aplica una trama `users:list`. Acepta el objeto completo o un array suelto de
 * usuarios (tolerancia de contrato, como hace el store de chat).
 */
export function applyUsersList(payload) {
  const raw = Array.isArray(payload) ? payload : payload?.users;
  if (!Array.isArray(raw)) {
    return;
  }

  users.value = raw.map(normalizeUser).filter((user) => user !== null);
  updatedAt.value = numberOr(payload?.updatedAt, Date.now());
  rosterAvailable.value = Array.isArray(payload) ? true : bool(payload?.rosterAvailable);

  // Si el usuario abierto en el panel desapareció de la lista, se cierra solo.
  if (selectedUserId.value !== null && !users.value.some((user) => user.userId === selectedUserId.value)) {
    selectedUserId.value = null;
  }
}

/**
 * Mezcla en la columna las preferencias que devolvió el backend. Solo toca las
 * claves persistidas: `present`, `active` y el resto del estado de presencia
 * siguen viniendo de la trama, que es su única fuente.
 */
export function applyStoredPreferences(stored) {
  const userId = typeof stored?.userId === 'string' ? stored.userId : null;
  if (userId === null) {
    return;
  }

  users.value = users.value.map((user) => {
    if (user.userId !== userId) {
      return user;
    }
    const merged = { ...user, known: true };
    for (const key of PREFERENCE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(stored, key)) {
        merged[key] = key === 'voiceId' || key === 'voiceSource' ? stringOrNull(stored[key]) : stored[key];
      }
    }
    return merged;
  });
}

/**
 * Guarda preferencias de un usuario (mute, ignorar, volumen, pitch, voz) y aplica
 * la respuesta a la columna. Lanza con un mensaje en español si algo falla, para
 * que el panel lo muestre y revierta su control.
 *
 * @param {string} userId
 * @param {object} patch subconjunto de
 *   `{ muted, ignored, volume, pitch, voiceId, rerollPitch, username, displayName }`.
 */
export async function saveUserPreferences(userId, patch) {
  let response;
  try {
    response = await fetch(userPreferencesEndpoint(userId), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(patch),
    });
  } catch {
    // `fetch` rechaza así cuando no hay backend al otro lado.
    throw new Error('No se pudo contactar al backend.');
  }

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.user) {
    throw new Error(data?.error || `No se pudo guardar (HTTP ${response.status}).`);
  }

  applyStoredPreferences(data.user);
  return data.user;
}

/** Conecta el store al hub. Devuelve la función de baja. */
export function startUsersFeed() {
  return onServerMessage(USERS_LIST_TYPE, applyUsersList);
}

/** Abre el panel de detalle de un usuario. */
export function selectUser(userId) {
  selectedUserId.value = userId;
}

/** Cierra el panel de detalle. */
export function clearSelectedUser() {
  selectedUserId.value = null;
}

/** Vacía la lista (usado al perder la sesión y por las pruebas manuales). */
export function clearUsers() {
  users.value = [];
  updatedAt.value = null;
  rosterAvailable.value = false;
  selectedUserId.value = null;
}

/** Acceso reactivo de solo lectura a la columna de usuarios. */
export function useUsers() {
  return {
    users: computed(() => users.value),
    count: computed(() => users.value.length),
    presentCount: computed(() => users.value.filter((user) => user.present).length),
    activeCount: computed(() => users.value.filter((user) => user.active).length),
    rosterAvailable: computed(() => rosterAvailable.value),
    updatedAt: computed(() => updatedAt.value),
    selectedUser: computed(() => users.value.find((user) => user.userId === selectedUserId.value) ?? null),
  };
}
