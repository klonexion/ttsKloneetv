<script setup>
import { computed } from 'vue';

import TtsSpeakingIndicator from '../tts/TtsSpeakingIndicator.vue';
import { formatMessageTime, userColor } from '../../utils/chat-format.js';

/**
 * Una línea del chat: hora, nombre con color estable y texto (T-005).
 *
 * Los adornos por mensaje van en el slot `trailing`, sin tocar el layout de la
 * línea. T-008 usa su **contenido por defecto** para el indicador de "leyéndose"
 * (así `ChatPanel.vue` no tiene que pasar nada); quien pase el slot lo sustituye.
 * T-011 añadirá ahí el icono de usuario muteado.
 */
const props = defineProps({
  message: {
    type: Object,
    required: true,
  },
});

const nameColor = computed(() => userColor(props.message.userId));
const time = computed(() => formatMessageTime(props.message.timestamp));
</script>

<template>
  <div class="chat-line">
    <span v-if="time" class="chat-line__time text-medium-emphasis">{{ time }}</span>
    <span class="chat-line__name" :style="{ color: nameColor }">{{ message.displayName }}</span>
    <span class="chat-line__text">{{ message.text }}</span>
    <slot name="trailing" :message="message">
      <TtsSpeakingIndicator :message-id="message.id" />
    </slot>
  </div>
</template>

<style scoped>
.chat-line {
  padding: 3px 12px;
  font-size: 0.95rem;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.chat-line:hover {
  background-color: rgba(255, 255, 255, 0.04);
}

.chat-line__time {
  margin-right: 6px;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}

.chat-line__name {
  font-weight: 700;
}

.chat-line__name::after {
  content: ':';
  color: rgba(255, 255, 255, 0.5);
}

.chat-line__text {
  margin-left: 6px;
  white-space: pre-wrap;
}
</style>
