import { computed, readonly, ref } from 'vue';

/**
 * Store de la sesión de Twitch (T-003): alimenta la compuerta de login.
 *
 * El backend expone `GET /api/session` con `{ authenticated, channel }` (los
 * tokens nunca salen del backend). El login es una **navegación real** del
 * navegador a `/auth/login` —no un fetch—, porque termina en un redirect a
 * Twitch; al volver del callback la página se recarga y este store vuelve a
 * consultar el estado.
 *
 * Para las tareas siguientes: `channel` es el canal conectado
 * (`{ id, login, displayName }`); úsalo si necesitas el broadcaster en la UI en
 * vez de pedirlo otra vez al backend.
 */

/** Endpoint del estado de sesión y URL de inicio de login (vía proxy de Vite). */
export const SESSION_ENDPOINT = '/api/session';
export const LOGIN_URL = '/auth/login';

/** Cada cuánto se revisa la sesión (detecta un token revocado sin recargar). */
export const SESSION_POLL_INTERVAL_MS = 30_000;

/** Mensajes de `?auth_error=` con los que el backend vuelve del callback. */
const AUTH_ERROR_MESSAGES = {
  denied: 'No autorizaste la aplicación en Twitch. Volvé a intentarlo para continuar.',
  state: 'La respuesta de Twitch no coincidió con la solicitud (posible enlace vencido). Probá de nuevo.',
  missing_code: 'Twitch no devolvió el código de autorización. Probá de nuevo.',
  exchange: 'No se pudo completar el intercambio de credenciales con Twitch. Revisá la configuración y reintentá.',
};

/** `unknown` mientras no se sabe (evita parpadear el login), luego `ready`. */
const status = ref('unknown');
const authenticated = ref(false);
const channel = ref(null);
const error = ref('');

let pollTimer = null;

/** Consulta `GET /api/session` y actualiza el estado. */
export async function loadSession() {
  try {
    const response = await fetch(SESSION_ENDPOINT, { headers: { accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    authenticated.value = data.authenticated === true;
    channel.value = data.channel ?? null;
    error.value = '';
  } catch (failure) {
    authenticated.value = false;
    channel.value = null;
    error.value = `No se pudo consultar la sesión (${failure.message}). ¿Está corriendo el backend?`;
  } finally {
    status.value = 'ready';
  }
}

/**
 * Lee el `?auth_error=` con el que el backend pudo volver del callback y limpia
 * la URL para que el aviso no reaparezca al recargar.
 */
export function consumeAuthErrorFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('auth_error');
  if (!code) {
    return;
  }

  error.value = AUTH_ERROR_MESSAGES[code] ?? 'No se pudo iniciar sesión con Twitch. Probá de nuevo.';

  params.delete('auth_error');
  const search = params.toString();
  window.history.replaceState({}, '', `${window.location.pathname}${search ? `?${search}` : ''}`);
}

/**
 * Arranca la vigilancia de la sesión: carga inicial más un sondeo periódico.
 * Devuelve la función para detenerlo.
 */
export function startSessionWatch({ intervalMs = SESSION_POLL_INTERVAL_MS } = {}) {
  consumeAuthErrorFromUrl();
  void loadSession();

  stopSessionWatch();
  pollTimer = window.setInterval(() => void loadSession(), intervalMs);

  return stopSessionWatch;
}

/** Detiene el sondeo periódico de la sesión. */
export function stopSessionWatch() {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** Acceso reactivo de solo lectura al estado de la sesión. */
export function useSession() {
  return {
    status: readonly(status),
    authenticated: readonly(authenticated),
    channel: readonly(channel),
    error: readonly(error),
    isResolved: computed(() => status.value === 'ready'),
    reload: loadSession,
  };
}
