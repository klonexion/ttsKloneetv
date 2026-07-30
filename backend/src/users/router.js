/**
 * Rutas REST de los usuarios (T-011), montadas en `/api/users`:
 *
 * - `PATCH /api/users/:userId/preferences` — guarda las preferencias locales del
 *   usuario (mute del TTS, ignorar, volumen, pitch, timbre y voz).
 *
 * Cuerpo: cualquier subconjunto de
 * `{ muted, ignored, volume, pitch, timbre, voiceId, rerollPitch, rerollTimbre, username, displayName }`
 * (ver `./preferences.js` para los rangos y las reglas). `username`/`displayName`
 * solo se usan si hay que **crear** la fila de alguien que todavía no ha escrito.
 *
 * Respuesta feliz: `200 { user }`, con la fila ya guardada y las mismas claves con
 * las que cada usuario viaja en la trama `users:list`, para que el frontend la
 * mezcle en su columna sin esperar el siguiente poll. Fallo de validación:
 * `400 { error, code }` con el texto en español listo para mostrar.
 *
 * El cambio **aplica al siguiente mensaje del usuario sin reiniciar** porque el
 * pipeline TTS (`../tts/pipeline.js`) lee `users` en cada mensaje: no hay estado
 * en memoria que invalidar.
 */
import express from 'express';

import { logger } from '../logger.js';
import { UserPreferencesError, applyUserPreferences } from './preferences.js';

export function createUsersRouter({ repositories = undefined } = {}) {
  const router = express.Router();

  router.patch('/:userId/preferences', (req, res) => {
    try {
      const user = applyUserPreferences({
        userId: req.params.userId,
        body: req.body ?? {},
        ...(repositories ? { repositories } : {}),
      });
      return res.json({ user });
    } catch (error) {
      if (error instanceof UserPreferencesError) {
        // Un cuerpo mal formado es cosa del cliente: no ensucia el log.
        return res.status(error.status).json({ error: error.message, code: error.code });
      }

      logger.error(`api: no se pudieron guardar las preferencias (${error.message})`);
      return res.status(500).json({ error: 'No se pudieron guardar las preferencias.', code: 'failed' });
    }
  });

  return router;
}
