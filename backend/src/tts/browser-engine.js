/**
 * Motor `browser` visto desde el backend (T-008).
 *
 * La implementación real —Web Speech API— vive en el frontend
 * (`frontend/src/tts/browser-engine.js`), porque es el navegador el que
 * sintetiza y reproduce. Lo que hace falta aquí es el **descriptor** del motor:
 * el registro necesita saber que el namespace `browser:` existe, que es de tipo
 * `client` (no adjunta audio) y que está siempre disponible, para poder resolver
 * las voces `browser:*` y usarlo como respaldo cuando la voz pedida pertenece a
 * un motor que todavía no está registrado o que ha fallado.
 *
 * El catálogo de voces del navegador tampoco se puede conocer desde el servidor
 * (depende del SO y del navegador del operador), así que `listVoices()` devuelve
 * `[]`. T-011, cuando arme el selector de voces, puede completarlo con lo que el
 * cliente reporte; el frontend ya expone su lista real con `listBrowserVoices()`.
 */
import { TTS_ENGINE_KINDS, TTS_ENGINE_NAMES } from './engine.js';

/** Descriptor del motor del navegador. Cumple la interfaz `TTSEngine`. */
export function createBrowserEngine() {
  return {
    name: TTS_ENGINE_NAMES.browser,
    kind: TTS_ENGINE_KINDS.client,

    /** El navegador siempre está: es donde corre la app. */
    isAvailable: async () => true,

    /**
     * Vacío por diseño: el catálogo real solo se conoce en el navegador. No es un
     * hueco a rellenar en el backend, sino un dato que sube el cliente (T-011).
     */
    listVoices: async () => [],
  };
}
