const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL ?? 'info').toLowerCase()] ?? LEVELS.info;

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function emit(level, scope, args) {
  if (LEVELS[level] < threshold) return;
  const prefix = `${timestamp()} [${level.toUpperCase().padEnd(5)}] (${scope})`;
  const target = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  target(prefix, ...args);
}

/**
 * Cria um logger com escopo. Uso: const log = createLogger('room:geral')
 */
export function createLogger(scope) {
  return {
    debug: (...args) => emit('debug', scope, args),
    info: (...args) => emit('info', scope, args),
    warn: (...args) => emit('warn', scope, args),
    error: (...args) => emit('error', scope, args),
    child: (suffix) => createLogger(`${scope}:${suffix}`),
  };
}
