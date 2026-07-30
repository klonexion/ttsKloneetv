import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { config } from '../config.js';
import { logger } from '../logger.js';
import { migrate } from './migrations.js';
import { createRepositories } from './repositories/index.js';

let instance = null;
let repositories = null;

/**
 * Abre (creando el archivo y su carpeta si hace falta) una base SQLite ya
 * migrada. Exportada aparte del singleton para poder abrir bases temporales en
 * las pruebas de humo sin tocar `backend/data/app.sqlite`.
 */
export function openDatabase(file = config.db.file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  return migrate(db);
}

/**
 * Abre la base de la app (idempotente: en arranques repetidos reutiliza el
 * archivo existente y la migración no cambia nada) y la deja disponible para
 * el resto del backend vía `getDb()` / `getRepositories()`.
 */
export function initDatabase() {
  if (!instance) {
    instance = openDatabase();
    repositories = createRepositories(instance);
    logger.info(`sqlite listo en ${config.db.file}`);
  }
  return instance;
}

/** Conexión de la app, abriéndola en el primer uso. */
export function getDb() {
  return initDatabase();
}

/** Repositorios (`tokens`, `users`, `settings`) sobre la conexión de la app. */
export function getRepositories() {
  initDatabase();
  return repositories;
}

/** Cierra la conexión de la app (lo llama el shutdown del servidor). */
export function closeDatabase() {
  if (instance) {
    instance.close();
    instance = null;
    repositories = null;
  }
}

export { migrate, listTables, TABLE_NAMES, DEFAULT_SETTINGS } from './migrations.js';
export { createRepositories, DEFAULT_PROVIDER, SETTING_KEYS } from './repositories/index.js';
