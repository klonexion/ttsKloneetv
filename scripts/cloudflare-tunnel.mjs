/**
 * Sube o baja el túnel de Cloudflare hacia `viewer/server.js` (T-016, salida
 * alternativa al port-forward: el router de este streamer tiene un bug de
 * firmware que solo aplica la primera regla de NAT, ver
 * `docs/exec-plans/active/configura-mi-voz.md`).
 *
 *   node scripts/cloudflare-tunnel.mjs up     # levanta el túnel, imprime la URL, la guarda en .env
 *   node scripts/cloudflare-tunnel.mjs stop   # lo baja
 *
 * Dos modos, elegidos por si `.env` tiene `CLOUDFLARE_TUNNEL_NAME` +
 * `CLOUDFLARE_TUNNEL_HOSTNAME`:
 *
 * - **Con nombre fijo** (recomendado si tenés un dominio propio, ver más abajo
 *   "Cómo se armó"): `cloudflared tunnel run <nombre>`, usando el
 *   `~/.cloudflared/config.yml` que ya tiene el tunnel id, las credenciales y
 *   el ingress hacia `http://localhost:VIEWER_SERVICE_PORT`. El hostname es
 *   **fijo** — no cambia nunca, así que el redirect URI de Twitch se
 *   registra una sola vez, para siempre.
 * - **Quick tunnel** (default si no configuraste lo anterior, no necesita
 *   cuenta de Cloudflare): `cloudflared tunnel --url http://localhost:PORT`.
 *   La URL `https://algo-random.trycloudflare.com` **cambia cada vez que se
 *   levanta**, así que hay que re-registrarla en Twitch cada reinicio.
 *
 * En los dos casos, `up`:
 *
 * 1. Levanta `cloudflared` (el túnel hace su propio HTTPS público;
 *    `viewer/server.js` puede quedar en HTTP plano — `VIEWER_HTTPS=false`).
 * 2. Consigue la URL (fija, o la recién asignada en modo quick tunnel) y la
 *    imprime bien grande en la consola — **el streamer tiene que copiarla a
 *    mano en "OAuth Redirect URLs" de dev.twitch.tv** la primera vez (con
 *    nombre fijo, no hace falta repetirlo nunca más).
 * 3. La escribe en `VIEWER_SERVICE_PUBLIC_URL` y `TWITCH_VIEWER_REDIRECT_URI`
 *    del `.env` de la raíz, así que hay que correr esto **antes** de levantar
 *    `viewer`/`backend` (los leen una sola vez al arrancar). `npm start` ya
 *    respeta ese orden.
 * 4. Deja el proceso de `cloudflared` corriendo *detached* (sobrevive a que
 *    este script termine) y guarda su PID en `scripts/.cloudflared.pid` para
 *    que `stop` lo pueda encontrar y matar.
 *
 * Igual que `docker-melo.mjs`: opcional, nunca cuelga ni hace fallar
 * `npm start`/`stop` — si `cloudflared` no está instalado o algo falla, avisa
 * y sigue de largo (el sistema funciona igual en tu red local).
 *
 * ## Cómo se armó el túnel con nombre fijo (una sola vez, manual)
 *
 * 1. Dominio propio con DNS delegado a Cloudflare (gratis).
 * 2. `cloudflared tunnel login` (abre el navegador, autoriza con la cuenta de
 *    Cloudflare — pasos que solo puede hacer el streamer).
 * 3. `cloudflared tunnel create <nombre>` → guarda credenciales en
 *    `~/.cloudflared/<tunnel-id>.json` y da el tunnel id.
 * 4. `cloudflared tunnel route dns <nombre> <hostname>` → crea el CNAME.
 * 5. `~/.cloudflared/config.yml`:
 *    ```yaml
 *    tunnel: <tunnel-id>
 *    credentials-file: <ruta al .json de arriba>
 *    ingress:
 *      - hostname: <hostname>
 *        service: http://localhost:<VIEWER_SERVICE_PORT>
 *      - service: http_status:404
 *    ```
 * 6. `.env`: `CLOUDFLARE_TUNNEL_NAME=<nombre>` y
 *    `CLOUDFLARE_TUNNEL_HOSTNAME=<hostname>`.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(repoRoot, '.env');
const pidFile = path.join(repoRoot, 'scripts', '.cloudflared.pid');
const logFile = path.join(repoRoot, 'logs', 'cloudflared.log');

const URL_TIMEOUT_MS = 20_000;

/** Mismo parser mínimo de `.env` que `docker-melo.mjs`/`duckdns-update.mjs`. */
function loadEnvFile(file) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const match = /^([\w.-]+)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = rawValue.trim().replace(/^['"]|['"]$/g, '');
  }
}

loadEnvFile(envFile);

/** Reescribe (o agrega) `KEY=valor` en el `.env` de la raíz, sin tocar el resto del archivo. */
function setEnvVar(key, value) {
  let content = '';
  try {
    content = readFileSync(envFile, 'utf8');
  } catch {
    // sin .env todavía: se crea con solo esta línea (caso raro, no bloquea).
  }
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  content = pattern.test(content) ? content.replace(pattern, line) : `${content}\n${line}\n`;
  writeFileSync(envFile, content);
}

function findCloudflared() {
  if (process.env.CLOUDFLARED_BIN) {
    return process.env.CLOUDFLARED_BIN;
  }
  // Rutas típicas de `winget install Cloudflare.cloudflared`: no siempre quedan
  // en el PATH de una terminal ya abierta al momento de instalar.
  const knownPaths = [
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
  ];
  return knownPaths.find((p) => existsSync(p)) ?? 'cloudflared'; // último recurso: confiar en el PATH
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Levanta `cloudflared` con los argumentos dados, stdout/stderr a un file
 * descriptor real (no un pipe de Node): así el hijo queda de verdad
 * desacoplado del padre y este script puede terminar solo sin que un stream
 * todavía "leído" lo mantenga vivo.
 */
function spawnCloudflared(args) {
  mkdirSync(path.dirname(logFile), { recursive: true });
  const logFd = openSync(logFile, 'w');
  const child = spawn(findCloudflared(), args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  closeSync(logFd); // el hijo ya tiene su propio duplicado del fd; este proceso no lo necesita.

  let spawnError = null;
  child.on('error', (error) => {
    spawnError = error;
  });
  return { child, getSpawnError: () => spawnError };
}

/** Poll sobre `logFile` hasta que `isReady(contenido)` sea `true` o venza el timeout. */
async function waitForLog(getSpawnError, isReady, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const spawnError = getSpawnError();
    if (spawnError) {
      return { error: spawnError };
    }
    let content = '';
    try {
      content = readFileSync(logFile, 'utf8');
    } catch {
      // el archivo puede no existir todavía en el primer instante.
    }
    if (isReady(content)) {
      return { ready: true };
    }
    await sleep(300);
  }
  return { ready: false };
}

function printBanner(redirectUri, { firstTime }) {
  const banner = '='.repeat(78);
  console.log(`\n${banner}`);
  console.log(
    firstTime
      ? '  TÚNEL PÚBLICO LISTO — copiá esta URL en dev.twitch.tv:'
      : '  TÚNEL PÚBLICO LISTO (hostname fijo, ya no hace falta re-registrar):',
  );
  console.log(`\n  ${redirectUri}\n`);
  if (firstTime) {
    console.log('  (dev.twitch.tv/console → tu app → "OAuth Redirect URLs" → agregar, SIN borrar la del bot)');
  }
  console.log(banner + '\n');
}

async function upNamedTunnel(name, hostname) {
  console.log(`cloudflare-tunnel: levantando el túnel con nombre fijo "${name}" (${hostname})...`);

  const { child, getSpawnError } = spawnCloudflared(['tunnel', 'run', name]);
  // Con nombre fijo no hay URL que leer del log: alcanza con confirmar que
  // registró al menos una conexión, o que no falló al arrancar.
  const { error, ready } = await waitForLog(
    getSpawnError,
    (content) => /Registered tunnel connection/.test(content),
    URL_TIMEOUT_MS,
  );

  if (error) {
    console.error(`cloudflare-tunnel: no se pudo iniciar cloudflared (${error.message}); se omite (es opcional).`);
    process.exitCode = 0;
    return;
  }
  if (!ready) {
    console.error(`cloudflare-tunnel: el túnel no confirmó conexión en ${URL_TIMEOUT_MS} ms; revisá ${logFile}.`);
    child.kill();
    process.exitCode = 0;
    return;
  }

  child.unref();
  writeFileSync(pidFile, String(child.pid));

  const publicUrl = `https://${hostname}`;
  setEnvVar('VIEWER_SERVICE_PUBLIC_URL', publicUrl);
  setEnvVar('TWITCH_VIEWER_REDIRECT_URI', `${publicUrl}/viewer-auth/callback`);
  printBanner(`${publicUrl}/viewer-auth/callback`, { firstTime: false });
}

async function upQuickTunnel() {
  const viewerPort = process.env.VIEWER_SERVICE_PORT ?? '3100';
  console.log(`cloudflare-tunnel: levantando quick tunnel hacia http://localhost:${viewerPort}...`);

  const { child, getSpawnError } = spawnCloudflared(['tunnel', '--url', `http://localhost:${viewerPort}`]);

  let tunnelUrl = null;
  const { error } = await waitForLog(
    getSpawnError,
    (content) => {
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(content);
      if (match) {
        tunnelUrl = match[0];
      }
      return match !== null;
    },
    URL_TIMEOUT_MS,
  );

  if (error) {
    console.error(`cloudflare-tunnel: no se pudo iniciar cloudflared (${error.message}); se omite (es opcional).`);
    process.exitCode = 0;
    return;
  }
  if (!tunnelUrl) {
    console.error(
      `cloudflare-tunnel: no se pudo leer la URL en ${URL_TIMEOUT_MS} ms; revisá ${logFile}. Se omite (es opcional).`,
    );
    child.kill();
    process.exitCode = 0;
    return;
  }

  child.unref();
  writeFileSync(pidFile, String(child.pid));

  setEnvVar('VIEWER_SERVICE_PUBLIC_URL', tunnelUrl);
  setEnvVar('TWITCH_VIEWER_REDIRECT_URI', `${tunnelUrl}/viewer-auth/callback`);
  printBanner(`${tunnelUrl}/viewer-auth/callback`, { firstTime: true });
}

async function up() {
  const tunnelName = process.env.CLOUDFLARE_TUNNEL_NAME;
  const tunnelHostname = process.env.CLOUDFLARE_TUNNEL_HOSTNAME;

  if (tunnelName && tunnelHostname) {
    await upNamedTunnel(tunnelName, tunnelHostname);
  } else {
    await upQuickTunnel();
  }
}

function stop() {
  if (!existsSync(pidFile)) {
    console.log('cloudflare-tunnel: no había túnel corriendo (o no lo levantó este script).');
    return;
  }
  const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
  try {
    process.kill(pid);
    console.log(`cloudflare-tunnel: túnel detenido (PID ${pid}).`);
  } catch {
    console.log('cloudflare-tunnel: el proceso ya no existía.');
  }
  try {
    writeFileSync(pidFile, '');
  } catch {
    // no crítico
  }
}

const action = process.argv[2];
if (action === 'up') {
  await up();
} else if (action === 'stop' || action === 'down') {
  stop();
} else {
  console.error('Uso: node scripts/cloudflare-tunnel.mjs <up|stop>');
  process.exit(1);
}
