/**
 * Catálogo de voces y preferencias propias del viewer (T-015). Reusa
 * `backend/src/users/preferences.js` (la misma validación y el mismo camino
 * de escritura — `voice_source = 'override'` — que ya usa el panel del
 * streamer) en vez de reimplementarlo.
 *
 * La garantía que importa acá: **el `userId` nunca sale del body de la
 * petición**, siempre es `req.viewerSession.twitchUserId` (la cookie
 * autenticada por `requireViewerSession`). Un viewer no tiene ninguna forma de
 * pedir "actualizame a este otro usuario".
 */
import express from 'express';

import { requireViewerSession } from '../backend/src/auth/viewer-router.js';
import { getRepositories } from '../backend/src/db/index.js';
import { logger } from '../backend/src/logger.js';
import { AUDIO_MIME_TYPES, TTS_ENGINE_KINDS, getTtsRegistry, parseVoiceId } from '../backend/src/tts/index.js';
import { PREFERENCE_LIMITS, applyUserPreferences, UserPreferencesError } from '../backend/src/users/preferences.js';

/**
 * Lo único que un viewer puede tocar de sí mismo (decisión del grill del
 * 2026-07-30, `docs/decisiones.md`): voz + volumen + pitch/timbre. Nada de
 * `muted`/`ignored` — eso sigue siendo exclusivo del panel del streamer.
 */
const ALLOWED_KEYS = new Set(['voiceId', 'volume', 'pitch', 'timbre', 'rerollPitch', 'rerollTimbre']);

/** Frase corta y neutra para la vista previa — no depende de nada del chat real. */
const PREVIEW_TEXT = 'Así va a sonar tu voz en el chat, pe tontito.';

/** Recorta un número al rango dado, o usa `fallback` si no es un número válido. */
const clampNumber = (value, min, max, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, num));
};

export function createViewerPreferencesRouter() {
  const router = express.Router();

  /** Catálogo agregado de voces (misma fuente que `GET /api/voices` del admin). */
  router.get('/catalog', async (req, res) => {
    try {
      const voices = await getTtsRegistry().listVoices();
      res.json({ voices });
    } catch (error) {
      logger.error(`viewer: no se pudo listar el catálogo de voces (${error.message})`);
      res.status(500).json({ error: 'no se pudo leer el catálogo de voces' });
    }
  });

  /** La fila propia del viewer logueado, o los defaults si todavía no tiene una. */
  router.get('/preferences', requireViewerSession, (req, res) => {
    const user = getRepositories().users.get(req.viewerSession.twitchUserId);
    if (user === null) {
      res.json({ voiceId: null, volume: 1, pitch: 1, timbre: 1 });
      return;
    }
    res.json({ voiceId: user.voiceId, volume: user.volume, pitch: user.pitch, timbre: user.timbre });
  });

  /**
   * Vista previa de una voz (sin guardar nada). Solo tiene sentido para motores
   * de servidor (`edge`/`piper`/`sapi`/`loquendo`/`melo`): sintetiza una frase
   * corta con la voz/pitch/timbre pedidos y devuelve el audio tal cual.
   * `browser:*` no pasa por acá — esa la sintetiza el propio navegador del
   * viewer con Web Speech, no tiene nada que generar el servidor.
   */
  router.post('/preview', requireViewerSession, async (req, res) => {
    const body = req.body ?? {};
    const parsed = parseVoiceId(body.voiceId);
    if (parsed === null) {
      res.status(400).json({ error: '«voiceId» inválido', code: 'invalid_voice' });
      return;
    }

    const engine = getTtsRegistry().get(parsed.engine);
    if (engine === null || engine.kind !== TTS_ENGINE_KINDS.server) {
      res.status(400).json({ error: `el motor "${parsed.engine}" no sintetiza en el servidor`, code: 'not_server_engine' });
      return;
    }

    const pitch = clampNumber(body.pitch, PREFERENCE_LIMITS.pitchMin, PREFERENCE_LIMITS.pitchMax, 1);
    const timbre = clampNumber(body.timbre, PREFERENCE_LIMITS.timbreMin, PREFERENCE_LIMITS.timbreMax, 1);

    try {
      const audio = await engine.synthesize({ text: PREVIEW_TEXT, voiceId: body.voiceId, pitch, timbre });
      const mime = AUDIO_MIME_TYPES[audio.format];
      if (mime === undefined) {
        throw new Error(`formato de audio desconocido (${audio?.format})`);
      }
      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'no-store');
      res.send(Buffer.from(audio.base64, 'base64'));
    } catch (error) {
      logger.error(`viewer: no se pudo generar la vista previa de "${body.voiceId}" (${error.message})`);
      res.status(503).json({ error: 'no se pudo generar la muestra de voz', code: 'synthesis_failed' });
    }
  });

  /** Guarda las preferencias propias del viewer logueado. */
  router.patch('/preferences', requireViewerSession, (req, res) => {
    const body = req.body ?? {};
    const forbidden = Object.keys(body).filter((key) => !ALLOWED_KEYS.has(key));
    if (forbidden.length > 0) {
      res.status(400).json({ error: `no podés tocar: ${forbidden.join(', ')}`, code: 'forbidden_key' });
      return;
    }

    try {
      const updated = applyUserPreferences({
        userId: req.viewerSession.twitchUserId,
        body: {
          ...body,
          username: req.viewerSession.username,
          displayName: req.viewerSession.displayName,
        },
      });
      res.json({
        voiceId: updated.voiceId,
        volume: updated.volume,
        pitch: updated.pitch,
        timbre: updated.timbre,
      });
    } catch (error) {
      if (error instanceof UserPreferencesError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      logger.error(`viewer: no se pudieron guardar las preferencias (${error.message})`);
      res.status(500).json({ error: 'no se pudo guardar' });
    }
  });

  return router;
}
