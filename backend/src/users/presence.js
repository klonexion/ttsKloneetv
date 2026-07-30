/**
 * Presencia híbrida de la columna de usuarios (T-007).
 *
 * Combina las dos únicas fuentes que hay de "quién está en el chat":
 *
 * 1. **Presentes** — `GET /helix/chat/chatters` cada `TWITCH_CHATTERS_POLL_MS`
 *    (default 60 s). Incluye a los lurkers, que no producen ningún evento.
 * 2. **Activos** — quien escribe. El relay de T-004 ya hace `users.upsert()` con
 *    `last_active_at` por cada mensaje; aquí solo se **lee** eso y se marca al
 *    autor como activo de la sesión para publicar la lista al instante, sin
 *    esperar al siguiente poll (`relay.onMessage`).
 *
 * Un autor recién llegado se ve al instante aunque el roster todavía no lo
 * traiga (`present: false`, `active: true`). En cuanto un roster fresco de Get
 * Chatters SÍ lo confirma presente, queda marcado (`presentSeen`); si un roster
 * posterior ya no lo trae, se **poda** de los activos, así no queda pegado en
 * la columna para siempre solo por haber escrito antes. A quien todavía no fue
 * confirmado (el roster puede tardar un poll en reflejar un mensaje reciente)
 * no se lo poda solo por faltar en un roster puntual — se le da margen hasta
 * confirmarlo.
 *
 * Las preferencias (`muted`, `ignored`, `volume`, `pitch`, `timbre`, voz) salen de SQLite
 * por `users.get()`; un presente que nunca ha escrito no tiene fila todavía y
 * viaja con los defaults y `known: false`.
 *
 * Se publica por el único canal push al frontend:
 *
 *     hub.broadcast('users:list', {
 *       users: [{ userId, username, displayName, present, active, muted,
 *                 ignored, volume, pitch, timbre, voiceId, voiceSource, firstSeenAt,
 *                 lastActiveAt, known }],
 *       presentCount, activeCount, rosterAvailable, rosterFetchedAt, updatedAt,
 *     })
 *
 * La lista viene **ya ordenada** (activos por actividad reciente, después los
 * presentes por nombre), así que el frontend la pinta tal cual.
 *
 * Punto de enganche para T-011 (acciones por usuario): el flag que se escriba en
 * `users` con `updatePreferences()` aparece en la trama siguiente; para
 * publicarlo sin esperar al poll, llamar a `refresh()` de esta instancia después
 * de escribir. Ojo: un lurker con `known: false` no tiene fila, así que hay que
 * hacer `users.upsert()` antes de guardarle una preferencia.
 */
import { getChannel, getValidAccessToken } from '../auth/session.js';
import { config } from '../config.js';
import { getRepositories } from '../db/index.js';
import { logger } from '../logger.js';
import { TwitchApiError } from '../twitch/helix.js';
import { CHATTERS_SCOPE, fetchChatters } from '../twitch/chatters.js';

/** Tipo de trama de la lista de usuarios (el store del frontend espera esto). */
export const USERS_LIST_TYPE = 'users:list';

/** Cuántos autores recientes se recuerdan como "activos de la sesión". */
const MAX_ACTIVE_USERS = 1_000;

/** Ventana para agrupar publicaciones (una ráfaga de mensajes = una trama). */
const COALESCE_MS = 120;

/** Defaults de un presente que todavía no tiene fila en `users`. */
const UNKNOWN_USER_DEFAULTS = Object.freeze({
  muted: false,
  ignored: false,
  volume: 1,
  pitch: 1,
  timbre: 1,
  voiceId: null,
  voiceSource: null,
  firstSeenAt: null,
});

/** Comparador de la columna: actividad reciente primero, luego presentes. */
const byActivityThenName = (a, b) => {
  if (a.active !== b.active) {
    return a.active ? -1 : 1;
  }
  if (a.active && b.active) {
    return (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0);
  }
  if (a.present !== b.present) {
    return a.present ? -1 : 1;
  }
  const activity = (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0);
  if (activity !== 0) {
    return activity;
  }
  return a.username.localeCompare(b.username, 'es');
};

/**
 * @param {object} options
 * @param {{ broadcast: Function, wss?: object }} options.hub  hub de `../ws/hub.js`.
 * @param {object} [options.relay]            relay de chat, para `onMessage`.
 * @param {number} [options.pollIntervalMs]   override del intervalo (pruebas).
 * @param {Function} [options.fetchRoster]    override de Get Chatters (pruebas).
 */
export function createUsersPresence({
  hub,
  relay = null,
  pollIntervalMs = null,
  repositories = getRepositories,
  readChannel = getChannel,
  readAccessToken = getValidAccessToken,
  fetchRoster = fetchChatters,
  coalesceMs = COALESCE_MS,
} = {}) {
  if (!hub || typeof hub.broadcast !== 'function') {
    throw new TypeError('createUsersPresence necesita el hub de WebSocket');
  }

  /** Último roster conocido de Get Chatters: `userId` → identidad. */
  let roster = new Map();
  /** Autores de esta sesión: `userId` → identidad + cuándo escribió. */
  const active = new Map();

  let running = false;
  let timer = null;
  let flushTimer = null;
  let pollInFlight = false;
  let rosterFetchedAt = 0;
  let polls = 0;
  let publications = 0;
  let lastRosterError = null;
  let warnedAboutScope = false;
  let releaseMessages = null;
  let onClientConnected = null;

  /** Une roster + activos y adjunta lo persistido de cada uno. */
  const buildUsers = () => {
    const members = new Map();

    for (const [userId, identity] of roster) {
      members.set(userId, { ...identity, present: true });
    }
    for (const [userId, identity] of active) {
      const existing = members.get(userId);
      if (existing) {
        // La identidad más fresca es la del mensaje (puede haberse renombrado).
        existing.username = identity.username;
        existing.displayName = identity.displayName;
      } else {
        members.set(userId, { userId, username: identity.username, displayName: identity.displayName, present: false });
      }
    }

    const users = repositories().users;

    const list = [...members.values()].map((member) => {
      let stored = null;
      try {
        stored = users.get(member.userId);
      } catch (error) {
        logger.error(`usuarios: no se pudo leer al usuario ${member.userId} (${error.message})`);
      }

      const activeEntry = active.get(member.userId);
      const username = member.username || stored?.username || member.userId;

      return {
        userId: member.userId,
        username,
        displayName: member.displayName || stored?.displayName || username,
        present: member.present,
        active: activeEntry !== undefined,
        muted: stored?.muted ?? UNKNOWN_USER_DEFAULTS.muted,
        ignored: stored?.ignored ?? UNKNOWN_USER_DEFAULTS.ignored,
        volume: stored?.volume ?? UNKNOWN_USER_DEFAULTS.volume,
        pitch: stored?.pitch ?? UNKNOWN_USER_DEFAULTS.pitch,
        timbre: stored?.timbre ?? UNKNOWN_USER_DEFAULTS.timbre,
        voiceId: stored?.voiceId ?? UNKNOWN_USER_DEFAULTS.voiceId,
        voiceSource: stored?.voiceSource ?? UNKNOWN_USER_DEFAULTS.voiceSource,
        firstSeenAt: stored?.firstSeenAt ?? UNKNOWN_USER_DEFAULTS.firstSeenAt,
        lastActiveAt: activeEntry?.at ?? stored?.lastActiveAt ?? null,
        known: stored !== null,
      };
    });

    return list.sort(byActivityThenName);
  };

  /** Trama completa que se publica por el hub. */
  const snapshot = () => {
    const users = buildUsers();
    return {
      users,
      presentCount: users.filter((user) => user.present).length,
      activeCount: users.filter((user) => user.active).length,
      rosterAvailable: rosterFetchedAt > 0,
      rosterFetchedAt: rosterFetchedAt === 0 ? null : rosterFetchedAt,
      updatedAt: Date.now(),
    };
  };

  const publish = () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    publications += 1;
    hub.broadcast(USERS_LIST_TYPE, snapshot());
  };

  /**
   * Publica agrupando: una ráfaga de mensajes (o varios navegadores abriéndose a
   * la vez) produce una sola trama en vez de una por evento.
   */
  const publishSoon = () => {
    if (!running || flushTimer !== null) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = null;
      publish();
    }, Math.max(coalesceMs, 0));
    flushTimer.unref?.();
  };

  const noteMessage = (message) => {
    if (!message?.userId) {
      return;
    }
    // `presentSeen` sobrevive a la reinserción: si ya se confirmó presente en
    // algún roster, que vuelva a escribir no debe borrar esa marca.
    const previous = active.get(message.userId);
    // Reinsertar mueve la entrada al final: así el recorte tira a los más viejos.
    active.delete(message.userId);
    active.set(message.userId, {
      userId: message.userId,
      username: message.username,
      displayName: message.displayName,
      at: Date.parse(message.timestamp) || Date.now(),
      presentSeen: previous?.presentSeen ?? false,
    });
    while (active.size > MAX_ACTIVE_USERS) {
      const oldest = active.keys().next().value;
      active.delete(oldest);
    }
    publishSoon();
  };

  const pollRoster = async () => {
    if (pollInFlight) {
      return;
    }
    pollInFlight = true;

    try {
      const channel = readChannel();
      const accessToken = channel === null ? null : await readAccessToken();

      if (channel === null || accessToken === null) {
        // Sin sesión no hay a quién preguntar; la lista queda con los activos.
        if (roster.size > 0) {
          roster = new Map();
          publish();
        }
        return;
      }

      const { chatters, pages } = await fetchRoster({ accessToken, broadcasterId: channel.id });
      polls += 1;
      rosterFetchedAt = Date.now();
      lastRosterError = null;
      roster = new Map(chatters.map((chatter) => [chatter.userId, chatter]));
      // Un roster fresco es la fuente de verdad de "sigue en el chat", pero solo
      // para quien alguna vez llegó a verse presente (`presentSeen`): Get
      // Chatters puede tardar un poll en reflejar a quien recién escribió, así
      // que un activo que todavía no fue confirmado no se poda solo por no
      // aparecer en este roster puntual — se le da margen hasta que sí se lo vea
      // presente. Una vez confirmado, si en un roster posterior ya no aparece,
      // se fue de verdad y se saca de los activos para que no quede pegado en
      // la columna para siempre.
      for (const [userId, entry] of active) {
        if (roster.has(userId)) {
          entry.presentSeen = true;
        } else if (entry.presentSeen) {
          active.delete(userId);
        }
      }
      logger.info(`usuarios: ${chatters.length} presentes en el chat (${pages} página(s))`);
      publish();
    } catch (error) {
      lastRosterError = error.message;
      // Un fallo no significa que la sala se haya vaciado: se conserva el último
      // roster conocido y se reintenta en el siguiente ciclo.
      if (error instanceof TwitchApiError && error.permanent) {
        if (!warnedAboutScope) {
          warnedAboutScope = true;
          logger.warn(`usuarios: Twitch rechazó Get Chatters (${error.message}); revisa el scope ${CHATTERS_SCOPE}`);
        }
      } else {
        logger.warn(`usuarios: no se pudo consultar los presentes (${error.message})`);
      }
    } finally {
      pollInFlight = false;
    }
  };

  return {
    /** Arranca el poll y las suscripciones. Idempotente. */
    start() {
      if (running) {
        return;
      }
      running = true;

      if (relay && typeof relay.onMessage === 'function') {
        releaseMessages = relay.onMessage(noteMessage);
      }

      // Un navegador que acaba de conectarse no debe esperar hasta un minuto a
      // ver la columna: en cuanto entra al hub se le manda la lista.
      if (hub.wss && typeof hub.wss.on === 'function') {
        onClientConnected = () => publishSoon();
        hub.wss.on('connection', onClientConnected);
      }

      const intervalMs = Math.max(pollIntervalMs ?? config.twitch.chattersPollMs, 100);
      timer = setInterval(() => void pollRoster(), intervalMs);
      timer.unref?.();
      void pollRoster();
    },

    /** Detiene el poll y se da de baja de todo. Idempotente. */
    stop() {
      running = false;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (releaseMessages !== null) {
        releaseMessages();
        releaseMessages = null;
      }
      if (onClientConnected !== null && hub.wss && typeof hub.wss.off === 'function') {
        hub.wss.off('connection', onClientConnected);
      }
      onClientConnected = null;
    },

    /** Consulta Get Chatters ya (lo usan las pruebas y, en T-011, las acciones). */
    refreshRoster: () => pollRoster(),

    /** Publica la lista con lo que ya se sabe, sin llamar a Twitch. */
    refresh: () => publish(),

    /** Trama actual sin publicarla (diagnóstico y pruebas). */
    getSnapshot: () => snapshot(),

    /** Estado para diagnóstico. */
    getStatus: () => ({
      running,
      polls,
      publications,
      presentCount: roster.size,
      activeCount: active.size,
      rosterFetchedAt: rosterFetchedAt === 0 ? null : rosterFetchedAt,
      lastRosterError,
    }),
  };
}
