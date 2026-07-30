/**
 * Repositorio de la tabla `tokens`: una fila por proveedor de chat (fase 1,
 * solo `twitch`). Los valores son secretos: nunca loguearlos ni devolverlos al
 * frontend.
 */

/** Proveedor por default de la fase 1. */
export const DEFAULT_PROVIDER = 'twitch';

const toToken = (row) =>
  row
    ? {
        provider: row.provider,
        accessToken: row.access_token,
        refreshToken: row.refresh_token,
        expiresAt: row.expires_at,
        scopes: row.scopes === '' ? [] : row.scopes.split(' '),
      }
    : null;

export function createTokensRepository(db) {
  const selectOne = db.prepare('SELECT * FROM tokens WHERE provider = ?');
  const selectAll = db.prepare('SELECT * FROM tokens ORDER BY provider');
  const upsert = db.prepare(`
    INSERT INTO tokens (provider, access_token, refresh_token, expires_at, scopes)
    VALUES (@provider, @accessToken, @refreshToken, @expiresAt, @scopes)
    ON CONFLICT (provider) DO UPDATE SET
      access_token  = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at    = excluded.expires_at,
      scopes        = excluded.scopes
  `);
  const remove = db.prepare('DELETE FROM tokens WHERE provider = ?');

  return {
    /** Tokens de un proveedor, o `null` si no hay sesión guardada. */
    get(provider = DEFAULT_PROVIDER) {
      return toToken(selectOne.get(provider));
    },

    /** Todos los proveedores con tokens persistidos. */
    list() {
      return selectAll.all().map(toToken);
    },

    /**
     * Inserta o reemplaza los tokens de un proveedor.
     * `expiresAt` en ms epoch; `scopes` como array o string separado por espacios.
     */
    save({
      provider = DEFAULT_PROVIDER,
      accessToken,
      refreshToken,
      expiresAt,
      scopes = [],
    }) {
      upsert.run({
        provider,
        accessToken,
        refreshToken,
        expiresAt,
        scopes: Array.isArray(scopes) ? scopes.join(' ') : String(scopes),
      });
      return this.get(provider);
    },

    /** Borra los tokens de un proveedor (logout). Devuelve si borró algo. */
    delete(provider = DEFAULT_PROVIDER) {
      return remove.run(provider).changes > 0;
    },
  };
}
