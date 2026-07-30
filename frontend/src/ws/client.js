import { readonly, ref } from 'vue';

/**
 * Cliente único del WebSocket `/ws` del backend (T-005).
 *
 * Es la contraparte de `backend/src/ws/hub.js`: el hub emite tramas JSON
 * `{ type, payload }` con `broadcast(type, payload)` y aquí se despachan a los
 * suscriptores registrados por `type`.
 *
 * Contrato para las tareas siguientes (T-004/T-007/T-008): **no** abras otro
 * WebSocket ni sobreescribas `socket.onmessage`. Registra un listener por tipo:
 *
 *     const off = onServerMessage('users:list', (payload) => { ... });
 *
 * `onServerMessage` devuelve la función para desuscribirse y sobrevive a las
 * reconexiones (los listeners viven fuera del socket).
 *
 * La URL se deriva de `window.location`, así que en dev viaja por el proxy de
 * Vite y en producción por el mismo origen: nunca hay un origen hardcodeado.
 */

/** Ruta del WebSocket, la misma que `config.wsPath` en el backend. */
export const WS_PATH = '/ws';

/** Backoff de reconexión (ms). El último valor se repite indefinidamente. */
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 5000, 10000];

/** Estado de la conexión: `connecting` | `open` | `reconnecting` | `closed`. */
const state = ref('closed');

/** Nº de reintentos desde la última conexión abierta (útil para diagnóstico). */
const attempts = ref(0);

/** Suscriptores por tipo de mensaje. */
const listeners = new Map();

let socket = null;
let reconnectTimer = null;
let manualClose = false;

/** Estado de conexión de solo lectura, para pintar el indicador en la UI. */
export const connectionState = readonly(state);

/** Reintentos acumulados de reconexión, de solo lectura. */
export const connectionAttempts = readonly(attempts);

/**
 * Registra un handler para las tramas `{ type }` que emite el backend.
 * Devuelve la función de baja.
 */
export function onServerMessage(type, handler) {
  if (!listeners.has(type)) {
    listeners.set(type, new Set());
  }
  const handlers = listeners.get(type);
  handlers.add(handler);

  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) {
      listeners.delete(type);
    }
  };
}

function socketUrl() {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}${WS_PATH}`;
}

function dispatch(raw) {
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    console.warn('ws: trama no-JSON descartada');
    return;
  }

  if (!frame || typeof frame.type !== 'string') {
    console.warn('ws: trama sin `type` descartada');
    return;
  }

  const handlers = listeners.get(frame.type);
  if (!handlers || handlers.size === 0) {
    return;
  }

  for (const handler of handlers) {
    try {
      handler(frame.payload, frame);
    } catch (error) {
      console.error(`ws: handler de "${frame.type}" lanzó un error`, error);
    }
  }
}

function scheduleReconnect() {
  if (manualClose || reconnectTimer !== null) {
    return;
  }

  const delay = RECONNECT_DELAYS_MS[Math.min(attempts.value, RECONNECT_DELAYS_MS.length - 1)];
  attempts.value += 1;
  state.value = 'reconnecting';

  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    open();
  }, delay);
}

function open() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  if (state.value !== 'reconnecting') {
    state.value = 'connecting';
  }

  const next = new WebSocket(socketUrl());
  socket = next;

  next.addEventListener('open', () => {
    if (socket !== next) {
      return;
    }
    attempts.value = 0;
    state.value = 'open';
  });

  next.addEventListener('message', (event) => {
    if (socket === next && typeof event.data === 'string') {
      dispatch(event.data);
    }
  });

  next.addEventListener('close', () => {
    if (socket !== next) {
      return;
    }
    socket = null;
    if (manualClose) {
      state.value = 'closed';
      return;
    }
    scheduleReconnect();
  });

  // `error` siempre viene seguido de `close`, así que la reconexión se agenda ahí.
  next.addEventListener('error', () => {
    state.value = manualClose ? 'closed' : 'reconnecting';
  });
}

/** Abre la conexión (idempotente) y la mantiene viva reconectando sola. */
export function startChatSocket() {
  manualClose = false;
  open();
}

/** Cierra la conexión y cancela la reconexión pendiente. */
export function stopChatSocket() {
  manualClose = true;
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    socket.close();
    socket = null;
  }
  attempts.value = 0;
  state.value = 'closed';
}
