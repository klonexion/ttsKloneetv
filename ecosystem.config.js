/**
 * Configuración de PM2 para el monorepo (misma en macOS y Windows 11).
 *
 * Convenciones a respetar por las tareas siguientes:
 * - Un proceso por paquete: `tts-backend` (Express + ws, admin, solo
 *   localhost), `tts-frontend` (Vite) y `tts-viewer` (T-015: el único proceso
 *   pensado para exponerse a internet — login de viewer + pantalla de
 *   "!configura-mi-voz", ver `docs/exec-plans/active/configura-mi-voz.md`).
 * - `tts-duckdns` (T-016): mantiene `DUCKDNS_DOMAIN.duckdns.org` apuntando a
 *   tu IP pública. Opcional — sin `DUCKDNS_DOMAIN`/`DUCKDNS_TOKEN` en `.env`
 *   loguea una vez y queda inactivo, no hace falta para desarrollar.
 * - Se invoca siempre el entrypoint de Node directamente (nunca `npm run ...`)
 *   para que PM2 no necesite un intérprete de shell: eso rompe en Windows.
 * - Rutas construidas con `path.join(__dirname, ...)`: sin rutas POSIX hardcodeadas.
 * - Los logs viven en `logs/` (git-ignorado).
 */
const path = require('node:path');

const root = __dirname;
const logsDir = path.join(root, 'logs');

module.exports = {
  apps: [
    {
      name: 'tts-backend',
      cwd: path.join(root, 'backend'),
      script: path.join('src', 'server.js'),
      interpreter: 'node',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: 'development',
      },
      out_file: path.join(logsDir, 'backend-out.log'),
      error_file: path.join(logsDir, 'backend-error.log'),
      merge_logs: true,
      time: true,
    },
    {
      name: 'tts-frontend',
      cwd: path.join(root, 'frontend'),
      // Entrypoint JS de Vite: multiplataforma, no depende del binario .cmd/.sh.
      script: path.join('node_modules', 'vite', 'bin', 'vite.js'),
      args: ['--port', '5173', '--strictPort'],
      interpreter: 'node',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: 'development',
      },
      out_file: path.join(logsDir, 'frontend-out.log'),
      error_file: path.join(logsDir, 'frontend-error.log'),
      merge_logs: true,
      time: true,
    },
    {
      name: 'tts-viewer',
      cwd: path.join(root, 'viewer'),
      script: 'server.js',
      interpreter: 'node',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: 'development',
      },
      out_file: path.join(logsDir, 'viewer-out.log'),
      error_file: path.join(logsDir, 'viewer-error.log'),
      merge_logs: true,
      time: true,
    },
    {
      name: 'tts-duckdns',
      cwd: root,
      script: path.join('scripts', 'duckdns-update.mjs'),
      interpreter: 'node',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: 'development',
      },
      out_file: path.join(logsDir, 'duckdns-out.log'),
      error_file: path.join(logsDir, 'duckdns-error.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
