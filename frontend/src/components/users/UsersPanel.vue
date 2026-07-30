<script setup>
import { onBeforeUnmount, onMounted } from 'vue';

import { clearSelectedUser, selectUser, startUsersFeed, useUsers } from '../../stores/users.js';
import UserDetailDialog from './UserDetailDialog.vue';
import UserListItem from './UserListItem.vue';

/**
 * Columna derecha del shell: la lista híbrida de usuarios (T-007).
 *
 * El backend publica la lista completa y **ya ordenada** por `/ws`
 * (`users:list`): presentes de Get Chatters (~60 s) + quien escribe, que sube al
 * instante. Aquí solo se pinta y se abre el panel de detalle al hacer clic.
 *
 * El feed se enciende con el componente: el shell solo se monta con sesión
 * activa (T-003), así que mientras esta columna existe hay canal conectado.
 */
const { users, presentCount, activeCount, rosterAvailable, selectedUser } = useUsers();

let stopFeed = null;

onMounted(() => {
  stopFeed = startUsersFeed();
});

onBeforeUnmount(() => {
  stopFeed?.();
  stopFeed = null;
  clearSelectedUser();
});
</script>

<template>
  <aside class="users-panel">
    <header class="users-panel__header">
      <v-icon class="mr-2" icon="mdi-account-multiple-outline" size="20" />
      <span class="text-subtitle-2">Usuarios</span>
      <v-spacer />
      <v-chip
        class="users-panel__count"
        data-testid="users-count"
        size="x-small"
        :title="`${presentCount} presentes en el chat, ${activeCount} han escrito en esta sesión`"
        variant="tonal"
      >
        {{ presentCount }} · {{ activeCount }} activos
      </v-chip>
    </header>

    <v-divider />

    <div class="users-panel__body">
      <p v-if="users.length === 0" class="text-body-2 text-medium-emphasis pa-4 mb-0" data-testid="users-empty">
        {{ rosterAvailable ? 'No hay nadie en el chat en este momento.' : 'Consultando quién está en el chat…' }}
      </p>

      <v-list v-else class="py-0" data-testid="users-list" density="compact">
        <UserListItem v-for="user in users" :key="user.userId" :user="user" @select="selectUser(user.userId)" />
      </v-list>
    </div>

    <UserDetailDialog :user="selectedUser" @close="clearSelectedUser" />
  </aside>
</template>

<style scoped>
.users-panel {
  display: flex;
  height: 100%;
  flex-direction: column;
}

.users-panel__header {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  padding: 12px 16px;
}

.users-panel__count {
  font-variant-numeric: tabular-nums;
}

.users-panel__body {
  flex: 1 1 auto;
  overflow-y: auto;
}
</style>
