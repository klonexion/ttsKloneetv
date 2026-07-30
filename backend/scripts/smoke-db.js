/**
 * Pruebas de humo de la capa de datos (T-002). Ejercitan de verdad la migración
 * idempotente, las tres tablas (`tokens`, `users`, `app_settings`) —incluido el
 * upsert de `users` por `twitch_user_id`— y la validación de configuración.
 *
 *   npm --prefix backend run test:db
 *
 * Trabaja siempre sobre una base temporal en el directorio temporal del SO:
 * nunca toca `backend/data/app.sqlite` ni necesita `.env`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { backendRoot, findMissingEnvVars } from '../src/config.js';
import { DEFAULT_SETTINGS, createRepositories, listTables, migrate, openDatabase } from '../src/db/index.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-hub-db-'));
const dbFile = path.join(tempDir, 'smoke.sqlite');

let failures = 0;
let checks = 0;

const section = (title) => console.log(`\n${title}`);

const check = (label, fn) => {
  checks += 1;
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${label}`);
    console.error(`       ${error.message.split('\n').join('\n       ')}`);
  }
};

let db = openDatabase(dbFile);
let repos = createRepositories(db);

try {
  section('esquema y migración');

  check('crea las tres tablas del esquema', () => {
    const tables = listTables(db);
    for (const table of ['tokens', 'users', 'app_settings']) {
      assert.ok(tables.includes(table), `falta la tabla ${table} (hay: ${tables.join(', ')})`);
    }
  });

  check('siembra la voz global default edge:es-MX-DaliaNeural', () => {
    assert.equal(repos.settings.getGlobalVoiceId(), 'edge:es-MX-DaliaNeural');
    assert.equal(DEFAULT_SETTINGS.global_voice_id, 'edge:es-MX-DaliaNeural');
  });

  check('siembra el tema dark', () => {
    assert.equal(repos.settings.getTheme(), 'dark');
  });

  check('re-migrar es idempotente (mismas tablas, mismos ajustes)', () => {
    const tablesBefore = listTables(db);
    const settingsBefore = repos.settings.all();
    migrate(db);
    migrate(db);
    assert.deepEqual(listTables(db), tablesBefore);
    assert.deepEqual(repos.settings.all(), settingsBefore);
  });

  check('la resiembra no pisa un ajuste ya modificado', () => {
    repos.settings.set('theme', 'light');
    migrate(db);
    assert.equal(repos.settings.getTheme(), 'light');
    repos.settings.set('theme', 'dark');
  });

  check('reabrir el mismo archivo conserva tablas y datos', () => {
    repos.settings.set('smoke_marker', 'presente');
    db.close();
    db = openDatabase(dbFile);
    repos = createRepositories(db);
    const tables = listTables(db);
    for (const table of ['tokens', 'users', 'app_settings']) {
      assert.ok(tables.includes(table), `falta la tabla ${table} tras reabrir`);
    }
    assert.equal(repos.settings.get('smoke_marker'), 'presente');
    assert.equal(repos.settings.getTheme(), 'dark');
  });

  section('app_settings');

  check('set / get / all / delete', () => {
    repos.settings.set('master_volume', '0.8');
    assert.equal(repos.settings.get('master_volume'), '0.8');
    assert.equal(repos.settings.all().master_volume, '0.8');
    assert.equal(repos.settings.delete('master_volume'), true);
    assert.equal(repos.settings.get('master_volume'), null);
    assert.equal(repos.settings.get('master_volume', '1'), '1');
  });

  check('setAll escribe varias claves en una transacción', () => {
    repos.settings.setAll({ theme: 'light', global_voice_id: 'edge:es-ES-ElviraNeural' });
    assert.equal(repos.settings.getTheme(), 'light');
    assert.equal(repos.settings.getGlobalVoiceId(), 'edge:es-ES-ElviraNeural');
    repos.settings.setAll(DEFAULT_SETTINGS);
    assert.equal(repos.settings.getTheme(), 'dark');
  });

  section('tokens');

  check('get sin sesión guardada devuelve null', () => {
    assert.equal(repos.tokens.get(), null);
  });

  check('save persiste access/refresh/expiración/scopes', () => {
    const saved = repos.tokens.save({
      accessToken: 'dummy-access-1',
      refreshToken: 'dummy-refresh-1',
      expiresAt: 1000,
      scopes: ['user:read:chat', 'user:write:chat'],
    });
    assert.equal(saved.provider, 'twitch');
    assert.equal(saved.accessToken, 'dummy-access-1');
    assert.equal(saved.refreshToken, 'dummy-refresh-1');
    assert.equal(saved.expiresAt, 1000);
    assert.deepEqual(saved.scopes, ['user:read:chat', 'user:write:chat']);
  });

  check('un refresh actualiza la misma fila del proveedor', () => {
    repos.tokens.save({
      accessToken: 'dummy-access-2',
      refreshToken: 'dummy-refresh-2',
      expiresAt: 2000,
      scopes: 'user:read:chat',
    });
    assert.equal(repos.tokens.list().length, 1);
    const current = repos.tokens.get('twitch');
    assert.equal(current.accessToken, 'dummy-access-2');
    assert.equal(current.expiresAt, 2000);
    assert.deepEqual(current.scopes, ['user:read:chat']);
  });

  check('delete borra la sesión', () => {
    assert.equal(repos.tokens.delete(), true);
    assert.equal(repos.tokens.get(), null);
    assert.equal(repos.tokens.delete(), false);
  });

  section('users');

  const alice = { twitchUserId: '111', username: 'alice', displayName: 'Alice' };
  const t0 = Date.now() - 60_000;

  check('upsert crea un usuario nuevo con los defaults del esquema', () => {
    const user = repos.users.upsert({ ...alice, pitch: 1.23, timestamp: t0 });
    assert.equal(user.twitchUserId, '111');
    assert.equal(user.username, 'alice');
    assert.equal(user.displayName, 'Alice');
    assert.equal(user.muted, false);
    assert.equal(user.ignored, false);
    assert.equal(user.volume, 1);
    assert.equal(user.pitch, 1.23);
    assert.equal(user.voiceId, null);
    assert.equal(user.voiceSource, null);
    assert.equal(user.firstSeenAt, t0);
    assert.equal(user.lastActiveAt, t0);
    assert.equal(repos.users.count(), 1);
  });

  check('upsert por el mismo twitch_user_id no duplica y refresca actividad', () => {
    const t1 = t0 + 30_000;
    const user = repos.users.upsert({
      twitchUserId: '111',
      username: 'alice_renombrada',
      displayName: 'Alice Renombrada',
      pitch: 0.9,
      timestamp: t1,
    });
    assert.equal(repos.users.count(), 1);
    assert.equal(user.username, 'alice_renombrada');
    assert.equal(user.displayName, 'Alice Renombrada');
    assert.equal(user.firstSeenAt, t0, 'first_seen_at debe preservarse');
    assert.equal(user.lastActiveAt, t1, 'last_active_at debe avanzar');
    assert.equal(user.pitch, 1.23, 'el pitch existente no debe pisarse en el upsert');
  });

  check('updatePreferences persiste mute/ignore/volumen/pitch/voz', () => {
    const user = repos.users.updatePreferences('111', {
      muted: true,
      ignored: true,
      volume: 0.5,
      pitch: 1.4,
      voiceId: 'piper:es_MX-claude-high',
      voiceSource: 'override',
    });
    assert.equal(user.muted, true);
    assert.equal(user.ignored, true);
    assert.equal(user.volume, 0.5);
    assert.equal(user.pitch, 1.4);
    assert.equal(user.voiceId, 'piper:es_MX-claude-high');
    assert.equal(user.voiceSource, 'override');
  });

  check('updatePreferences parcial no toca las demás preferencias', () => {
    const user = repos.users.updatePreferences('111', { muted: false });
    assert.equal(user.muted, false);
    assert.equal(user.ignored, true);
    assert.equal(user.volume, 0.5);
    assert.equal(user.voiceId, 'piper:es_MX-claude-high');
  });

  check('voiceId/voiceSource null vuelven a la voz global', () => {
    const user = repos.users.updatePreferences('111', { voiceId: null, voiceSource: null });
    assert.equal(user.voiceId, null);
    assert.equal(user.voiceSource, null);
  });

  check('el CHECK rechaza un voice_source inválido', () => {
    assert.throws(() => repos.users.updatePreferences('111', { voiceSource: 'inventado' }), /CHECK/i);
  });

  check('las preferencias sobreviven al cierre y reapertura de la base', () => {
    db.close();
    db = openDatabase(dbFile);
    repos = createRepositories(db);
    const user = repos.users.get('111');
    assert.equal(user.ignored, true);
    assert.equal(user.volume, 0.5);
    assert.equal(user.pitch, 1.4);
  });

  check('list ordena por actividad reciente', () => {
    repos.users.upsert({
      twitchUserId: '222',
      username: 'bob',
      displayName: 'Bob',
      timestamp: Date.now(),
    });
    const ids = repos.users.list().map((user) => user.twitchUserId);
    assert.deepEqual(ids, ['222', '111']);
    assert.equal(repos.users.list({ limit: 1 }).length, 1);
  });

  check('get de un usuario inexistente devuelve null', () => {
    assert.equal(repos.users.get('999'), null);
  });

  check('delete borra al usuario', () => {
    assert.equal(repos.users.delete('222'), true);
    assert.equal(repos.users.delete('222'), false);
    assert.equal(repos.users.count(), 1);
  });

  section('configuración requerida');

  check('findMissingEnvVars nombra TWITCH_CLIENT_ID cuando falta o está vacío', () => {
    assert.deepEqual(findMissingEnvVars({ TWITCH_CLIENT_SECRET: 'x' }), ['TWITCH_CLIENT_ID']);
    assert.deepEqual(findMissingEnvVars({ TWITCH_CLIENT_ID: '   ', TWITCH_CLIENT_SECRET: 'x' }), [
      'TWITCH_CLIENT_ID',
    ]);
    assert.deepEqual(findMissingEnvVars({}), ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET']);
  });

  check('con todas las variables presentes no falta nada', () => {
    assert.deepEqual(findMissingEnvVars({ TWITCH_CLIENT_ID: 'id', TWITCH_CLIENT_SECRET: 'secret' }), []);
  });

  check('arrancar sin TWITCH_CLIENT_ID termina el proceso nombrando la variable', () => {
    const result = spawnSync(process.execPath, [path.join(backendRoot, 'src', 'server.js')], {
      env: { ...process.env, TWITCH_CLIENT_ID: '', PORT: '0' },
      encoding: 'utf8',
      timeout: 20_000,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assert.equal(result.status, 1, `se esperaba exit code 1, se obtuvo ${result.status}. Salida: ${output}`);
    assert.match(output, /TWITCH_CLIENT_ID/);
  });
} finally {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} comprobaciones OK`);

if (failures > 0) {
  console.error(`${failures} comprobacion(es) fallaron`);
  process.exit(1);
}
