import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

/** Raíz del paquete backend (`backend/`), resuelta sin rutas hardcodeadas. */
export const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Raíz del repositorio, un nivel por encima de `backend/`. */
export const repoRoot = path.resolve(backendRoot, '..');

// La configuración canónica vive en el `.env` de la RAÍZ del repo: un solo
// archivo para backend y frontend (`vite.config.js` lee el mismo). `backend/.env`
// se sigue leyendo como override local opcional, por compatibilidad.
//
// Orden importante: dotenv nunca pisa una variable ya definida, así que el
// primero cargado gana. La raíz va primero porque es la fuente canónica —la que
// documenta `.env.example`—, y `backend/.env` solo rellena lo que la raíz no
// defina. Lo que venga del entorno del proceso gana sobre ambos.
dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true });
dotenv.config({ path: path.join(backendRoot, '.env'), quiet: true });

/** Lee una variable de entorno tratando el string vacío como ausente. */
const envValue = (name) => {
  const raw = process.env[name];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
};

/** Quita las barras finales de una URL base para poder concatenarle rutas. */
const trimTrailingSlashes = (url) => url.replace(/\/+$/, '');

/**
 * Archivo SQLite. `DB_FILE` permite apuntar a otra base sin tocar la de la app
 * (lo usan las pruebas de humo, que trabajan sobre una base temporal).
 */
const dbFileOverride = envValue('DB_FILE');
const sqliteFile = dbFileOverride ? path.resolve(dbFileOverride) : path.join(backendRoot, 'data', 'app.sqlite');

/**
 * Defaults de Twitch. Los endpoints son los reales de producción; se pueden
 * apuntar a otro host (`TWITCH_AUTH_BASE_URL` / `TWITCH_API_BASE_URL`) para
 * ejercitar el flujo OAuth completo contra el imitador de
 * `scripts/fake-twitch.js` sin necesitar credenciales reales.
 */
export const TWITCH_DEFAULTS = Object.freeze({
  authBaseUrl: 'https://id.twitch.tv',
  apiBaseUrl: 'https://api.twitch.tv',
  /** WebSocket de EventSub: por ahí llega el chat (`channel.chat.message`). */
  eventSubWsUrl: 'wss://eventsub.wss.twitch.tv/ws',
  redirectUri: 'http://localhost:3000/auth/callback',
  scopes: Object.freeze(['user:read:chat', 'user:write:chat', 'moderator:read:chatters']),
  /** Cada cuánto se revisa si el access token está por expirar. */
  tokenCheckIntervalMs: 60_000,
  /** Margen previo a la expiración con el que se refresca por adelantado. */
  refreshMarginMs: 300_000,
  /**
   * Keepalive que se le pide a EventSub (Twitch admite 10–600 s). Si pasa ese
   * tiempo más un margen sin recibir nada, el provider da la conexión por muerta.
   */
  eventSubKeepaliveSeconds: 30,
  /** Cada cuánto revisa el relay de chat si ya hay (o dejó de haber) sesión. */
  chatSessionPollMs: 5_000,
  /** Cada cuánto se consulta Get Chatters para saber quién está presente. */
  chattersPollMs: 60_000,
});

/**
 * Defaults del TTS de servidor (T-009). El motor edge-tts es un servicio online,
 * así que se puede desactivar por completo (`TTS_EDGE_ENABLED=false`) para
 * trabajar sin red: entonces no se registra y la voz global `edge:*` se lee con el
 * motor del navegador, como antes de T-009.
 */
export const TTS_DEFAULTS = Object.freeze({
  edgeEnabled: true,
  /** Tope por llamada a edge-tts (síntesis o catálogo) antes de darla por fallida. */
  edgeTimeoutMs: 8_000,
  /** Idiomas del catálogo de voces de edge (`*` = todos los que ofrece). */
  edgeVoiceLanguages: Object.freeze(['es']),
});

/**
 * Defaults del login de viewers (identidad, no la sesión del bot). Ver
 * `src/auth/viewer-session.js`. `sessionTtlMs` es cuánto dura logueado antes
 * de tener que volver a pasar por Twitch.
 */
export const VIEWER_AUTH_DEFAULTS = Object.freeze({
  sessionTtlMs: 30 * 60 * 1000,
});

/** Lee un booleano de entorno (`false`, `0` y `no` son falso). */
const envFlag = (name, fallback) => {
  const raw = envValue(name);
  if (raw === null) {
    return fallback;
  }
  return !['false', '0', 'no'].includes(raw.toLowerCase());
};

/**
 * TLS. Twitch exige `https` en los redirect URI, así que la app puede servirse
 * sobre HTTPS con un certificado local (`mkcert`, ver README). Es **opt-in**:
 * con `HTTPS=false` (el default) todo sigue en HTTP plano, que es lo que usan
 * las pruebas de humo — así ningún gate depende de tener certificados.
 *
 * Al activarlo cambian solos el esquema del servidor, el `redirect_uri` que se
 * le manda a Twitch y la URL del frontend, para no tener que sincronizar tres
 * variables a mano.
 */
const httpsEnabled = envFlag('HTTPS', false);
const scheme = httpsEnabled ? 'https' : 'http';
const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const frontendPort = process.env.FRONTEND_PORT ?? '5173';

/**
 * Variables de entorno sin las que el backend no puede funcionar. `PORT` y
 * `TWITCH_REDIRECT_URI` no están aquí porque tienen default razonable.
 */
export const REQUIRED_ENV_VARS = ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET'];

/** Configuración de la app. Los secretos viven solo en el `.env` de la raíz. */
export const config = {
  backendRoot,
  port,
  wsPath: '/ws',
  /** `http` o `https`, según la bandera `HTTPS`. */
  scheme,
  /**
   * TLS para servir sobre HTTPS. Las rutas por default apuntan a `certs/` en la
   * raíz (git-ignorada), que es donde las deja el `mkcert` del README.
   */
  https: {
    enabled: httpsEnabled,
    certFile: envValue('TLS_CERT_FILE') ?? path.join(repoRoot, 'certs', 'localhost.pem'),
    keyFile: envValue('TLS_KEY_FILE') ?? path.join(repoRoot, 'certs', 'localhost-key.pem'),
  },
  /** Origen del frontend, al que vuelve el navegador después del callback. */
  frontendUrl: trimTrailingSlashes(envValue('FRONTEND_URL') ?? `${scheme}://localhost:${frontendPort}`),
  db: {
    directory: path.dirname(sqliteFile),
    file: sqliteFile,
  },
  twitch: {
    clientId: process.env.TWITCH_CLIENT_ID ?? '',
    clientSecret: process.env.TWITCH_CLIENT_SECRET ?? '',
    // Con HTTPS activo el default pasa a `https://localhost:<port>/auth/callback`
    // (Twitch ya no acepta `http` en los redirect URI). `TWITCH_DEFAULTS.redirectUri`
    // se mantiene como el default de HTTP plano.
    redirectUri:
      envValue('TWITCH_REDIRECT_URI') ??
      (httpsEnabled ? `${scheme}://localhost:${port}/auth/callback` : TWITCH_DEFAULTS.redirectUri),
    scopes: [...TWITCH_DEFAULTS.scopes],
    authBaseUrl: trimTrailingSlashes(envValue('TWITCH_AUTH_BASE_URL') ?? TWITCH_DEFAULTS.authBaseUrl),
    apiBaseUrl: trimTrailingSlashes(envValue('TWITCH_API_BASE_URL') ?? TWITCH_DEFAULTS.apiBaseUrl),
    // La URL del WebSocket de EventSub se usa tal cual (la ruta forma parte de
    // ella), así que aquí no se recortan barras.
    eventSubWsUrl: envValue('TWITCH_EVENTSUB_WS_URL') ?? TWITCH_DEFAULTS.eventSubWsUrl,
    eventSubKeepaliveSeconds: Number.parseInt(
      process.env.TWITCH_EVENTSUB_KEEPALIVE_SECONDS ?? String(TWITCH_DEFAULTS.eventSubKeepaliveSeconds),
      10,
    ),
    chatSessionPollMs: Number.parseInt(
      process.env.TWITCH_CHAT_SESSION_POLL_MS ?? String(TWITCH_DEFAULTS.chatSessionPollMs),
      10,
    ),
    chattersPollMs: Number.parseInt(
      process.env.TWITCH_CHATTERS_POLL_MS ?? String(TWITCH_DEFAULTS.chattersPollMs),
      10,
    ),
    tokenCheckIntervalMs: Number.parseInt(
      process.env.TWITCH_TOKEN_CHECK_INTERVAL_MS ?? String(TWITCH_DEFAULTS.tokenCheckIntervalMs),
      10,
    ),
    refreshMarginMs: TWITCH_DEFAULTS.refreshMarginMs,
  },
  /**
   * Login de viewers (T-014): flujo de identidad separado del bot, para que un
   * espectador pruebe "soy yo" (p. ej. antes de configurar su voz) sin que eso
   * toque ni pueda pisar la sesión de `twitch.*` de arriba — esa es del bot, esta
   * es de cada viewer, y ni siquiera comparten tabla (`viewer_sessions` vs
   * `tokens`).
   *
   * **Opt-in**: sin `TWITCH_VIEWER_REDIRECT_URI` el flujo queda deshabilitado
   * (`viewerAuth.enabled === false`) y `/viewer-auth/*` responde 404 en vez de
   * usar por accidente el redirect URI del bot, que es una ruta distinta
   * (`/auth/callback`) y rompería el intercambio de code.
   *
   * Reusa el mismo `client_id`/`client_secret` que `twitch.*` — en la consola de
   * dev.twitch.tv de tu app hay que agregar esta URL como un segundo "OAuth
   * Redirect URL", no reemplazar la del bot. Sin scopes: el único uso es leer
   * `GET /helix/users` con el token del propio viewer para saber quién es: no
   * hace falta (ni se pide) permiso para leer/escribir chat ni moderar.
   */
  viewerAuth: {
    enabled: envValue('TWITCH_VIEWER_REDIRECT_URI') !== null,
    redirectUri: envValue('TWITCH_VIEWER_REDIRECT_URI'),
    scopes: [],
    sessionTtlMs: Number.parseInt(
      process.env.TWITCH_VIEWER_SESSION_TTL_MS ?? String(VIEWER_AUTH_DEFAULTS.sessionTtlMs),
      10,
    ),
  },
  /**
   * El proceso nuevo y separado de `viewer-auth` (T-015): sirve la pantalla de
   * "!configura-mi-voz" en su propio puerto, para que el backend admin de
   * arriba nunca necesite estar expuesto a internet. `publicUrl` es lo que el
   * bot postea en el chat (`!configura-mi-voz`, `backend/src/chat/commands.js`)
   * y por default es el propio localhost — en producción se pisa con la URL
   * pública real (DDNS + certificado, ver `docs/exec-plans/active/configura-mi-voz.md`).
   */
  viewerService: {
    port: Number.parseInt(process.env.VIEWER_SERVICE_PORT ?? '3100', 10),
    publicUrl: trimTrailingSlashes(
      envValue('VIEWER_SERVICE_PUBLIC_URL') ?? `http://localhost:${process.env.VIEWER_SERVICE_PORT ?? '3100'}`,
    ),
    /**
     * HTTPS del servicio de viewer (T-016): certificado real (Let's Encrypt vía
     * win-acme) para el hostname público de DuckDNS, **distinto** del
     * certificado local de `https.*` de arriba (ese es de `mkcert` para
     * `localhost`, no sirve para un hostname público). Opt-in con
     * `VIEWER_HTTPS=true`, igual criterio que `HTTPS` para el backend admin.
     */
    https: {
      enabled: envFlag('VIEWER_HTTPS', false),
      certFile: envValue('VIEWER_TLS_CERT_FILE') ?? path.join(repoRoot, 'certs', 'duckdns', 'fullchain.pem'),
      keyFile: envValue('VIEWER_TLS_KEY_FILE') ?? path.join(repoRoot, 'certs', 'duckdns', 'privkey.pem'),
    },
  },
  tts: {
    edgeEnabled: envFlag('TTS_EDGE_ENABLED', TTS_DEFAULTS.edgeEnabled),
    edgeTimeoutMs: Number.parseInt(process.env.TTS_EDGE_TIMEOUT_MS ?? String(TTS_DEFAULTS.edgeTimeoutMs), 10),
    /** Proxy HTTP para salir a internet (redes corporativas). `null` = directo. */
    edgeProxy: envValue('TTS_EDGE_PROXY'),
    edgeVoiceLanguages: (envValue('TTS_EDGE_VOICE_LANGS') ?? TTS_DEFAULTS.edgeVoiceLanguages.join(','))
      .split(',')
      .map((language) => language.trim())
      .filter((language) => language !== ''),
  },
};

/** Error de configuración; expone los nombres de las variables que faltan. */
export class MissingConfigError extends Error {
  constructor(missing) {
    super(
      `Falta configuración requerida en .env: ${missing.join(', ')}. ` +
        'Copia .env.example a .env en la raíz del repo y rellena esos valores.',
    );
    this.name = 'MissingConfigError';
    this.missing = missing;
  }
}

/**
 * Devuelve las variables requeridas que faltan o están vacías. Se le puede
 * pasar un objeto de entorno distinto (lo usan las pruebas de humo).
 */
export function findMissingEnvVars(env = process.env) {
  return REQUIRED_ENV_VARS.filter((name) => String(env[name] ?? '').trim() === '');
}

/**
 * Lanza `MissingConfigError` si falta alguna variable requerida. El entrypoint
 * la llama antes de levantar el servidor y termina el proceso con el mensaje.
 */
export function assertConfig(env = process.env) {
  const missing = findMissingEnvVars(env);
  if (missing.length > 0) {
    throw new MissingConfigError(missing);
  }
}
