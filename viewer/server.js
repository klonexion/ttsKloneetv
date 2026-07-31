/**
 * Servicio público de viewers (T-015): el único proceso pensado para
 * exponerse a internet. Sirve el login de viewer (`backend/src/auth/
 * viewer-router.js`, T-014) y la pantalla de "!configura-mi-voz"
 * (`./public/`), con su propio puerto y sin ninguna de las rutas del backend
 * admin (moderación, enviar chat como el streamer, ajustes) — ese backend
 * sigue escuchando solo en `localhost`, sin cambios.
 *
 * Importa directamente módulos de `backend/src/` (mismo repo, sin
 * workspaces): una sola fuente de verdad para el esquema SQLite y las reglas
 * de negocio, en vez de duplicarlas. La base es la misma que usa el backend
 * admin (WAL activado, así que dos procesos leyendo/escribiendo a la vez es
 * seguro).
 *
 *     node viewer/server.js
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { config } from '../backend/src/config.js';
import { createViewerAuthRouter } from '../backend/src/auth/viewer-router.js';
import { initDatabase } from '../backend/src/db/index.js';
import { logger } from '../backend/src/logger.js';
import { createViewerPreferencesRouter } from './preferences-router.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

export function createViewerApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/viewer-auth', createViewerAuthRouter());
  app.use('/viewer', createViewerPreferencesRouter());

  // Página estática al final: si algo bajo /viewer-auth o /viewer no matchea
  // una ruta, que sea un 404 de esos routers, no el index.html.
  app.use(express.static(publicDir));

  return app;
}

/**
 * Servidor HTTP o HTTPS según `VIEWER_HTTPS` — certificado real (Let's
 * Encrypt vía win-acme) para el hostname público, no el `mkcert` local del
 * backend admin. Mismo criterio que `backend/src/server.js`: si el
 * certificado no está donde dice la config, falla temprano con un mensaje
 * claro en vez de arrancar en HTTP silenciosamente.
 */
function createServer(app) {
  const { enabled, certFile, keyFile } = config.viewerService.https;
  if (!enabled) {
    return http.createServer(app);
  }

  for (const [label, file] of [
    ['certificado', certFile],
    ['clave', keyFile],
  ]) {
    if (!fs.existsSync(file)) {
      logger.error(
        `VIEWER_HTTPS=true pero no existe el ${label} en ${file}. ` +
          'Generalo con win-acme para tu hostname de DuckDNS (ver docs/exec-plans/active/configura-mi-voz.md) ' +
          'o apuntá VIEWER_TLS_CERT_FILE / VIEWER_TLS_KEY_FILE a los tuyos.',
      );
      process.exit(1);
    }
  }

  return https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, app);
}

initDatabase();
const app = createViewerApp();
const server = createServer(app);

server.listen(config.viewerService.port, () => {
  const scheme = config.viewerService.https.enabled ? 'https' : 'http';
  logger.info(`viewer: escuchando en ${scheme}://localhost:${config.viewerService.port}`);
  logger.info(`viewer: URL pública configurada: ${config.viewerService.publicUrl}`);
});

// Igual de simple que el resto de scripts del proyecto (no hay WebSockets
// acá que puedan colgar el cierre, así que no hace falta el
// terminate()+closeAllConnections() que sí necesita backend/src/server.js).
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    logger.info(`viewer: recibido ${signal}, cerrando`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
