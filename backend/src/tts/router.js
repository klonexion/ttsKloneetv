/**
 * Rutas REST del TTS (T-009), montadas bajo `/api`:
 *
 * - `GET /api/voices`              catálogo de voces de **todos** los motores.
 * - `GET /api/tts/audio/:messageId` audio ya sintetizado de un mensaje.
 *
 * ## `GET /api/voices` es genérico a propósito
 *
 * No menciona ningún motor: recorre el registro (`registry.listVoices()`, que ya
 * agrega catálogos y aísla al motor que falle devolviendo `[]`). Consecuencia
 * directa para T-010: **en cuanto Piper se registre, sus voces aparecen aquí sin
 * tocar esta ruta**; y si Piper no está instalado, su catálogo sale vacío y el
 * resto sigue funcionando. Lo mismo vale para el motor `browser`, cuyo catálogo
 * real solo se conoce en el navegador (`listBrowserVoices()` en el frontend), así
 * que aporta `[]` por diseño.
 *
 * Respuesta:
 *
 *     {
 *       voices:  [{ id, name, engine, language, label }, ...],  // ids namespaced
 *       engines: [{ name, kind }, ...]                          // orden de registro
 *     }
 *
 * El orden de `voices` es: primero las de idioma preferido (español), y dentro de
 * cada grupo por motor (orden de registro) y por id. Así el selector de T-011
 * puede pintarlo tal como llega, agrupado por motor y con el español primero.
 *
 * ## `GET /api/tts/audio/:messageId`
 *
 * Sirve los bytes que dejó `./server-audio.js` (ver ahí el por qué de servir una
 * URL en vez de meter el audio en la trama del WebSocket). Códigos:
 *
 * - `200` + `Content-Type` del formato → el audio.
 * - `404` no hay audio para ese mensaje (nunca lo hubo, o ya caducó).
 * - `503` la síntesis falló → el cliente lo lee con el motor del navegador.
 */
import express from 'express';

import { logger } from '../logger.js';
import { getTtsPipeline } from './pipeline.js';
import { getTtsRegistry } from './registry.js';

/** Idiomas que van primero en el catálogo. El resto queda detrás, en orden. */
export const PREFERRED_VOICE_LANGUAGES = Object.freeze(['es']);

/** `true` si el idioma de la voz es uno de los preferidos. */
export const isPreferredLanguage = (language, preferred = PREFERRED_VOICE_LANGUAGES) => {
  const value = String(language ?? '').toLowerCase();
  return preferred.some((wanted) => value === wanted || value.startsWith(`${wanted.toLowerCase()}-`));
};

/**
 * Ordena el catálogo agregado: idioma preferido primero, después por motor (en el
 * orden en que están registrados) y por id. No filtra nada: cada motor decide qué
 * expone (edge ya recorta a español con `TTS_EDGE_VOICE_LANGS`).
 */
export function sortVoiceCatalog(voices, engineOrder = []) {
  const rank = new Map(engineOrder.map((name, index) => [name, index]));
  const engineRank = (voice) => rank.get(voice.engine) ?? engineOrder.length;

  return [...voices].sort((a, b) => {
    const preferredDiff = Number(isPreferredLanguage(b.language)) - Number(isPreferredLanguage(a.language));
    if (preferredDiff !== 0) {
      return preferredDiff;
    }
    const engineDiff = engineRank(a) - engineRank(b);
    if (engineDiff !== 0) {
      return engineDiff;
    }
    return String(a.id).localeCompare(String(b.id));
  });
}

/**
 * @param {object} [options]
 * @param {ReturnType<import('./registry.js').createTtsEngineRegistry>} [options.registry]
 * @param {ReturnType<import('./server-audio.js').createServerAudioStore>} [options.serverAudio]
 */
export function createTtsRouter({ registry = getTtsRegistry(), serverAudio = null } = {}) {
  const router = express.Router();
  // El almacén lo crea el pipeline (es quien adjunta la URL al decidir); aquí se
  // resuelve tarde para no forzar la construcción del pipeline al montar la app.
  const audioStore = () => serverAudio ?? getTtsPipeline().serverAudio;

  router.get('/voices', async (req, res) => {
    try {
      const engines = registry.list().map((engine) => ({ name: engine.name, kind: engine.kind }));
      const voices = sortVoiceCatalog(
        await registry.listVoices(),
        engines.map((engine) => engine.name),
      );
      return res.json({ voices, engines });
    } catch (error) {
      logger.error(`api: no se pudo listar el catálogo de voces (${error.message})`);
      return res.status(500).json({ error: 'No se pudo listar el catálogo de voces.', code: 'failed' });
    }
  });

  router.get('/tts/audio/:messageId', async (req, res) => {
    const entry = audioStore().get(req.params.messageId);
    if (entry === null) {
      return res.status(404).json({ error: 'No hay audio para ese mensaje.', code: 'not_found' });
    }

    try {
      const { mime, bytes } = await entry.audio;
      res.setHeader('Content-Type', mime);
      // Audio de un solo uso: ni el navegador ni un proxy deben guardarlo.
      res.setHeader('Cache-Control', 'no-store');
      return res.send(bytes);
    } catch {
      // El fallo ya se registró al arrancar la síntesis (`server-audio.js`): aquí
      // solo se le dice al cliente que lo lea con el motor del navegador.
      return res.status(503).json({ error: 'La síntesis de voz falló.', code: 'synthesis_failed' });
    }
  });

  return router;
}
