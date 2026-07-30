<script setup>
import { computed } from 'vue';

import UserActions from './UserActions.vue';
import { userColor } from '../../utils/chat-format.js';
import { USER_FLAG_ICONS, describeUserActivity, describeVoiceSource, formatDateTime } from '../../utils/user-format.js';

/**
 * Panel de detalle de un usuario: la información (T-007) más los controles que
 * escriben sus preferencias (T-011, en `./UserActions.vue`).
 *
 * Este componente sigue sin estado propio: lo pinta todo desde `props.user`, que
 * llega de la trama `users:list`; los controles escriben por el backend y la fila
 * actualizada vuelve por el store.
 */
const props = defineProps({
  user: {
    type: Object,
    default: null,
  },
});

const emit = defineEmits(['close']);

const isOpen = computed({
  get: () => props.user !== null,
  set: (value) => {
    if (!value) {
      emit('close');
    }
  },
});

const rows = computed(() => {
  const user = props.user;
  if (user === null) {
    return [];
  }

  return [
    { label: 'Usuario de Twitch', value: `@${user.username}` },
    { label: 'Actividad', value: describeUserActivity(user) },
    { label: 'Último mensaje', value: formatDateTime(user.lastActiveAt) || 'todavía no ha escrito' },
    { label: 'Primera vez visto', value: formatDateTime(user.firstSeenAt) || 'sin registro' },
    { label: 'Presente en el chat', value: user.present ? 'sí (reportado por Twitch)' : 'no en el último recuento' },
    { label: 'Volumen del TTS', value: `${Math.round(user.volume * 100)} %` },
    { label: 'Pitch', value: user.pitch.toFixed(2) },
    { label: 'Timbre', value: user.timbre.toFixed(2) },
    { label: 'Voz', value: user.voiceId ?? 'la voz global', hint: describeVoiceSource(user.voiceSource) },
    { label: 'ID de Twitch', value: user.userId },
  ];
});
</script>

<template>
  <v-dialog v-model="isOpen" max-width="440" data-testid="user-detail-dialog">
    <v-card v-if="user">
      <v-card-item>
        <template #prepend>
          <v-avatar :color="userColor(user.userId)" size="34">
            <span class="text-body-2 font-weight-bold">{{ user.displayName.slice(0, 2).toUpperCase() }}</span>
          </v-avatar>
        </template>
        <v-card-title class="pl-2" data-testid="user-detail-name">{{ user.displayName }}</v-card-title>
        <v-card-subtitle class="pl-2">@{{ user.username }}</v-card-subtitle>
      </v-card-item>

      <v-card-text class="pt-0">
        <div class="mb-3 d-flex flex-wrap ga-2">
          <v-chip v-if="user.active" color="success" data-testid="user-detail-chip-active" prepend-icon="mdi-message-text" size="small" variant="tonal">
            Activo en la sesión
          </v-chip>
          <v-chip v-else color="info" data-testid="user-detail-chip-lurker" prepend-icon="mdi-eye-outline" size="small" variant="tonal">
            Sin escribir
          </v-chip>
          <v-chip v-if="user.muted" color="warning" data-testid="user-detail-chip-muted" :prepend-icon="USER_FLAG_ICONS.muted" size="small" variant="tonal">
            TTS silenciado
          </v-chip>
          <v-chip v-if="user.ignored" color="error" data-testid="user-detail-chip-ignored" :prepend-icon="USER_FLAG_ICONS.ignored" size="small" variant="tonal">
            Ignorado
          </v-chip>
        </div>

        <dl class="user-detail__rows">
          <template v-for="row in rows" :key="row.label">
            <dt class="text-caption text-medium-emphasis">{{ row.label }}</dt>
            <dd class="text-body-2">
              {{ row.value }}
              <span v-if="row.hint" class="text-caption text-medium-emphasis">({{ row.hint }})</span>
            </dd>
          </template>
        </dl>

        <!-- T-011: los controles funcionales (mutear, ignorar, volumen, pitch, voz). -->
        <UserActions class="mt-4" :user="user" />
      </v-card-text>

      <v-card-actions>
        <v-spacer />
        <v-btn data-testid="user-detail-close" variant="text" @click="emit('close')">Cerrar</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.user-detail__rows {
  display: grid;
  grid-template-columns: minmax(0, 8.5rem) minmax(0, 1fr);
  gap: 4px 12px;
  margin: 0;
}

.user-detail__rows dd {
  margin: 0;
  overflow-wrap: anywhere;
}
</style>
