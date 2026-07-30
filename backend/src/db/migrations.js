/**
 * Esquema SQLite del proyecto (ver "Decisiones arquitectónicas durables" del
 * plan de ejecución). La migración es idempotente: todo es `IF NOT EXISTS` /
 * `INSERT OR IGNORE`, así que puede ejecutarse en cada arranque.
 *
 * Convenciones de tipos:
 * - Timestamps (`expires_at`, `first_seen_at`, `last_active_at`): INTEGER con
 *   milisegundos epoch UTC (`Date.now()`), comparables y ordenables.
 * - Booleanos (`muted`, `ignored`): INTEGER 0/1 — SQLite no tiene BOOLEAN.
 * - `scopes` (tokens): lista de scopes separada por espacios, como la devuelve
 *   Twitch.
 */

/** Nombre de las tres tablas del esquema, en el orden en que se crean. */
export const TABLE_NAMES = ['tokens', 'users', 'app_settings'];

/** Voz global y tema por default, sembrados la primera vez. */
export const DEFAULT_SETTINGS = Object.freeze({
  global_voice_id: 'edge:es-MX-DaliaNeural',
  theme: 'dark',
});

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tokens (
  provider      TEXT PRIMARY KEY,
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  scopes        TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS users (
  twitch_user_id TEXT PRIMARY KEY,
  username       TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  muted          INTEGER NOT NULL DEFAULT 0,
  ignored        INTEGER NOT NULL DEFAULT 0,
  volume         REAL NOT NULL DEFAULT 1,
  pitch          REAL NOT NULL DEFAULT 1,
  timbre         REAL NOT NULL DEFAULT 1,
  voice_id       TEXT,
  voice_source   TEXT CHECK (voice_source IN ('override', 'command')),
  first_seen_at  INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS users_last_active_at_idx ON users (last_active_at DESC);

CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Crea (si no existen) las tablas del esquema y siembra los ajustes globales
 * por default. Repetirla sobre una base ya migrada no cambia nada: los valores
 * de `app_settings` que el usuario haya modificado se conservan.
 */
export function migrate(db) {
  db.exec(SCHEMA_SQL);
  // `timbre` se sumó después de que `users` ya existiera en bases reales: en una
  // base nueva el CREATE TABLE de arriba ya la trae; en una base vieja hay que
  // agregarla a mano. A diferencia de `CREATE TABLE`, SQLite **no** soporta
  // `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (eso es sintaxis de Postgres/
  // MySQL, no de SQLite — comprobado: "near EXISTS: syntax error"), así que la
  // idempotencia hay que hacerla a mano mirando `PRAGMA table_info`.
  const hasTimbre = db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'timbre'").get();
  if (!hasTimbre) {
    db.exec('ALTER TABLE users ADD COLUMN timbre REAL NOT NULL DEFAULT 1;');
  }

  const seed = db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)');
  const seedAll = db.transaction((defaults) => {
    for (const [key, value] of Object.entries(defaults)) {
      seed.run(key, value);
    }
  });
  seedAll(DEFAULT_SETTINGS);

  return db;
}

/** Nombres de las tablas presentes en la base (útil para verificar/migrar). */
export function listTables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
}
