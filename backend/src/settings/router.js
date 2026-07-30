/**
 * Rutas REST de los ajustes globales (T-013), montadas en `/api/settings`:
 *
 * - `GET   /api/settings` — los cuatro ajustes vigentes.
 * - `PATCH /api/settings` — guarda cualquier subconjunto de ellos.
 *
 * Cuerpo del `PATCH`: cualquier subconjunto de
 * `{ globalVoiceId, theme, masterVolume, masterTimbre }` (ver `./settings.js`
 * para los rangos). Respuesta feliz en las dos: `200 { settings: {
 * globalVoiceId, theme, masterVolume, masterTimbre } }`. Fallo de validación:
 * `400 { error, code }` con el texto en español listo para mostrar.
 *
 * No hace falta sesión de Twitch: son ajustes locales de la app (el tema se
 * necesita incluso en la pantalla de login).
 *
 * Los cambios **aplican en vivo, sin reiniciar**: la voz global y el timbre
 * maestro los relee el pipeline en cada mensaje; el tema y el volumen maestro
 * los aplica el frontend en cuanto le responde esta ruta.
 */
import express from 'express';

import { logger } from '../logger.js';
import { GlobalSettingsError, applyGlobalSettings, readGlobalSettings } from './settings.js';

export function createSettingsRouter({ repositories = undefined } = {}) {
  const router = express.Router();
  const options = repositories ? { repositories } : {};

  router.get('/', (req, res) => {
    try {
      return res.json({ settings: readGlobalSettings(options.repositories) });
    } catch (error) {
      logger.error(`api: no se pudieron leer los ajustes globales (${error.message})`);
      return res.status(500).json({ error: 'No se pudieron leer los ajustes globales.', code: 'failed' });
    }
  });

  router.patch('/', (req, res) => {
    try {
      const settings = applyGlobalSettings({ body: req.body ?? {}, ...options });
      return res.json({ settings });
    } catch (error) {
      if (error instanceof GlobalSettingsError) {
        // Un cuerpo mal formado es cosa del cliente: no ensucia el log.
        return res.status(error.status).json({ error: error.message, code: error.code });
      }

      logger.error(`api: no se pudieron guardar los ajustes globales (${error.message})`);
      return res.status(500).json({ error: 'No se pudieron guardar los ajustes globales.', code: 'failed' });
    }
  });

  return router;
}
