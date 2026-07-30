/**
 * Filtros del pipeline TTS (T-008): funciones puras que deciden si un mensaje se
 * lee y cómo suena su texto. Sin acceso a la base ni al hub, para que se puedan
 * razonar y probar de una en una (`npm --prefix backend run test:tts`).
 *
 * Reglas, en el orden en que las aplica `./pipeline.js`:
 *
 * 1. Usuario `ignored`  → el mensaje **no se muestra** en el chat ni se lee.
 * 2. Usuario `muted`    → **sí se muestra**, no se lee. (Esta asimetría es
 *                        explícita en el plan: son dos cosas distintas.)
 * 3. Comando (`!...`)   → se muestra, no se lee. T-012 (`!cambia-mi-voz`) sigue
 *                        viendo el mensaje: los comandos se procesan en el
 *                        backend con `relay.onMessage()`, que no depende de esto.
 * 4. Bot conocido       → se muestra, no se lee.
 * 5. URLs               → se leen como la palabra "enlace" (el mensaje **sí** se
 *                        lee; solo cambia el texto que va al motor).
 */

/** Por qué un mensaje no se lee. `null` en la decisión = sí se lee. */
export const TTS_SKIP_REASONS = Object.freeze({
  /** Usuario con `ignored = 1`: tampoco se muestra en el chat. */
  ignored: 'ignored',
  /** Usuario con `muted = 1`: se muestra pero no se lee. */
  muted: 'muted',
  /** El texto empieza por `!`. */
  command: 'command',
  /** El autor está en la lista de bots conocidos. */
  bot: 'bot',
  /** No queda nada legible después de los filtros de texto. */
  empty: 'empty',
});

/**
 * Bots de chat cuyos mensajes no se leen. Se comparan en minúsculas contra el
 * `username` (el login de Twitch, estable), no contra el `displayName`.
 *
 * El plan nombra Nightbot y StreamElements; el resto son los otros habituales en
 * canales de habla hispana. Es una lista cerrada a propósito: un heurístico tipo
 * "acaba en bot" silenciaría a usuarios reales.
 */
export const KNOWN_BOT_USERNAMES = Object.freeze([
  'nightbot',
  'streamelements',
  'streamlabs',
  'moobot',
  'fossabot',
  'wizebot',
  'sery_bot',
  'soundalerts',
  'own3d',
  'botisimo',
  'phantombot',
  'streamcaptainbot',
]);

const BOT_USERNAME_SET = new Set(KNOWN_BOT_USERNAMES);

/** Prefijo que marca un comando de chat. */
export const COMMAND_PREFIX = '!';

/** Palabra con la que se lee cualquier URL. */
export const URL_SPOKEN_AS = 'enlace';

/**
 * TLDs que se aceptan en un dominio **sin ruta** (`twitch.tv`). Son los que no
 * aparecen como fragmento de prosa en español detrás de un punto.
 */
const SAFE_BARE_TLDS = 'com|net|org|tv|gg|io|dev|app|xyz|info|live|stream|shop|store|edu|gob|gov';

/**
 * TLDs que solo cuentan como dominio si van **con ruta** (`youtu.be/abc`). Sin
 * esa exigencia, prosa normal con un punto sin espacio ("no me gusta.me da
 * igual", "vale.es lo que hay") se leería como "enlace".
 */
const PATH_ONLY_TLDS = 'es|mx|ar|cl|co|pe|me|ly|be|to|it|de|fr|uk|art|link';

const DOMAIN_HEAD = '[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9-]+)*';

/**
 * URLs a reemplazar. Cuatro formas: con esquema (`https://…`, `ftp://…`),
 * empezando por `www.`, dominio desnudo con TLD "seguro", y dominio con TLD
 * ambiguo pero seguido de ruta.
 */
const URL_PATTERN = new RegExp(
  [
    '(?:https?|ftp):\\/\\/\\S+',
    'www\\.\\S+',
    `\\b${DOMAIN_HEAD}\\.(?:${SAFE_BARE_TLDS})\\b(?:\\/\\S*)?`,
    `\\b${DOMAIN_HEAD}\\.(?:${PATH_ONLY_TLDS})\\/\\S*`,
  ].join('|'),
  'gi',
);

/** `true` si el texto es un comando de chat (`!algo`, ignorando espacios). */
export function isCommand(text) {
  return typeof text === 'string' && text.trimStart().startsWith(COMMAND_PREFIX);
}

/** `true` si el autor es un bot conocido. */
export function isKnownBot(username) {
  return typeof username === 'string' && BOT_USERNAME_SET.has(username.trim().toLowerCase());
}

/**
 * Reemplaza cada URL del texto por la palabra "enlace" y normaliza los espacios
 * sobrantes. El resto del texto no se toca (se lee tal cual, sin "usuario dice").
 */
export function replaceUrls(text, replacement = URL_SPOKEN_AS) {
  if (typeof text !== 'string' || text === '') {
    return '';
  }
  return text.replace(URL_PATTERN, replacement).replace(/\s+/g, ' ').trim();
}

/** `true` si el texto contiene al menos una URL. */
export function hasUrl(text) {
  if (typeof text !== 'string' || text === '') {
    return false;
  }
  // `URL_PATTERN` es global: hay que reiniciar el cursor antes de cada `test()`.
  URL_PATTERN.lastIndex = 0;
  return URL_PATTERN.test(text);
}

/**
 * Texto que se le pasa al motor: solo el contenido del mensaje, con las URLs
 * sustituidas. Devuelve `''` si no queda nada que leer.
 */
export const toSpokenText = (text) => replaceUrls(text);

/**
 * Motivo por el que este mensaje no se lee, o `null` si se lee.
 *
 * @param {{ username?: string, text?: string }} message mensaje normalizado.
 * @param {{ muted?: boolean, ignored?: boolean } | null} user fila de `users`.
 */
export function findSkipReason(message, user = null) {
  if (user?.ignored) {
    return TTS_SKIP_REASONS.ignored;
  }
  if (user?.muted) {
    return TTS_SKIP_REASONS.muted;
  }
  if (isCommand(message?.text)) {
    return TTS_SKIP_REASONS.command;
  }
  if (isKnownBot(message?.username)) {
    return TTS_SKIP_REASONS.bot;
  }
  if (toSpokenText(message?.text) === '') {
    return TTS_SKIP_REASONS.empty;
  }
  return null;
}
