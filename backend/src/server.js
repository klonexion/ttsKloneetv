import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

import { createApp } from './app.js';
import { startTokenRefreshLoop, stopTokenRefreshLoop } from './auth/session.js';
import { createChatRelay } from './chat/relay.js';
import { assertConfig, config } from './config.js';
import { closeDatabase, initDatabase } from './db/index.js';
import { logger } from './logger.js';
import { createUsersPresence } from './users/presence.js';
import { createWsHub } from './ws/hub.js';

// Sin las variables requeridas no hay nada que arrancar: fallar temprano con un
// mensaje que nombre lo que falta (nunca imprimir valores de secretos).
try {
  assertConfig();
} catch (error) {
  logger.error(error.message);
  process.exit(1);
}

initDatabase();

const app = createApp();

/**
 * Servidor HTTP o HTTPS según `HTTPS`. Twitch exige `https` en los redirect URI,
 * así que en uso real se sirve con un certificado local (`mkcert`, ver README);
 * en HTTP plano —el default— nada de esto se toca.
 *
 * Si el certificado no está donde dice la configuración, fallar acá con un
 * mensaje que nombre la ruta es mucho más claro que arrancar en HTTP y que el
 * `redirect_uri` deje de coincidir mucho más tarde, ya en el navegador.
 */
const createServer = () => {
  if (!config.https.enabled) {
    return http.createServer(app);
  }

  const { certFile, keyFile } = config.https;
  for (const [label, file] of [
    ['certificado', certFile],
    ['clave', keyFile],
  ]) {
    if (!fs.existsSync(file)) {
      logger.error(
        `HTTPS=true pero no existe el ${label} en ${file}. ` +
          'Generalo con `mkcert localhost 127.0.0.1 ::1` dentro de `certs/` (ver README) ' +
          'o apuntá TLS_CERT_FILE / TLS_KEY_FILE a los tuyos.',
      );
      process.exit(1);
    }
  }

  return https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, app);
};

const server = createServer();
const wsHub = createWsHub(server, { path: config.wsPath });

server.listen(config.port, () => {
  const wsScheme = config.https.enabled ? 'wss' : 'ws';
  logger.info(`backend escuchando en ${config.scheme}://localhost:${config.port}`);
  logger.info(`websocket en ${wsScheme}://localhost:${config.port}${config.wsPath}`);
});

// Mantiene vivo el access token de Twitch sin intervención del usuario: revisa
// la expiración cada `TWITCH_TOKEN_CHECK_INTERVAL_MS` y refresca por adelantado.
startTokenRefreshLoop();

// Lee el chat por EventSub y lo retransmite por el hub. Se conecta en cuanto hay
// sesión (y se detiene si se pierde), así que no depende del orden de arranque.
const chatRelay = createChatRelay({ hub: wsHub });
chatRelay.start();

// Columna de usuarios híbrida: presentes por Get Chatters (~60 s) + los autores
// de los mensajes que pasan por el relay, publicados como `users:list`.
const usersPresence = createUsersPresence({ hub: wsHub, relay: chatRelay });
usersPresence.start();

const shutdown = (signal) => {
  logger.info(`recibido ${signal}, cerrando backend`);
  stopTokenRefreshLoop();
  chatRelay.stop();
  usersPresence.stop();

  // Red de seguridad: si algo se resiste a cerrarse, no dejar el proceso colgado
  // (PM2 y el gate de integración exigen que `stop` termine de verdad).
  const forceExit = setTimeout(() => {
    logger.warn('cierre forzado: algo no terminó a tiempo');
    process.exit(0);
  }, 5_000);
  forceExit.unref?.();

  wsHub.close().finally(() => {
    // `server.close()` solo deja de aceptar conexiones nuevas: espera a que las
    // abiertas terminen. Las keep-alive del proxy de Vite no terminan solas, así
    // que hay que cerrarlas (los WebSocket ya los cerró el hub).
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    server.close(() => {
      clearTimeout(forceExit);
      closeDatabase();
      process.exit(0);
    });
  });
};

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal));
}
