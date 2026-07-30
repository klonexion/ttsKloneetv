<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useDisplay, useTheme } from 'vuetify';

import LoginView from './components/auth/LoginView.vue';
import ChatInputBar from './components/chat/ChatInputBar.vue';
import ChatPanel from './components/chat/ChatPanel.vue';
import SettingsDialog from './components/settings/SettingsDialog.vue';
import TtsQueueControls from './components/tts/TtsQueueControls.vue';
import UsersPanel from './components/users/UsersPanel.vue';
import { startChatMessagesFeed } from './stores/chat-messages.js';
import { startSessionWatch, stopSessionWatch, useSession } from './stores/session.js';
import { loadGlobalSettings, uiTheme } from './stores/settings.js';
import { connectionState, startChatSocket, stopChatSocket } from './ws/client.js';

/**
 * Shell de la app (T-005) detrás de la compuerta de login (T-003): tres zonas
 * sobre el tema oscuro de Vuetify.
 *
 * - Zona izquierda (`v-main`): el panel de chat, único contenedor con scroll.
 * - Zona derecha (`v-navigation-drawer`): la columna de usuarios (T-007).
 * - Zona inferior (`ChatInputBar`): el input de envío (T-006).
 *
 * Sin sesión de Twitch no se monta nada del shell: solo `LoginView`. El
 * WebSocket `/ws` se abre al autenticarse y se cierra si la sesión se pierde
 * (token revocado), así que las tareas siguientes pueden asumir que si el shell
 * está montado hay canal conectado.
 *
 * Huecos para las tareas que montan sobre este shell:
 * - **T-006** solo cablea `ChatInputBar.vue`; el shell no cambia.
 * - **T-007** solo rellena `UsersPanel.vue` dentro del drawer.
 * - **T-008** vive fuera del layout: `TtsQueueControls` (app bar) es el dueño del
 *   ciclo de vida de la cola TTS —se suscribe al hub al montarse y la limpia al
 *   desmontarse—, y el indicador de "leyéndose" va en el slot `trailing` de
 *   `ChatMessageItem`. Aquí no hay nada más que cablear.
 * - **T-013** añade el acceso a los ajustes globales. Como T-008 midió que sus
 *   cuatro controles ya aprietan el app bar a 414 px, el control nuevo es un
 *   **menú de overflow** que además recoge el botón de la columna de usuarios bajo
 *   el breakpoint `md`: el app bar no gana ancho en pantallas pequeñas. Y el tema
 *   se aplica aquí con `useTheme()` a partir del ajuste persistido.
 */
const { mdAndUp } = useDisplay();
const theme = useTheme();

const { authenticated, channel, isResolved } = useSession();

const usersDrawer = ref(mdAndUp.value);
const settingsOpen = ref(false);

const CONNECTION_UI = {
  open: { color: 'success', icon: 'mdi-lan-connect', label: 'Conectado' },
  connecting: { color: 'info', icon: 'mdi-lan-pending', label: 'Conectando…' },
  reconnecting: { color: 'warning', icon: 'mdi-lan-pending', label: 'Reconectando…' },
  closed: { color: 'error', icon: 'mdi-lan-disconnect', label: 'Desconectado' },
};

const connection = computed(() => CONNECTION_UI[connectionState.value] ?? CONNECTION_UI.closed);

let stopFeed = null;

/** El chat en vivo solo tiene sentido con sesión: se enciende y apaga con ella. */
const releaseChatFeed = () => {
  if (stopFeed === null) {
    return;
  }
  stopFeed();
  stopFeed = null;
  stopChatSocket();
};

watch(
  authenticated,
  (isAuthenticated) => {
    if (isAuthenticated && stopFeed === null) {
      stopFeed = startChatMessagesFeed();
      startChatSocket();
      return;
    }
    if (!isAuthenticated) {
      releaseChatFeed();
    }
  },
  { immediate: true },
);

/**
 * El tema vive en `app_settings` (T-013), así que la preferencia sobrevive
 * recargas y reinicios: aquí solo se aplica en vivo lo que diga el store. Vuetify
 * arranca en oscuro (`plugins/vuetify.js`), que es también el default del backend,
 * así que si la carga falla el aspecto no cambia.
 */
watch(
  uiTheme,
  (name) => {
    if (name && theme.name.value !== name) {
      theme.change(name);
    }
  },
  { immediate: true },
);

onMounted(() => {
  startSessionWatch();
  // Sin esperar a la sesión: el tema tiene que valer también en el login.
  void loadGlobalSettings();
});

onBeforeUnmount(() => {
  stopSessionWatch();
  releaseChatFeed();
});
</script>

<template>
  <v-app>
    <!-- Mientras no se sabe si hay sesión no se pinta nada definitivo, para no
         mostrar el login un instante a quien ya está autenticado. -->
    <v-main v-if="!isResolved" class="shell-splash">
      <v-progress-circular color="primary" indeterminate size="32" />
    </v-main>

    <LoginView v-else-if="!authenticated" />

    <template v-else>
      <v-app-bar color="surface" density="comfortable" flat>
        <v-app-bar-title>Streamer Chat TTS Hub</v-app-bar-title>

        <v-chip
          v-if="channel"
          class="mr-2"
          color="#9146FF"
          data-testid="channel-name"
          prepend-icon="mdi-twitch"
          size="small"
          :title="`Canal conectado: ${channel.login}`"
          variant="tonal"
        >
          {{ channel.displayName }}
        </v-chip>

        <v-chip
          class="mr-2"
          :color="connection.color"
          data-testid="ws-status"
          :prepend-icon="connection.icon"
          size="small"
          variant="tonal"
        >
          {{ connection.label }}
        </v-chip>

        <TtsQueueControls class="mr-1" />

        <!-- A partir de `md` el botón de la columna sigue siendo directo; por
             debajo se recoge en el menú de overflow para no robarle ancho al
             título (T-008 midió que a 414 px ya va justo). -->
        <v-btn
          v-if="mdAndUp"
          data-testid="users-toggle"
          icon="mdi-account-multiple-outline"
          :title="usersDrawer ? 'Ocultar usuarios' : 'Mostrar usuarios'"
          @click="usersDrawer = !usersDrawer"
        />

        <v-menu location="bottom end">
          <template #activator="{ props: menuProps }">
            <v-btn data-testid="app-menu" icon="mdi-dots-vertical" title="Más opciones" v-bind="menuProps" />
          </template>

          <v-list density="compact">
            <v-list-item
              data-testid="app-menu-settings"
              prepend-icon="mdi-cog-outline"
              @click="settingsOpen = true"
            >
              <v-list-item-title>Ajustes globales</v-list-item-title>
            </v-list-item>

            <v-list-item
              v-if="!mdAndUp"
              data-testid="app-menu-users"
              prepend-icon="mdi-account-multiple-outline"
              @click="usersDrawer = !usersDrawer"
            >
              <v-list-item-title>{{ usersDrawer ? 'Ocultar usuarios' : 'Mostrar usuarios' }}</v-list-item-title>
            </v-list-item>
          </v-list>
        </v-menu>
      </v-app-bar>

      <v-navigation-drawer v-model="usersDrawer" location="right" :temporary="!mdAndUp" width="280">
        <UsersPanel />
      </v-navigation-drawer>

      <v-main class="shell-main">
        <div class="shell-column">
          <ChatPanel />
          <ChatInputBar />
        </div>
      </v-main>

      <SettingsDialog v-model="settingsOpen" />
    </template>
  </v-app>
</template>

<style scoped>
/*
 * El shell ocupa exactamente el viewport y no genera scroll de página: el único
 * scroll es el del panel de chat. `v-main` ya reserva la barra superior con
 * padding, así que con `box-sizing: border-box` (el reset de Vuetify) la altura
 * útil es 100dvh menos la app bar, tanto a 1280×720 como a pantalla completa.
 */
.shell-main {
  height: 100dvh;
  overflow: hidden;
}

/* Espera inicial mientras se resuelve `GET /api/session`. */
.shell-splash {
  display: flex;
  height: 100dvh;
  align-items: center;
  justify-content: center;
}

.shell-column {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
}
</style>
