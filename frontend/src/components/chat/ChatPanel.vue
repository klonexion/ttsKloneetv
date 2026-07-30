<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { useChatMessages } from '../../stores/chat-messages.js';
import ChatMessageItem from './ChatMessageItem.vue';

/**
 * Panel de chat (T-005): render de los mensajes de `/ws` con auto-scroll
 * inteligente. El auto-scroll se pausa en cuanto el usuario sube manualmente y
 * se reactiva con el botón "volver abajo" (o volviendo al fondo con la rueda).
 *
 * El scroll vive aquí y solo aquí: T-006/T-007/T-008 montan sus piezas fuera de
 * este componente para no reintroducir un contenedor con scroll propio.
 */
const { messages, count } = useChatMessages();

/** Margen (px) dentro del cual se considera que la vista está "al fondo". */
const BOTTOM_THRESHOLD_PX = 40;

const scroller = ref(null);
const autoScroll = ref(true);

/**
 * Métricas del último evento de scroll atendido. Sirven para distinguir el
 * scroll *del usuario* (posición cambia, tamaños estables) de un scroll causado
 * por un reflow (mensaje nuevo, cambio de tamaño de ventana): un reflow no debe
 * pausar el auto-scroll.
 */
let lastMetrics = { scrollHeight: 0, clientHeight: 0 };
let resizeObserver = null;

function scrollToBottom() {
  const element = scroller.value;
  if (element) {
    element.scrollTop = element.scrollHeight;
  }
}

function isAtBottom(element) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_THRESHOLD_PX;
}

function rememberMetrics() {
  const element = scroller.value;
  if (element) {
    lastMetrics = { scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
  }
}

function onScroll() {
  const element = scroller.value;
  if (!element) {
    return;
  }

  const reflowed =
    element.scrollHeight !== lastMetrics.scrollHeight || element.clientHeight !== lastMetrics.clientHeight;
  rememberMetrics();

  if (reflowed) {
    // El contenido o el contenedor cambiaron de tamaño: no es intención del
    // usuario, así que se mantiene el estado actual (y se re-ancla si seguía).
    if (autoScroll.value) {
      scrollToBottom();
    }
    return;
  }

  autoScroll.value = isAtBottom(element);
}

function resumeAutoScroll() {
  autoScroll.value = true;
  scrollToBottom();
  rememberMetrics();
}

watch(count, async () => {
  if (!autoScroll.value) {
    return;
  }
  await nextTick();
  scrollToBottom();
  rememberMetrics();
});

onMounted(() => {
  scrollToBottom();
  rememberMetrics();

  // Redimensionar la ventana (o abrir/cerrar la columna de usuarios) reflow-ea
  // el panel sin que el usuario scrollee: hay que seguir anclado al fondo.
  resizeObserver = new ResizeObserver(() => {
    if (autoScroll.value) {
      scrollToBottom();
    }
    rememberMetrics();
  });
  if (scroller.value) {
    resizeObserver.observe(scroller.value);
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});
</script>

<template>
  <section class="chat-panel">
    <div ref="scroller" class="chat-panel__scroller" @scroll.passive="onScroll">
      <div v-if="count === 0" class="chat-panel__empty text-medium-emphasis">
        <v-icon icon="mdi-message-text-outline" size="32" />
        <p class="mt-2 mb-0 text-body-2">Aún no hay mensajes en esta sesión.</p>
      </div>

      <ChatMessageItem v-for="message in messages" :key="message.id" :message="message" />
    </div>

    <v-btn
      v-show="!autoScroll"
      class="chat-panel__resume"
      color="primary"
      prepend-icon="mdi-arrow-down"
      size="small"
      variant="flat"
      @click="resumeAutoScroll"
    >
      Volver abajo
    </v-btn>
  </section>
</template>

<style scoped>
.chat-panel {
  position: relative;
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
}

.chat-panel__scroller {
  flex: 1 1 auto;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 8px 0;
}

.chat-panel__empty {
  display: flex;
  height: 100%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
}

.chat-panel__resume {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2;
}
</style>
