/**
 * Interfaz de motor TTS **del lado del cliente** y su registro (T-008).
 *
 * Todo el audio suena en el navegador (decisión arquitectónica durable), así que
 * cada motor del backend necesita aquí su contraparte que *reproduce*:
 *
 * - `browser` (T-008) — sintetiza y reproduce con la Web Speech API.
 * - `edge` (T-009) / `piper` (T-010) — el backend ya sintetizó y adjuntó el audio
 *   a la instrucción (`tts.audio = { format, base64 }`); su motor de cliente solo
 *   tiene que reproducirlo (`new Audio('data:audio/mp3;base64,…')`) y avisar al
 *   terminar. **No hay que tocar la cola**: se registran aquí y ya entran en el
 *   mismo flujo FIFO, que es lo que exige el criterio de T-009 (orden intacto
 *   entre motores mezclados).
 *
 * Contrato de un motor de cliente:
 *
 *     {
 *       name: 'browser' | 'edge' | 'piper',
 *       isSupported(): boolean,
 *       speak(item, { onEnd, onError }): handle,
 *     }
 *
 * - `item` es la instrucción TTS del backend más el `id` del mensaje:
 *   `{ id, engine, voiceId, pitch, volume, text }` (y `audio` desde T-009).
 * - `speak()` debe llamar **exactamente una vez** a `onEnd()` o a `onError(error)`.
 *   La cola tolera que sea de forma sincrónica.
 * - `handle` = `{ cancel(), pause?(), resume?(), voice? }`. `cancel()` corta la
 *   reproducción; la cola asume que tras `cancel()` no hará falta esperar a
 *   `onEnd`. `voice` es informativo (qué voz se usó de verdad) y lo registra el
 *   diagnóstico de la cola.
 */

/** Motores de cliente registrados, por nombre. */
const engines = new Map();

/**
 * Registra (o reemplaza) un motor de cliente. Reemplazar es legítimo: es el
 * punto por el que un motor mejor —o uno de prueba— sustituye al anterior.
 */
export function registerTtsEngine(engine) {
  if (!engine || typeof engine.name !== 'string' || typeof engine.speak !== 'function') {
    throw new TypeError('motor TTS de cliente inválido: falta `name` o `speak()`');
  }
  engines.set(engine.name, engine);
  return engine;
}

/** El motor con ese nombre, o `null` si no está registrado. */
export function getTtsEngine(name) {
  return engines.get(name) ?? null;
}

/** Nombres de los motores registrados. */
export function listTtsEngineNames() {
  return [...engines.keys()];
}
