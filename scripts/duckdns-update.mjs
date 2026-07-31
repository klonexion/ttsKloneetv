/**
 * Actualizador de DuckDNS (T-016): un ping a
 * `https://www.duckdns.org/update` cada DUCKDNS_UPDATE_INTERVAL_MS (default 5
 * min) para que `DUCKDNS_DOMAIN.duckdns.org` siga apuntando a tu IP pública
 * aunque cambie (típico al reiniciar el router). No hace falta que este
 * script sepa cuál es tu IP: sin el parámetro `ip=`, DuckDNS toma la IP de
 * quien hace la petición.
 *
 * Corre como proceso de PM2 (`tts-duckdns` en `ecosystem.config.js`), igual
 * que el resto del sistema.
 *
 *   node scripts/duckdns-update.mjs
 *
 * Opcional a propósito (mismo criterio que `docker-melo.mjs`): sin
 * `DUCKDNS_DOMAIN`/`DUCKDNS_TOKEN` en el `.env`, este proceso loguea una vez y
 * queda inactivo — no hace falta DuckDNS para desarrollar ni para usar el
 * resto del sistema en tu red local.
 *
 * El token NUNCA se loguea ni aparece en ningún mensaje de error.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Mismo parser mínimo de `.env` que `docker-melo.mjs` (sin dependencias). */
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

loadEnvFile(path.join(repoRoot, '.env'));

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/** Acepta tanto `kloneetv` como `kloneetv.duckdns.org` en DUCKDNS_DOMAIN. */
const rawDomain = process.env.DUCKDNS_DOMAIN;
const domain = rawDomain ? rawDomain.replace(/\.duckdns\.org$/i, '') : null;
const token = process.env.DUCKDNS_TOKEN;
const intervalMs = Number.parseInt(process.env.DUCKDNS_UPDATE_INTERVAL_MS ?? String(DEFAULT_INTERVAL_MS), 10);

if (!domain || !token) {
  console.log('duckdns: DUCKDNS_DOMAIN/DUCKDNS_TOKEN no configurados; el actualizador queda inactivo (opcional).');
  process.exit(0);
}

async function update() {
  const url = `https://www.duckdns.org/update?domains=${encodeURIComponent(domain)}&token=${encodeURIComponent(token)}`;
  try {
    const response = await fetch(url);
    const body = (await response.text()).trim();
    if (body.startsWith('OK')) {
      console.log(`duckdns: ${domain}.duckdns.org actualizado (${new Date().toISOString()})`);
    } else {
      // El cuerpo de un fallo es literalmente "KO": no trae nada sensible.
      console.error(`duckdns: DuckDNS respondió "${body}" — revisá DUCKDNS_DOMAIN/DUCKDNS_TOKEN en .env`);
    }
  } catch (error) {
    console.error(`duckdns: no se pudo contactar duckdns.org (${error.message})`);
  }
}

await update();
setInterval(update, intervalMs);

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => process.exit(0));
}
