<script setup>
import { LOGIN_URL, useSession } from '../../stores/session.js';

/**
 * Compuerta de login (T-003): lo único que se ve sin sesión.
 *
 * El botón es un enlace de verdad (`href`), no un fetch: `/auth/login` responde
 * un 302 a la pantalla de consentimiento de Twitch, así que el navegador tiene
 * que navegar. Al volver del callback la app se recarga ya autenticada y este
 * componente desaparece (el shell lo reemplaza).
 */
const { error } = useSession();
</script>

<template>
  <v-main class="login-view">
    <div class="login-view__center">
      <v-card class="login-view__card" data-testid="login-card">
        <v-card-item>
          <v-card-title class="text-wrap">Streamer Chat TTS Hub</v-card-title>
          <v-card-subtitle class="text-wrap">Conectá tu cuenta de Twitch para empezar</v-card-subtitle>
        </v-card-item>

        <v-card-text>
          <v-alert v-if="error" class="mb-4" density="compact" type="warning" variant="tonal">{{ error }}</v-alert>

          <p class="text-body-2 text-medium-emphasis mb-0">
            Se te pedirá permiso para leer y escribir en el chat de tu canal y para ver quién está conectado. La sesión
            queda guardada en esta computadora y se renueva sola.
          </p>
        </v-card-text>

        <v-card-actions class="px-4 pb-4">
          <v-btn
            block
            color="#9146FF"
            data-testid="login-button"
            :href="LOGIN_URL"
            prepend-icon="mdi-twitch"
            size="large"
            variant="flat"
          >
            Iniciar sesión con Twitch
          </v-btn>
        </v-card-actions>
      </v-card>
    </div>
  </v-main>
</template>

<style scoped>
/* Centrado en el viewport y sin scroll de página, igual que el shell. */
.login-view__center {
  display: flex;
  height: 100dvh;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.login-view__card {
  width: 100%;
  max-width: 420px;
}
</style>
