/**
 * Formateo de presentación de la columna de usuarios (T-007).
 *
 * Los timestamps de la trama (`lastActiveAt`, `firstSeenAt`) son ms epoch UTC
 * (convención de la capa de datos, T-002); aquí se muestran en la zona local.
 */

/** Iconos de los flags persistidos; T-011 reutiliza estos mismos. */
export const USER_FLAG_ICONS = Object.freeze({
  muted: 'mdi-volume-off',
  ignored: 'mdi-account-cancel-outline',
});

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const dateTimeFormatter = new Intl.DateTimeFormat('es-MX', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Fecha y hora local completas, o cadena vacía si no hay dato. */
export function formatDateTime(epochMs) {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs) || epochMs <= 0) {
    return '';
  }
  return dateTimeFormatter.format(new Date(epochMs));
}

/**
 * Antigüedad en lenguaje corto: "ahora", "hace 5 min", "hace 3 h", "hace 2 d".
 * Cadena vacía si no hay dato (un lurker que nunca escribió).
 */
export function formatRelativeTime(epochMs, now = Date.now()) {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs) || epochMs <= 0) {
    return '';
  }

  const elapsed = Math.max(now - epochMs, 0);
  if (elapsed < MINUTE_MS) {
    return 'ahora';
  }
  if (elapsed < HOUR_MS) {
    return `hace ${Math.floor(elapsed / MINUTE_MS)} min`;
  }
  if (elapsed < DAY_MS) {
    return `hace ${Math.floor(elapsed / HOUR_MS)} h`;
  }
  return `hace ${Math.floor(elapsed / DAY_MS)} d`;
}

/** Texto del estado de un usuario en la columna. */
export function describeUserActivity(user, now = Date.now()) {
  if (user.active) {
    const relative = formatRelativeTime(user.lastActiveAt, now);
    return relative === '' ? 'escribió en esta sesión' : `escribió ${relative}`;
  }
  if (user.present) {
    return 'presente, sin escribir';
  }
  return 'fuera del chat';
}

/** Nombre legible del origen de la voz asignada (modelo de voz de T-011). */
export function describeVoiceSource(voiceSource) {
  if (voiceSource === 'override') {
    return 'asignada por ti';
  }
  if (voiceSource === 'command') {
    return 'elegida con !cambia-mi-voz';
  }
  return 'voz global';
}
