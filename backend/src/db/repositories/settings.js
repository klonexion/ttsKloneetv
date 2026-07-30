import { DEFAULT_SETTINGS } from '../migrations.js';

/**
 * Repositorio de la tabla `app_settings`: pares clave/valor de los ajustes
 * globales (voz global, tema, y lo que sumen T-013 y siguientes). Los valores se
 * guardan siempre como TEXT.
 */

/**
 * Claves conocidas de los ajustes globales. Las tres de `twitch_*` guardan la
 * identidad del canal autenticado (T-003): no tienen default sembrado, solo
 * existen mientras haya sesión, porque el esquema de `tokens` está fijado por el
 * plan y no admite columnas nuevas.
 */
export const SETTING_KEYS = Object.freeze({
  globalVoiceId: 'global_voice_id',
  theme: 'theme',
  twitchUserId: 'twitch_user_id',
  twitchLogin: 'twitch_login',
  twitchDisplayName: 'twitch_display_name',
});

export function createSettingsRepository(db) {
  const selectOne = db.prepare('SELECT value FROM app_settings WHERE key = ?');
  const selectAll = db.prepare('SELECT key, value FROM app_settings ORDER BY key');
  const upsert = db.prepare(`
    INSERT INTO app_settings (key, value) VALUES (@key, @value)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `);
  const remove = db.prepare('DELETE FROM app_settings WHERE key = ?');

  const setMany = db.transaction((entries) => {
    for (const [key, value] of entries) {
      upsert.run({ key, value: String(value) });
    }
  });

  return {
    /** Valor de una clave, o `fallback` (default `null`) si no está. */
    get(key, fallback = null) {
      const row = selectOne.get(key);
      return row ? row.value : fallback;
    },

    /** Todos los ajustes como objeto plano `{ key: value }`. */
    all() {
      return Object.fromEntries(selectAll.all().map((row) => [row.key, row.value]));
    },

    /** Escribe una clave (insert o update). Devuelve el valor guardado. */
    set(key, value) {
      upsert.run({ key, value: String(value) });
      return this.get(key);
    },

    /** Escribe varias claves de golpe, en una sola transacción. */
    setAll(values) {
      setMany(Object.entries(values));
      return this.all();
    },

    /** Borra una clave. Devuelve si borró algo. */
    delete(key) {
      return remove.run(key).changes > 0;
    },

    /** Voz global vigente (default `edge:es-MX-DaliaNeural`). */
    getGlobalVoiceId() {
      return this.get(SETTING_KEYS.globalVoiceId, DEFAULT_SETTINGS.global_voice_id);
    },

    /** Tema vigente de la UI (default `dark`). */
    getTheme() {
      return this.get(SETTING_KEYS.theme, DEFAULT_SETTINGS.theme);
    },
  };
}
