import { computed, ref } from 'vue';

import { onServerMessage } from '../ws/client.js';

/**
 * Store de los mensajes de chat que llegan por `/ws` (T-005).
 *
 * Shape normalizado que publica el backend (ver "Decisiones arquitectónicas
 * durables" del plan y T-004):
 *
 *     { id, userId, username, displayName, text, timestamp }
 *
 * Es agnóstico de Twitch: aquí no se conoce ningún campo crudo de EventSub.
 *
 * Para T-008: este store es el punto donde enganchar la cola TTS. Suscríbete al
 * mismo canal con `onServerMessage(...)` para las instrucciones TTS que vengan
 * adjuntas, o consume `messages` — no reformules el pipeline de render.
 */

/** Tipo de trama que el backend usa para un mensaje de chat (T-004 lo emite). */
export const CHAT_MESSAGE_TYPE = 'chat:message';

/** Tope de mensajes en memoria: el chat es un stream, no un historial. */
export const MAX_MESSAGES = 500;

const messages = ref([]);
const seenIds = new Set();

function normalize(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const text = typeof raw.text === 'string' ? raw.text : '';
  if (text.length === 0) {
    return null;
  }

  const username = typeof raw.username === 'string' && raw.username ? raw.username : 'anónimo';
  const timestamp = typeof raw.timestamp === 'string' && raw.timestamp ? raw.timestamp : new Date().toISOString();

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `local-${crypto.randomUUID()}`,
    userId: typeof raw.userId === 'string' && raw.userId ? raw.userId : username,
    username,
    displayName: typeof raw.displayName === 'string' && raw.displayName ? raw.displayName : username,
    text,
    timestamp,
  };
}

/**
 * Añade un mensaje al store (normalizando y descartando duplicados por `id`).
 * Devuelve el mensaje añadido, o `null` si se descartó.
 */
export function addChatMessage(raw) {
  const message = normalize(raw);
  if (message === null || seenIds.has(message.id)) {
    return null;
  }

  seenIds.add(message.id);
  messages.value.push(message);

  while (messages.value.length > MAX_MESSAGES) {
    const dropped = messages.value.shift();
    seenIds.delete(dropped.id);
  }

  return message;
}

/** Vacía el store (usado por la UI y por las pruebas manuales). */
export function clearChatMessages() {
  messages.value = [];
  seenIds.clear();
}

/**
 * Conecta el store al hub: cada trama `chat:message` alimenta la lista.
 * Acepta un mensaje suelto o un lote (T-004 podría enviar un backlog).
 * Devuelve la función de baja.
 */
export function startChatMessagesFeed() {
  return onServerMessage(CHAT_MESSAGE_TYPE, (payload) => {
    if (Array.isArray(payload)) {
      for (const item of payload) {
        addChatMessage(item);
      }
      return;
    }
    addChatMessage(payload);
  });
}

/** Acceso reactivo de solo lectura a los mensajes. */
export function useChatMessages() {
  return {
    messages: computed(() => messages.value),
    count: computed(() => messages.value.length),
  };
}
