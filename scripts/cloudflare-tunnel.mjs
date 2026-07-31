/**
 * Sube o baja el túnel de Cloudflare hacia `viewer/server.js` (T-016, salida
 * alternativa al port-forward: el router de este streamer tiene un bug de
 * firmware que solo aplica la primera regla de NAT, ver
 * `docs/exec-plans/active/configura-mi-voz.md`).
 *
 *   node scripts/cloudflare-tunnel.mjs up     # levanta el túnel, imprime la URL, la guarda en .env
 *   node scripts/cloudflare-tunnel.mjs stop   # lo baja
 *
 * Es un "quick tunnel" (sin cuenta de Cloudflare): la URL
 * `https://algo-random.trycloudflare.com` **cambia cada vez que se levanta**.
 * Por eso este script, cada vez que corre `up`:
 *
 * 1. Levanta `cloudflared` apuntado a `http://localhost:VIEWER_SERVICE_PORT`
 *    (el túnel hace su propio HTTPS público; `viewer/server.js` puede quedar
 *    en HTTP plano — `VIEWER_HTTPS=false`).
 * 2. Espera a que `cloudflared` imprima la URL asignada.
 * 3. La imprime bien grande en la consola — **el streamer tiene que copiarla a
 *    mano en "OAuth Redirect URLs" de dev.twitch.tv**, eso no se puede
 *    automatizar (login de Twitch).
 * 4. La escribe en `VIEWER_SERVICE_PUBLIC_URL` y `TWITCH_VIEWER_REDIRECT_URI`
 *    del `.env` de la raíz, así que hay que correr esto **antes** de levantar
 *    `viewer`/`backend` (los leen una sola vez al arrancar). `npm start` ya
 *    respeta ese orden.
 * 5. Deja el proceso de `cloudflared` corriendo *detached* (sobrevive a que
 *    este script termine) y guarda su PID en `scripts/.cloudflared.pid` para
 *    que `stop` lo pueda encontrar y matar.
 *
 * Igual que `docker-melo.mjs`: opcional, nunca cuelga ni hace fallar
 * `npm start`/`stop` — si `cloudflared` no está instalado o algo falla, avisa
 * y sigue de largo (el sistema funciona igual en tu red local).
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

async function up() {
  const viewerPort = process.env.VIEWER_SERVICE_PORT ?? '3100';
  const bin = findCloudflared();

  console.log(`cloudflare-tunnel: levantando túnel hacia http://localhost:${viewerPort}...`);

  // stdout/stderr van a un file descriptor real (no un pipe de Node): así el
  // hijo queda de verdad desacoplado del padre y este script puede terminar
  // solo sin que un stream todavía "leído" lo mantenga vivo. Se lee el
  // resultado con un poll sobre el archivo, no escuchando el stream.
  mkdirSync(path.dirname(logFile), { recursive: true });
  const logFd = openSync(logFile, 'w');

  const child = spawn(bin, ['tunnel', '--url', `http://localhost:${viewerPort}`], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  closeSync(logFd); // el hijo ya tiene su propio duplicado del fd; este proceso no lo necesita.

  let spawnError = null;
  child.on('error', (error) => {
    spawnError = error;
  });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function pollForUrl() {
    const deadline = Date.now() + URL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (spawnError) {
        return { error: spawnError };
      }
      let content = '';
      try {
        content = readFileSync(logFile, 'utf8');
      } catch {
        // el archivo puede no existir todavía en el primer instante.
      }
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(content);
      if (match) {
        return { url: match[0] };
      }
      await sleep(300);
    }
    return { url: null };
  }

  const { url: tunnelUrl, error } = await pollForUrl();

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

  const banner = '='.repeat(78);
  console.log(`\n${banner}`);
  console.log('  TÚNEL PÚBLICO LISTO — copiá esta URL en dev.twitch.tv:');
  console.log(`\n  ${tunnelUrl}/viewer-auth/callback\n`);
  console.log('  (dev.twitch.tv/console → tu app → "OAuth Redirect URLs" → agregar, SIN borrar la del bot)');
  console.log(banner + '\n');
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
