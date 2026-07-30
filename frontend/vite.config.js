import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import vue from '@vitejs/plugin-vue';
import { defineConfig, loadEnv } from 'vite';

/** Raíz del repo, un nivel por encima de `frontend/`. */
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * TLS opcional, controlado por la misma bandera `HTTPS` que el backend (Twitch
 * exige `https` en los redirect URI). Devuelve `undefined` si está apagada o si
 * los certificados no están, para que el dev server siga en HTTP plano en vez
 * de reventar.
 */
const readTls = (env) => {
  if (!['true', '1', 'yes'].includes(String(env.HTTPS ?? '').toLowerCase())) {
    return undefined;
  }

  const certFile = env.TLS_CERT_FILE ?? path.join(repoRoot, 'certs', 'localhost.pem');
  const keyFile = env.TLS_KEY_FILE ?? path.join(repoRoot, 'certs', 'localhost-key.pem');
  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    console.warn(`[vite] HTTPS=true pero faltan los certificados (${certFile}); sirviendo en HTTP.`);
    return undefined;
  }

  return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
};

/**
 * Config de Vite. El dev server corre en 5173 y proxya al backend (3000) para
 * que el frontend use siempre rutas relativas (`/api/...`, `/auth/...`, `/ws`)
 * y no haya CORS ni orígenes hardcodeados en el código de la app.
 *
 * Los puertos se pueden mover con `FRONTEND_PORT` / `BACKEND_PORT` (por ejemplo
 * para levantar dos copias en paralelo sin chocar); los defaults son los de
 * siempre, así que `npm run dev` no cambia.
 *
 * Esos dos valores se leen del `.env` de la RAÍZ del repo —el mismo archivo que
 * usa el backend, para no tener la configuración partida en dos— con el prefijo
 * vacío en `loadEnv` porque no son variables `VITE_*` (no se exponen al cliente,
 * solo las usa este archivo). El entorno del proceso gana sobre el archivo.
 */
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, repoRoot, ''), ...process.env };
  const tls = readTls(env);
  const scheme = tls ? 'https' : 'http';
  const backendPort = env.BACKEND_PORT ?? '3000';
  const backendOrigin = `${scheme}://localhost:${backendPort}`;
  const devPort = Number.parseInt(env.FRONTEND_PORT ?? '5173', 10);

  // Con HTTPS el backend usa el mismo certificado local. `secure: false` evita
  // que el proxy rechace esa cadena por no venir de una CA pública: la conexión
  // sigue cifrada, solo no se valida el emisor (es localhost contra sí mismo).
  const proxyTarget = { target: backendOrigin, changeOrigin: true, secure: false };

  return {
    plugins: [vue()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      port: devPort,
      strictPort: true,
      ...(tls ? { https: tls } : {}),
      proxy: {
        '/api': proxyTarget,
        '/auth': proxyTarget,
        '/ws': { ...proxyTarget, ws: true },
      },
    },
  };
});
