<script setup>
import { computed } from 'vue';

import { userColor } from '../../utils/chat-format.js';
import { USER_FLAG_ICONS, describeUserActivity } from '../../utils/user-format.js';

/**
 * Una fila de la columna de usuarios (T-007).
 *
 * Distingue a quien ha escrito en la sesión (`active`: punto encendido, nombre
 * con su color de chat y la hora de su último mensaje) de quien solo está
 * presente (lurker: atenuado y con el punto hueco). Los flags persistidos
 * (`muted`, `ignored`) se pintan como iconos a la derecha.
 *
 * Los `data-*` del `<li>` son los que usa la verificación en navegador.
 *
 * Ojo: `v-list-item` tiene una prop `title` propia, así que un `:title` pensado
 * como tooltip se pinta como texto duplicado de la fila. El tooltip nativo va en
 * el contenido, no en el `v-list-item`.
 */
const props = defineProps({
  user: {
    type: Object,
    required: true,
  },
});

defineEmits(['select']);

const nameColor = computed(() => (props.user.active ? userColor(props.user.userId) : undefined));
const activity = computed(() => describeUserActivity(props.user));
</script>

<template>
  <v-list-item
    class="user-item"
    :class="{ 'user-item--active': user.active, 'user-item--lurker': !user.active }"
    :data-active="String(user.active)"
    :data-ignored="String(user.ignored)"
    :data-muted="String(user.muted)"
    :data-present="String(user.present)"
    data-testid="user-item"
    :data-user-id="user.userId"
    density="compact"
    lines="two"
    @click="$emit('select', user)"
  >
    <template #prepend>
      <span class="user-item__dot" :style="{ backgroundColor: user.active ? userColor(user.userId) : 'transparent', borderColor: userColor(user.userId) }" />
    </template>

    <v-list-item-title class="user-item__name" :style="{ color: nameColor }">
      <span :title="`${user.displayName} (@${user.username}) — ${activity}`">{{ user.displayName }}</span>
    </v-list-item-title>
    <v-list-item-subtitle class="user-item__activity">{{ activity }}</v-list-item-subtitle>

    <template #append>
      <v-icon v-if="user.muted" class="user-item__flag" color="warning" data-testid="user-flag-muted" :icon="USER_FLAG_ICONS.muted" size="16" title="TTS silenciado" />
      <v-icon v-if="user.ignored" class="user-item__flag" color="error" data-testid="user-flag-ignored" :icon="USER_FLAG_ICONS.ignored" size="16" title="Usuario ignorado" />
    </template>
  </v-list-item>
</template>

<style scoped>
.user-item {
  padding-inline: 12px;
}

/* El lurker se ve claramente en segundo plano respecto a quien ya habló. */
.user-item--lurker {
  opacity: 0.62;
}

.user-item--lurker .user-item__name {
  font-weight: 400;
}

.user-item--active .user-item__name {
  font-weight: 700;
}

.user-item__dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  margin-right: 10px;
  border: 1px solid;
  border-radius: 50%;
}

.user-item__name {
  font-size: 0.9rem;
}

.user-item__activity {
  font-size: 0.72rem;
}

.user-item__flag {
  margin-left: 4px;
}
</style>
