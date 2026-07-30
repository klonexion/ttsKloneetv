/**
 * Repositorio de la tabla `users`: preferencias locales por usuario de chat
 * (mute de TTS, volumen, ignorar, voz y pitch) más su actividad. La clave es el
 * `twitch_user_id`, estable aunque el usuario se renombre en Twitch.
 */

/** Preferencias que `updatePreferences()` acepta, mapeadas a su columna. */
const PREFERENCE_COLUMNS = Object.freeze({
  username: 'username',
  displayName: 'display_name',
  muted: 'muted',
  ignored: 'ignored',
  volume: 'volume',
  pitch: 'pitch',
  timbre: 'timbre',
  voiceId: 'voice_id',
  voiceSource: 'voice_source',
});

const BOOLEAN_PREFERENCES = new Set(['muted', 'ignored']);

const toUser = (row) =>
  row
    ? {
        twitchUserId: row.twitch_user_id,
        username: row.username,
        displayName: row.display_name,
        muted: row.muted === 1,
        ignored: row.ignored === 1,
        volume: row.volume,
        pitch: row.pitch,
        timbre: row.timbre,
        voiceId: row.voice_id,
        voiceSource: row.voice_source,
        firstSeenAt: row.first_seen_at,
        lastActiveAt: row.last_active_at,
      }
    : null;

export function createUsersRepository(db) {
  const selectOne = db.prepare('SELECT * FROM users WHERE twitch_user_id = ?');
  const selectRecent = db.prepare('SELECT * FROM users ORDER BY last_active_at DESC, username ASC LIMIT ?');
  const remove = db.prepare('DELETE FROM users WHERE twitch_user_id = ?');
  const countAll = db.prepare('SELECT COUNT(*) AS total FROM users');

  // Upsert por `twitch_user_id`: la primera vez inserta con los defaults; las
  // siguientes solo refresca identidad y actividad, preservando `first_seen_at`
  // y todas las preferencias ya guardadas.
  const upsert = db.prepare(`
    INSERT INTO users (
      twitch_user_id, username, display_name, muted, ignored, volume, pitch, timbre,
      voice_id, voice_source, first_seen_at, last_active_at
    )
    VALUES (
      @twitchUserId, @username, @displayName, 0, 0, @volume, @pitch, @timbre,
      NULL, NULL, @timestamp, @timestamp
    )
    ON CONFLICT (twitch_user_id) DO UPDATE SET
      username       = excluded.username,
      display_name   = excluded.display_name,
      last_active_at = excluded.last_active_at
  `);

  // Crea la fila de un usuario que **todavía no ha escrito** (T-011: el streamer
  // le guarda una preferencia a un lurker que la columna reporta como presente).
  // A diferencia del upsert no toca nada si ya existe, y deja `last_active_at` en
  // 0 para no inventarle actividad: la UI lo muestra como "todavía no ha escrito".
  const insertIfMissing = db.prepare(`
    INSERT INTO users (
      twitch_user_id, username, display_name, muted, ignored, volume, pitch, timbre,
      voice_id, voice_source, first_seen_at, last_active_at
    )
    VALUES (
      @twitchUserId, @username, @displayName, 0, 0, @volume, @pitch, @timbre,
      NULL, NULL, @timestamp, 0
    )
    ON CONFLICT (twitch_user_id) DO NOTHING
  `);

  return {
    /** Un usuario por su id de Twitch, o `null` si no existe todavía. */
    get(twitchUserId) {
      return toUser(selectOne.get(String(twitchUserId)));
    },

    /** Usuarios ordenados por actividad reciente (los usa la columna derecha). */
    list({ limit = 500 } = {}) {
      return selectRecent.all(limit).map(toUser);
    },

    /** Cuántos usuarios conocidos hay. */
    count() {
      return countAll.get().total;
    },

    /**
     * Inserta el usuario si es nuevo o actualiza nombre y `last_active_at` si ya
     * existía. `volume`/`pitch`/`timbre` solo aplican en la inserción inicial;
     * después se cambian con `updatePreferences()` para no pisar los ajustes del
     * streamer.
     */
    upsert({ twitchUserId, username, displayName, volume = 1, pitch = 1, timbre = 1, timestamp = Date.now() }) {
      const id = String(twitchUserId);
      const login = username ?? displayName ?? id;
      upsert.run({
        twitchUserId: id,
        username: login,
        displayName: displayName ?? login,
        volume,
        pitch,
        timbre,
        timestamp,
      });
      return this.get(id);
    },

    /**
     * Garantiza que exista la fila de un usuario **sin marcarlo como activo**:
     * inserta con `last_active_at = 0` si falta y no cambia nada si ya estaba
     * (ni el nombre, ni la actividad, ni las preferencias). Es lo que necesita
     * guardar una preferencia de alguien que todavía no ha escrito; para el
     * camino de un mensaje, el correcto sigue siendo `upsert()`.
     *
     * `pitch`/`timbre` (y `volume`) aplican solo en la inserción, igual que en el
     * upsert: así el usuario recibe su pitch y timbre aleatorios persistentes
     * aunque su fila nazca desde el panel en vez de desde un mensaje.
     */
    ensure({ twitchUserId, username, displayName, volume = 1, pitch = 1, timbre = 1, timestamp = Date.now() }) {
      const id = String(twitchUserId);
      const login = username ?? displayName ?? id;
      insertIfMissing.run({
        twitchUserId: id,
        username: login,
        displayName: displayName ?? login,
        volume,
        pitch,
        timbre,
        timestamp,
      });
      return this.get(id);
    },

    /**
     * Actualiza parcialmente las preferencias de un usuario existente. Solo se
     * escriben las claves presentes en `patch`; `voiceId`/`voiceSource` aceptan
     * `null` para volver a la voz global. Devuelve el usuario o `null` si no existe.
     */
    updatePreferences(twitchUserId, patch = {}) {
      const assignments = [];
      const params = { twitchUserId: String(twitchUserId) };

      for (const [key, column] of Object.entries(PREFERENCE_COLUMNS)) {
        if (!Object.prototype.hasOwnProperty.call(patch, key)) {
          continue;
        }
        const value = patch[key];
        assignments.push(`${column} = @${key}`);
        params[key] = BOOLEAN_PREFERENCES.has(key) ? (value ? 1 : 0) : value;
      }

      if (assignments.length === 0) {
        return this.get(twitchUserId);
      }

      db.prepare(
        `UPDATE users SET ${assignments.join(', ')} WHERE twitch_user_id = @twitchUserId`,
      ).run(params);

      return this.get(twitchUserId);
    },

    /** Borra un usuario y sus preferencias. Devuelve si borró algo. */
    delete(twitchUserId) {
      return remove.run(String(twitchUserId)).changes > 0;
    },
  };
}
