/**
 * Sube o baja el contenedor de MeloTTS (`docker/melotts/`) desde los scripts de
 * npm de la raíz (`npm start` / `npm stop` / `npm run down`), sin que PM2 tenga
 * que saber de Docker.
 *
 *   node scripts/docker-melo.mjs up     # docker compose up --no-build -d melotts
 *   node scripts/docker-melo.mjs stop   # docker compose stop melotts (rápido de retomar)
 *   node scripts/docker-melo.mjs down   # docker compose down (lo saca del todo)
 *
 * MeloTTS es **opcional** (igual que Piper): si Docker no está instalado, no
 * está corriendo, la imagen no existe todavía, o el compose falla, este script
 * **nunca hace fallar ni cuelga** `npm start`/`stop`/`down` — solo avisa. El
 * backend igual arranca; las voces `melo:*` simplemente no aparecen hasta que
 * el contenedor esté arriba (ver `backend/src/tts/melo-engine.js`).
 *
 * Dos salvaguardas, las dos aprendidas de un incidente real (un `pip` colgado
 * ~90 minutos bajando decenas de versiones de `botocore` durante el build):
 *
 * 1. **`up` lleva `--no-build`.** Sin ese flag, `docker compose up -d` compila
 *    la imagen sola si todavía no existe — y eso puede tardar minutos u horas
 *    (como pasó), bloqueando `npm start` entero antes de que PM2 arranque
 *    nada. Con `--no-build`, si la imagen no está lista, el comando falla al
 *    toque y este script sigue de largo. Compilarla es un paso aparte y
 *    explícito: `docker compose build melotts`.
 * 2. **Timeout duro que mata el proceso.** Por si el propio `docker` se
 *    cuelga (daemon no responde, etc.), nada de esto puede tardar más que
 *    `TIMEOUT_MS`.
 *
 * Nada de comandos exclusivos de Unix: `spawn` con array de argumentos (no
 * `shell: true`), así funciona igual en macOS y en Windows 11.
 *
 * `TTS_MELO_ENABLED=false` en el `.env` desactiva el motor por completo
 * (`backend/src/tts/melo-engine.js`): este script respeta la misma bandera y,
 * si está apagada, ni siquiera intenta `docker compose up` — así una instalación
 * sin Docker (o que no quiere el contenedor arriba) no ve el aviso de "imagen
 * no encontrada" en cada `npm start`.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT_MS = 15_000;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Parser mínimo de `.env` (sin dependencias: este script corre desde la raíz,
 * donde no hay `node_modules/dotenv` instalado). Nunca pisa una variable que
 * ya esté en `process.env`, igual que `dotenv.config()` en `backend/src/config.js`.
 */
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

// Misma precedencia que `backend/src/config.js`: entorno del proceso > .env de
// la raíz > backend/.env.
loadEnvFile(path.join(repoRoot, '.env'));
loadEnvFile(path.join(repoRoot, 'backend', '.env'));

/** Misma regla que `isMeloEnabled()` de `backend/src/tts/melo-engine.js`. */
function isMeloEnabled() {
  const raw = process.env.TTS_MELO_ENABLED;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return true;
  }
  return !['false', '0', 'no'].includes(raw.trim().toLowerCase());
}

const ACTIONS = Object.freeze({
  up: ['compose', 'up', '--no-build', '-d', 'melotts'],
  stop: ['compose', 'stop', 'melotts'],
  down: ['compose', 'down'],
});

const MESSAGES = Object.freeze({
  up: {
    start: 'Levantando el contenedor de MeloTTS (docker compose up --no-build -d melotts)...',
    ok: 'MeloTTS: contenedor arriba (o ya lo estaba).',
    fail: 'MeloTTS: la imagen todavía no existe (o el contenedor no pudo levantar). Compilala una vez con `docker compose build melotts`.',
  },
  stop: {
    start: 'Deteniendo el contenedor de MeloTTS...',
    ok: 'MeloTTS: contenedor detenido.',
    fail: 'MeloTTS: no había contenedor que detener (o Docker no respondió).',
  },
  down: {
    start: 'Bajando el contenedor de MeloTTS...',
    ok: 'MeloTTS: contenedor removido.',
    fail: 'MeloTTS: no había nada que bajar (o Docker no respondió).',
  },
});

const action = process.argv[2];
if (!Object.hasOwn(ACTIONS, action)) {
  console.error(`Uso: node scripts/docker-melo.mjs <${Object.keys(ACTIONS).join('|')}>`);
  process.exit(1);
}

// Solo se frena `up`: `stop`/`down` deben poder limpiar un contenedor que haya
// quedado arriba de antes de apagar la bandera, aunque MeloTTS esté deshabilitado.
if (action === 'up' && !isMeloEnabled()) {
  console.log('MeloTTS: TTS_MELO_ENABLED=false en el .env; se omite `docker compose up` (motor deshabilitado).');
  process.exit(0);
}

const { start, ok, fail } = MESSAGES[action];
console.log(start);

const child = spawn('docker', ACTIONS[action], { stdio: 'inherit', windowsHide: true });

let settled = false;
const finish = (message) => {
  if (settled) {
    return;
  }
  settled = true;
  clearTimeout(timer);
  console.log(message);
  // Nunca se propaga el fallo: MeloTTS es opcional, no debe tumbar start/stop/down.
  process.exit(0);
};

// Sin esto, un `docker` que se cuelga (daemon no responde) colgaría `npm start`
// entero con él — justo lo que este script existe para evitar.
const timer = setTimeout(() => {
  child.kill('SIGKILL');
  finish(`MeloTTS: docker no respondió en ${TIMEOUT_MS} ms; se omite (es opcional).`);
}, TIMEOUT_MS);

child.on('error', () => finish('MeloTTS: Docker no está instalado o no se encontró en el PATH; se omite (es opcional).'));
child.on('close', (code) => finish(code === 0 ? ok : fail));
