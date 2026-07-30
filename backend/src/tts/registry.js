/**
 * Registro de motores TTS (T-008).
 *
 * Es el único lugar que sabe qué motores existen en esta instalación. Sumar un
 * motor es **una línea** en `getTtsRegistry()` (o un `register()` desde fuera),
 * sin tocar el pipeline ni el relay:
 *
 *     registry.register(createEdgeTtsEngine());   // T-009
 *     registry.register(createPiperEngine());     // T-010
 *
 * Dos garantías que el pipeline necesita:
 *
 * 1. **La resolución por mensaje es sincrónica.** `resolve(voiceId)` no llama a
 *    `isAvailable()` (que es async y puede tocar red o disco): solo mira si el
 *    motor está registrado. La disponibilidad *dinámica* —edge sin internet,
 *    Piper sin binario— se maneja al sintetizar, cayendo al motor del navegador
 *    (T-009/T-010), no aquí.
 * 2. **Siempre hay un motor.** El del navegador se registra en la construcción y
 *    `resolve()` cae a él cuando la voz pedida apunta a un motor desconocido, de
 *    modo que un mensaje nunca se queda sin leer por un id de voz obsoleto o por
 *    la voz global default (`edge:es-MX-DaliaNeural`) antes de que T-009 exista.
 */
import { config } from '../config.js';
import { logger } from '../logger.js';
import { createBrowserEngine } from './browser-engine.js';
import { createEdgeTtsEngine } from './edge-engine.js';
import { FALLBACK_ENGINE_NAME, assertTtsEngine, parseVoiceId } from './engine.js';
import { createMeloEngine, isMeloEnabled } from './melo-engine.js';
import { createPiperEngine } from './piper-engine.js';
import { isPiperEnabled } from './piper-install.js';
import { createLoquendoEngine, createSapiEngine, isLoquendoEnabled, isSapiEnabled } from './sapi-engine.js';

/**
 * Crea un registro vacío salvo el motor del navegador (que es el respaldo y no
 * se puede quitar).
 */
export function createTtsEngineRegistry({ engines = [createBrowserEngine()] } = {}) {
  const byName = new Map();
  /** Motores desconocidos ya avisados, para no repetir el log en cada mensaje. */
  const warnedEngines = new Set();

  const register = (engine) => {
    assertTtsEngine(engine);
    byName.set(engine.name, engine);
    return engine;
  };

  for (const engine of engines) {
    register(engine);
  }

  if (!byName.has(FALLBACK_ENGINE_NAME)) {
    register(createBrowserEngine());
  }

  return {
    /** Registra (o reemplaza) un motor. Valida la interfaz y lo devuelve. */
    register,

    /** El motor de respaldo: el del navegador. Nunca es `undefined`. */
    get fallback() {
      return byName.get(FALLBACK_ENGINE_NAME);
    },

    /** El motor con ese nombre, o `null`. */
    get: (name) => byName.get(name) ?? null,

    /** `true` si el motor está registrado. */
    has: (name) => byName.has(name),

    /** Todos los motores registrados, en orden de registro. */
    list: () => [...byName.values()],

    /**
     * Resuelve un id de voz namespaced al motor que lo puede leer.
     *
     * Devuelve `{ engine, voiceId, fallback }`:
     * - `engine`   el `TTSEngine` que se usará.
     * - `voiceId`  el id pedido si su motor está registrado; `null` si se cayó al
     *              respaldo (`null` significa "que el cliente elija su mejor voz
     *              en español", ver `frontend/src/tts/browser-engine.js`).
     * - `fallback` `true` si hubo que caer al respaldo.
     */
    resolve(voiceId) {
      const parsed = parseVoiceId(voiceId);
      const engine = parsed ? byName.get(parsed.engine) : null;

      if (engine) {
        return { engine, voiceId, fallback: false };
      }

      const label = parsed ? parsed.engine : String(voiceId);
      if (!warnedEngines.has(label)) {
        warnedEngines.add(label);
        logger.warn(`tts: motor "${label}" no registrado; se leerá con ${FALLBACK_ENGINE_NAME}`);
      }

      return { engine: byName.get(FALLBACK_ENGINE_NAME), voiceId: null, fallback: true };
    },

    /**
     * Catálogo agregado de todos los motores, para `GET /api/voices` (T-009 y
     * T-011). Un motor que falle al listar no tumba el catálogo entero.
     */
    async listVoices() {
      const catalogs = await Promise.all(
        [...byName.values()].map(async (engine) => {
          try {
            return await engine.listVoices();
          } catch (error) {
            logger.error(`tts: el motor "${engine.name}" no pudo listar voces (${error.message})`);
            return [];
          }
        }),
      );
      return catalogs.flat();
    },
  };
}

let defaultRegistry = null;

/**
 * Registro por defecto del proceso (perezoso). T-009 y T-010 añaden aquí sus
 * motores; el resto del backend nunca construye uno propio.
 */
export function getTtsRegistry() {
  if (defaultRegistry === null) {
    defaultRegistry = createTtsEngineRegistry();
    if (config.tts.edgeEnabled) {
      defaultRegistry.register(createEdgeTtsEngine()); // T-009
    }
    if (isPiperEnabled()) {
      // T-010. Registrarlo no cuesta nada aunque Piper no esté instalado: su
      // catálogo sale vacío y sus voces no aparecen en `GET /api/voices`.
      defaultRegistry.register(createPiperEngine());
    }
    if (isSapiEnabled()) {
      // Igual que Piper: registrarlo no cuesta nada fuera de Windows o sin
      // voces instaladas, el catálogo sale vacío.
      defaultRegistry.register(createSapiEngine());
    }
    if (isLoquendoEnabled()) {
      // Catálogo aparte de sapi (mismo mecanismo, filtrado por Vendor): si no
      // hay voces Loquendo instaladas, no cuesta nada, igual que los demás.
      defaultRegistry.register(createLoquendoEngine());
    }
    if (isMeloEnabled()) {
      // Igual que Piper: registrarlo no cuesta nada con el contenedor abajo,
      // el catálogo sale vacío hasta que `docker compose up -d melotts` responda.
      defaultRegistry.register(createMeloEngine());
    }
  }
  return defaultRegistry;
}
