/**
 * Rutas REST del chat (T-006), montadas en `/api/chat`:
 *
 * - `POST /api/chat/send`  `{ text }` → publica el mensaje como el broadcaster.
 *
 * Respuesta feliz: `200 { sent: true, messageId }` (`messageId` es el id de
 * Twitch; el mensaje se renderiza cuando vuelve por EventSub, no desde aquí).
 * Fallo: el `status` que corresponda con `{ error, code }`, donde `code` es uno
 * de `CHAT_SEND_CODES` y `error` un texto en español listo para mostrar.
 */
import express from 'express';

import { logger } from '../logger.js';
import { ChatSendError, sendChatMessage } from './send.js';

export function createChatRouter() {
  const router = express.Router();

  router.post('/send', async (req, res) => {
    try {
      const { messageId } = await sendChatMessage(req.body?.text);
      return res.json({ sent: true, messageId });
    } catch (error) {
      if (error instanceof ChatSendError) {
        // Un texto vacío o demasiado largo es cosa del cliente: no ensucia el log.
        if (error.status >= 500) {
          logger.warn(`api: no se pudo enviar el mensaje (${error.message})`);
        }
        return res.status(error.status).json({ error: error.message, code: error.code });
      }

      logger.error(`api: fallo inesperado enviando al chat (${error.message})`);
      return res.status(500).json({ error: 'No se pudo enviar el mensaje.', code: 'failed' });
    }
  });

  return router;
}
