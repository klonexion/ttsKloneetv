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
 */
import { spawn } from 'node:child_process';

const TIMEOUT_MS = 15_000;

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
