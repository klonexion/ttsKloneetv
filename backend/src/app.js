import express from 'express';

import { createAuthRouter } from './auth/router.js';
import { getSession } from './auth/session.js';
import { createChatRouter } from './chat/send-router.js';
import { logger } from './logger.js';
import { createSettingsRouter } from './settings/router.js';
import { createTtsRouter } from './tts/router.js';
import { createUsersRouter } from './users/router.js';

/**
 * App Express del backend.
 *
 * Convención de rutas (ver "Decisiones arquitectónicas durables" del plan):
 * - `GET /auth/login` y `GET /auth/callback`  → OAuth de Twitch, sesión del bot (T-003).
 * - Todo lo demás bajo `/api/*`               → REST para el frontend.
 * - El WebSocket frontend↔backend vive en `/ws` (ver `src/ws/hub.js`).
 *
 * Este backend admin **nunca se expone a internet** (T-015,
 * `docs/exec-plans/active/configura-mi-voz.md`): el login de viewer y la
 * pantalla de "!configura-mi-voz" viven en `viewer/server.js`, un proceso
 * aparte con su propio puerto. Si en algún momento aparece acá una ruta
 * pensada para que le pegue alguien que no sea el propio streamer desde su
 * `localhost`, es una señal de que se está rompiendo esa separación.
 */
export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json());

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  /**
   * Estado de la sesión para la compuerta de login del frontend.
   * Solo `{ authenticated, channel }`: los tokens no salen del backend.
   */
  app.get('/api/session', (req, res) => {
    try {
      res.json(getSession());
    } catch (error) {
      logger.error(`api: no se pudo leer la sesión (${error.message})`);
      res.status(500).json({ error: 'no se pudo leer la sesión' });
    }
  });

  app.use('/auth', createAuthRouter());
  app.use('/api/chat', createChatRouter());
  // T-013: `GET`/`PATCH /api/settings` (voz global, volumen maestro y tema).
  app.use('/api/settings', createSettingsRouter());
  // T-011: `PATCH /api/users/:userId/preferences` (panel del usuario).
  app.use('/api/users', createUsersRouter());
  // T-009: `GET /api/voices` y `GET /api/tts/audio/:messageId`.
  app.use('/api', createTtsRouter());

  return app;
}
