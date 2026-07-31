import { createSettingsRepository } from './settings.js';
import { createTokensRepository } from './tokens.js';
import { createUsersRepository } from './users.js';
import { createViewerSessionsRepository } from './viewer-sessions.js';

/**
 * Agrupa los repositorios de las tablas sobre una misma conexión. El resto del
 * backend los obtiene con `getRepositories()` (ver `src/db/index.js`); las
 * pruebas los construyen sobre una base temporal.
 */
export function createRepositories(db) {
  return {
    db,
    tokens: createTokensRepository(db),
    users: createUsersRepository(db),
    settings: createSettingsRepository(db),
    viewerSessions: createViewerSessionsRepository(db),
  };
}

export { createSettingsRepository, SETTING_KEYS } from './settings.js';
export { createTokensRepository, DEFAULT_PROVIDER } from './tokens.js';
export { createUsersRepository } from './users.js';
export { createViewerSessionsRepository } from './viewer-sessions.js';
