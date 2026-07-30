/**
 * Logger mínimo con prefijo de nivel. PM2 ya añade timestamp y redirige a
 * `logs/`. Regla del proyecto: nunca loguear tokens ni secretos.
 */
const emit = (level, args) => {
  const line = `[${level}]`;
  if (level === 'error') {
    console.error(line, ...args);
    return;
  }
  if (level === 'warn') {
    console.warn(line, ...args);
    return;
  }
  console.log(line, ...args);
};

export const logger = {
  info: (...args) => emit('info', args),
  warn: (...args) => emit('warn', args),
  error: (...args) => emit('error', args),
};
