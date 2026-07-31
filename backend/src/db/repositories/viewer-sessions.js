/**
 * Repositorio de `viewer_sessions`: la identidad de un viewer que inició sesión
 * con Twitch para probar quién es (flujo separado del bot, ver
 * `../../auth/viewer-session.js`). Solo guarda identidad y expiración — nunca un
 * access/refresh token de Twitch.
 */
import crypto from 'node:crypto';

/** Bytes de aleatoriedad del id de sesión (48 hex chars, no adivinable). */
const SESSION_ID_BYTES = 24;

const toSession = (row) =>
  row && {
    sessionId: row.session_id,
    twitchUserId: row.twitch_user_id,
    username: row.username,
    displayName: row.display_name,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };

export function createViewerSessionsRepository(db) {
  const insert = db.prepare(`
    INSERT INTO viewer_sessions (session_id, twitch_user_id, username, display_name, created_at, expires_at)
    VALUES (@sessionId, @twitchUserId, @username, @displayName, @createdAt, @expiresAt)
  `);
  const selectOne = db.prepare('SELECT * FROM viewer_sessions WHERE session_id = ?');
  const remove = db.prepare('DELETE FROM viewer_sessions WHERE session_id = ?');
  const removeExpired = db.prepare('DELETE FROM viewer_sessions WHERE expires_at <= ?');

  return {
    /** Crea la sesión con un id nuevo y devuelve la fila creada. */
    create({ twitchUserId, username, displayName, ttlMs, now = Date.now() }) {
      const sessionId = crypto.randomBytes(SESSION_ID_BYTES).toString('hex');
      insert.run({ sessionId, twitchUserId, username, displayName, createdAt: now, expiresAt: now + ttlMs });
      return toSession(selectOne.get(sessionId));
    },

    /** La sesión, o `null` si no existe o ya expiró (y de paso la borra). */
    get(sessionId, { now = Date.now() } = {}) {
      const row = selectOne.get(sessionId);
      if (!row) {
        return null;
      }
      if (row.expires_at <= now) {
        remove.run(sessionId);
        return null;
      }
      return toSession(row);
    },

    /** `true` si había una sesión con ese id y se borró. */
    delete(sessionId) {
      return remove.run(sessionId).changes > 0;
    },

    /** Limpieza de sesiones vencidas; devuelve cuántas borró. */
    deleteExpired(now = Date.now()) {
      return removeExpired.run(now).changes;
    },
  };
}
