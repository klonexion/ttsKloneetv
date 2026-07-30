<script setup>
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { useDisplay } from 'vuetify';

import {
  clearQueue,
  exposeTtsDiagnostics,
  resetTtsQueue,
  skipCurrent,
  startTtsQueueFeed,
  togglePauseQueue,
  useTtsQueue,
} from '../../stores/tts-queue.js';

/**
 * Controles globales de la cola TTS (T-008), pensados para el app bar: indicador
 * de tamaño + pausar/reanudar + saltar + vaciar.
 *
 * El componente es también el dueño del ciclo de vida de la cola: se monta solo
 * cuando el shell está montado (o sea, con sesión de Twitch), así que suscribe la
 * cola al hub al aparecer y la deja limpia al desaparecer. Por eso `App.vue` solo
 * necesita colocarlo, sin cablear nada más.
 *
 * El indicador cuenta **pendientes + el que se está leyendo**, que es "lo que
 * queda por oír".
 */
const { blocked, size, paused, pendingCount, speakingId } = useTtsQueue();

/**
 * Bajo el breakpoint `md` el app bar va justo (chip de canal + chip de `/ws` +
 * botón de usuarios), así que los cuatro elementos se aprietan: sin icono en el
 * chip y con los botones compactos. No se esconde ningún control.
 */
const { mdAndUp } = useDisplay();
const compact = computed(() => !mdAndUp.value);

/** Aspecto del indicador: bloqueado > pausado > leyendo > en reposo. */
const indicator = computed(() => {
  if (blocked.value) {
    return {
      color: 'error',
      icon: 'mdi-volume-variant-off',
      title: 'El navegador no permitió hablar: haz clic en la página (o revisa que haya voces instaladas y audio disponible).',
    };
  }
  if (paused.value) {
    return { color: 'warning', icon: 'mdi-pause', title: `Lectura en pausa: ${size.value} por leer` };
  }
  return {
    color: size.value > 0 ? 'primary' : undefined,
    icon: size.value > 0 ? 'mdi-volume-high' : 'mdi-volume-off',
    title: `Cola TTS: ${size.value} por leer (${pendingCount.value} en espera${speakingId.value ? ', 1 leyéndose' : ''})`,
  };
});

let stopFeed = null;

onMounted(() => {
  stopFeed = startTtsQueueFeed();
  exposeTtsDiagnostics();
});

onBeforeUnmount(() => {
  stopFeed?.();
  stopFeed = null;
  resetTtsQueue();
});
</script>

<template>
  <div class="tts-controls">
    <v-chip
      class="mr-1"
      :color="indicator.color"
      :data-tts-blocked="blocked ? 'true' : 'false'"
      data-testid="tts-queue-size"
      :prepend-icon="compact ? undefined : indicator.icon"
      size="small"
      :title="indicator.title"
      variant="tonal"
    >
      <span data-testid="tts-queue-count">{{ size }}</span>
    </v-chip>

    <v-btn
      data-testid="tts-pause"
      :density="compact ? 'compact' : 'comfortable'"
      :icon="paused ? 'mdi-play' : 'mdi-pause'"
      :size="compact ? 'x-small' : 'small'"
      :title="paused ? 'Reanudar la lectura' : 'Pausar la lectura'"
      variant="text"
      @click="togglePauseQueue"
    />

    <v-btn
      data-testid="tts-skip"
      :density="compact ? 'compact' : 'comfortable'"
      :disabled="speakingId === null"
      icon="mdi-skip-next"
      :size="compact ? 'x-small' : 'small'"
      title="Saltar el mensaje que se está leyendo"
      variant="text"
      @click="skipCurrent"
    />

    <v-btn
      data-testid="tts-clear"
      :density="compact ? 'compact' : 'comfortable'"
      :disabled="size === 0"
      icon="mdi-playlist-remove"
      :size="compact ? 'x-small' : 'small'"
      title="Vaciar la cola (corta lo que suena)"
      variant="text"
      @click="clearQueue"
    />
  </div>
</template>

<style scoped>
.tts-controls {
  display: flex;
  align-items: center;
  gap: 2px;
}
</style>
