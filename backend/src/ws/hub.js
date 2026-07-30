import { WebSocketServer } from 'ws';

import { logger } from '../logger.js';

/**
 * Hub del WebSocket frontend↔backend (ruta `/ws`).
 *
 * Es el único punto por el que el backend empuja datos al frontend: mensajes de
 * chat normalizados (T-004), lista de usuarios presentes (T-007) e instrucciones
 * TTS (T-008). Las tareas siguientes usan `broadcast()`; no necesitan crear otro
 * servidor WebSocket.
 */
export function createWsHub(httpServer, { path = '/ws' } = {}) {
  const wss = new WebSocketServer({ server: httpServer, path });

  wss.on('connection', (socket) => {
    logger.info(`ws: cliente conectado (${wss.clients.size} activos)`);
    socket.on('close', () => {
      logger.info(`ws: cliente desconectado (${wss.clients.size} activos)`);
    });
    socket.on('error', (error) => {
      logger.error('ws: error de socket', error.message);
    });
  });

  /** Envía un mensaje JSON `{ type, payload }` a todos los clientes abiertos. */
  const broadcast = (type, payload) => {
    const frame = JSON.stringify({ type, payload });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(frame);
      }
    }
  };

  return {
    wss,
    broadcast,
    get clientCount() {
      return wss.clients.size;
    },
    /**
     * Cierra el hub. **`wss.close()` no cierra los sockets ya abiertos**: sin
     * este `terminate()` previo su callback nunca se llama y el apagado con
     * SIGTERM se cuelga mientras haya un navegador conectado (T-004 arregla el
     * defecto que detectaron T-005 y T-003).
     */
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => resolve());
      }),
  };
}
