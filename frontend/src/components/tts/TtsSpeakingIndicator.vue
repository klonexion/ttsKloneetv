<script setup>
import { computed } from 'vue';

import { useTtsQueue } from '../../stores/tts-queue.js';

/**
 * Adorno por mensaje (T-008): marca el mensaje que se está leyendo ahora mismo.
 * Va en el slot `trailing` de `ChatMessageItem.vue`, así que no altera el layout
 * de la línea de chat.
 *
 * T-011 puede añadir aquí (o al lado, en el mismo slot) el icono de usuario
 * muteado; este componente solo se ocupa de "se está leyendo".
 */
const props = defineProps({
  messageId: {
    type: String,
    required: true,
  },
});

const { speakingId } = useTtsQueue();

const isSpeaking = computed(() => speakingId.value === props.messageId);
</script>

<template>
  <v-icon
    v-if="isSpeaking"
    class="tts-speaking"
    color="primary"
    data-testid="tts-speaking"
    icon="mdi-volume-high"
    size="14"
    title="Leyéndose ahora"
  />
</template>

<style scoped>
.tts-speaking {
  margin-left: 6px;
  animation: tts-speaking-pulse 1.2s ease-in-out infinite;
}

@keyframes tts-speaking-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

/* Respeta a quien pide menos movimiento en la interfaz. */
@media (prefers-reduced-motion: reduce) {
  .tts-speaking {
    animation: none;
  }
}
</style>
