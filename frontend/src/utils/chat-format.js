/**
 * Formateo de presentación del chat (T-005): color estable por usuario y hora
 * local del mensaje.
 */

/** Saturación/luminosidad fijas: legibles sobre el fondo oscuro de Vuetify. */
const COLOR_SATURATION = 72;
const COLOR_LIGHTNESS = 68;

/** Hash determinista (djb2) para que un usuario conserve su color entre sesiones. */
function hashString(value) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

/**
 * Ángulo dorado: reparte los tonos al máximo. Sin él, los ids de Twitch (que
 * suelen ser consecutivos) caen en tonos casi idénticos y todos los nombres se
 * ven del mismo color.
 */
const GOLDEN_ANGLE_DEG = 137.508;

/** Color estable del nombre de un usuario, derivado de su id (o su username). */
export function userColor(seed) {
  const hue = Math.round((hashString(String(seed ?? '')) * GOLDEN_ANGLE_DEG) % 360);
  return `hsl(${hue} ${COLOR_SATURATION}% ${COLOR_LIGHTNESS}%)`;
}

const timeFormatter = new Intl.DateTimeFormat('es-MX', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Hora local `HH:MM` de un timestamp ISO; cadena vacía si no es parseable. */
export function formatMessageTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return timeFormatter.format(date);
}
