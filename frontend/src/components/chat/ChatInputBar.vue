<script setup>
import { computed, ref } from 'vue';

/**
 * Zona inferior del shell: input de envío al chat (T-006).
 *
 * Enter (o el botón de enviar) publica el texto con `POST /api/chat/send`; el
 * backend lo manda a Twitch con Helix Send Chat Message. El mensaje **no se
 * pinta desde acá**: vuelve por EventSub y lo renderiza el store del chat, que
 * deduplica por `id`, así que hay un único camino de render.
 *
 * Reglas de la interacción:
 * - Un texto vacío o de solo espacios no se envía (ni se llama al backend).
 * - El input se limpia **solo** si el envío salió bien.
 * - Si falla, aparece un aviso visible y el texto escrito se conserva para poder
 *   reintentar sin volver a escribirlo.
 */

/** Endpoint del envío (mismo origen: viaja por el proxy de Vite). */
const SEND_ENDPOINT = '/api/chat/send';

/** Tope de Twitch para un mensaje de chat (el backend lo valida también). */
const MAX_MESSAGE_LENGTH = 500;

const text = ref('');
const sending = ref(false);
const error = ref('');

/** Solo hay algo que enviar si queda texto después de recortar los espacios. */
const canSend = computed(() => text.value.trim() !== '' && !sending.value);

/** Aviso a partir de una respuesta que no confirmó el envío. */
function describeHttpFailure(response, data) {
  if (typeof data?.error === 'string' && data.error !== '') {
    return data.error;
  }
  // Sin JSON del backend: lo habitual es el proxy respondiendo por un backend
  // caído (`npm start` sirve el frontend con Vite delante del backend).
  return `No se pudo contactar al backend (HTTP ${response.status}). El mensaje quedó acá para reintentar.`;
}

/** Traduce un fallo a un aviso en español, sin tecnicismos innecesarios. */
function describeFailure(failure) {
  if (failure instanceof TypeError) {
    // `fetch` rechaza así cuando no hay backend al otro lado.
    return 'No se pudo contactar al backend. El mensaje quedó acá para reintentar.';
  }
  return failure.message || 'No se pudo enviar el mensaje.';
}

async function submit() {
  if (!canSend.value) {
    return;
  }

  // Se envía el texto tal cual lo escribió el usuario; el backend lo recorta.
  const attempted = text.value;
  sending.value = true;
  error.value = '';

  try {
    const response = await fetch(SEND_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ text: attempted }),
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || data?.sent !== true) {
      throw new Error(describeHttpFailure(response, data));
    }

    // Si el usuario siguió escribiendo mientras salía la petición, no se le
    // borra lo nuevo: solo se limpia lo que efectivamente se envió.
    if (text.value === attempted) {
      text.value = '';
    }
  } catch (failure) {
    error.value = describeFailure(failure);
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <footer class="chat-input">
    <v-alert
      v-if="error"
      class="mb-2"
      closable
      data-testid="chat-send-error"
      density="compact"
      type="error"
      variant="tonal"
      @click:close="error = ''"
    >
      {{ error }}
    </v-alert>

    <v-text-field
      v-model="text"
      autocomplete="off"
      data-testid="chat-input"
      density="comfortable"
      hide-details
      :loading="sending"
      :maxlength="MAX_MESSAGE_LENGTH"
      placeholder="Escribí un mensaje y presioná Enter…"
      variant="solo-filled"
      @keydown.enter.prevent="submit"
      @update:model-value="error = ''"
    >
      <template #append-inner>
        <v-btn
          aria-label="Enviar mensaje"
          data-testid="chat-send"
          :disabled="!canSend"
          density="comfortable"
          icon="mdi-send"
          size="small"
          variant="text"
          @click="submit"
        />
      </template>
    </v-text-field>
  </footer>
</template>

<style scoped>
.chat-input {
  flex: 0 0 auto;
  padding: 10px 12px;
  border-top: thin solid rgba(255, 255, 255, 0.12);
}
</style>
