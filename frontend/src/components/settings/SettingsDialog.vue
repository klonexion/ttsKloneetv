<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { THEMES, useGlobalSettings } from '../../stores/settings.js';
import { useVoiceCatalog } from '../../stores/voices.js';

/**
 * Panel de ajustes globales (T-013): los cuatro controles del canal, persistidos
 * en `app_settings` y aplicados **en vivo, sin recargar**.
 *
 * 1. **Voz global** — el catálogo completo de `GET /api/voices` (T-009), agrupado
 *    por motor y con el español primero. Cambiarla afecta desde el mensaje
 *    siguiente a los usuarios **sin override ni voz de comando**, conservando el
 *    pitch de todos: eso lo garantiza el modelo de voz del backend (T-011), aquí
 *    solo se escribe `global_voice_id`.
 * 2. **Volumen maestro del TTS** — escala el volumen individual de cada usuario en
 *    la reproducción (`stores/tts-queue.js`).
 * 3. **Timbre maestro del TTS** — a diferencia del volumen, se combina en el
 *    backend **antes de sintetizar** (el pipeline lo relee en cada mensaje): es
 *    un desplazamiento sobre el timbre individual, no una escala, así que el
 *    rango es 0–2 (1 = neutro) igual que el timbre por usuario, no 0–1 como el
 *    volumen. Ver `combineTimbre()` en `backend/src/tts/voice-model.js`.
 * 4. **Tema claro/oscuro** — oscuro por default; se aplica al instante y sobrevive
 *    recargas y reinicios porque vive en SQLite.
 *
 * Como en el panel de usuario (T-011), el componente **no guarda estado propio**:
 * pinta desde el store, escribe por el backend y, si una escritura falla, devuelve
 * el control al valor guardado dejando el aviso a la vista.
 */
const modelValue = defineModel({ type: Boolean, default: false });

const settings = useGlobalSettings();
const catalog = useVoiceCatalog();

/** Ajuste que se está guardando (`''` = ninguno): deshabilita solo ese control. */
const saving = ref('');
const error = ref('');

const voice = ref(null);
const masterVolume = ref(1);
const masterTimbre = ref(1);
const dark = ref(true);

/** Vuelve a poner los controles en lo que dicen los ajustes guardados. */
function syncFromStore() {
  voice.value = settings.globalVoiceId.value;
  masterVolume.value = settings.masterVolume.value;
  masterTimbre.value = settings.masterTimbre.value;
  dark.value = settings.theme.value === THEMES.dark;
}

watch(
  () => [settings.globalVoiceId.value, settings.masterVolume.value, settings.masterTimbre.value, settings.theme.value],
  syncFromStore,
  { immediate: true },
);

// El catálogo y los ajustes se piden al abrir el panel (y quedan cacheados).
watch(modelValue, (open) => {
  if (open) {
    error.value = '';
    void catalog.load();
    void settings.load();
  }
});

onMounted(() => void settings.load());

const masterVolumeLabel = computed(() => `${Math.round(masterVolume.value * 100)} %`);
const masterTimbreLabel = computed(() => masterTimbre.value.toFixed(2));

/**
 * Items del selector: una cabecera por motor con sus voces en el orden que ya trae
 * el backend (español primero). **No hay ninguna lista de voces escrita a mano**:
 * si Piper no está instalado, su grupo simplemente no aparece. Si la voz global
 * guardada no está en el catálogo (motor apagado, id escrito a mano en SQLite), se
 * añade para que el selector no quede en blanco.
 */
const voiceItems = computed(() => {
  const items = [];

  for (const group of catalog.groups.value) {
    items.push({ type: 'subheader', title: `${group.label} · ${group.voices.length}` });
    for (const item of group.voices) {
      items.push({ value: item.id, title: item.label });
    }
  }

  const current = settings.globalVoiceId.value;
  if (typeof current === 'string' && current !== '' && !items.some((item) => item.value === current)) {
    items.unshift({ type: 'subheader', title: 'Voz global fuera del catálogo' }, { value: current, title: current });
  }

  return items;
});

/** Guarda un patch y, si falla, revierte los controles a lo persistido. */
async function save(key, patch) {
  saving.value = key;
  error.value = '';

  try {
    await settings.save(patch);
  } catch (failure) {
    error.value = failure.message;
    syncFromStore();
  } finally {
    saving.value = '';
  }
}

/**
 * Guardado del slider. `@end` (ratón o dedo) guarda al instante; cualquier otro
 * cambio —el teclado, que **no** emite `end` en Vuetify— guarda tras una pausa,
 * que además colapsa el arrastre en una sola petición. Es la misma receta que
 * `UserActions.vue` (T-011).
 */
const SLIDER_SAVE_DELAY_MS = 350;
let sliderTimer = null;

const cancelPendingSlider = () => {
  if (sliderTimer !== null) {
    window.clearTimeout(sliderTimer);
    sliderTimer = null;
  }
};

onBeforeUnmount(cancelPendingSlider);

const saveMasterVolume = (value) => {
  cancelPendingSlider();
  return save('masterVolume', { masterVolume: Number(value) });
};

const queueMasterVolume = (value) => {
  cancelPendingSlider();
  sliderTimer = window.setTimeout(() => {
    sliderTimer = null;
    void save('masterVolume', { masterVolume: Number(value) });
  }, SLIDER_SAVE_DELAY_MS);
};

const saveMasterTimbre = (value) => {
  cancelPendingSlider();
  return save('masterTimbre', { masterTimbre: Number(value) });
};

const queueMasterTimbre = (value) => {
  cancelPendingSlider();
  sliderTimer = window.setTimeout(() => {
    sliderTimer = null;
    void save('masterTimbre', { masterTimbre: Number(value) });
  }, SLIDER_SAVE_DELAY_MS);
};

const saveTheme = (value) => save('theme', { theme: value === true ? THEMES.dark : THEMES.light });

const saveVoice = (value) => {
  if (typeof value !== 'string' || value === '') {
    // El selector no tiene item "sin voz": siempre hay una voz global.
    syncFromStore();
    return Promise.resolve();
  }
  return save('globalVoiceId', { globalVoiceId: value });
};
</script>

<template>
  <v-dialog v-model="modelValue" max-width="520" scrollable>
    <v-card data-testid="settings-dialog">
      <v-card-title class="d-flex align-center ga-2">
        <v-icon icon="mdi-cog-outline" size="small" />
        <span>Ajustes globales</span>
        <v-spacer />
        <v-btn
          data-testid="settings-close-icon"
          density="comfortable"
          icon="mdi-close"
          title="Cerrar"
          variant="text"
          @click="modelValue = false"
        />
      </v-card-title>

      <v-card-text>
        <div class="text-caption text-medium-emphasis mb-1">Voz global del canal</div>

        <!--
          Es un `v-select` (no un autocomplete) a conciencia, igual que el selector
          del panel de usuario (T-011): el menú de Vuetify **virtualiza**, así que
          con los tres motores registrados (47 voces) el grupo del último motor se
          alcanza **scrolleando** el menú. `v-autocomplete` no sirve tal cual —su
          caja de texto conserva el título de la voz elegida y lo que se escribe se
          **añade** a ese texto—; hacerlo bien pide `v-model:search` vaciándose en
          `@update:menu`, y queda anotado en el exec-plan como mejora.
        -->
        <v-select
          v-model="voice"
          data-testid="settings-voice"
          density="compact"
          :disabled="saving === 'globalVoiceId'"
          hide-details
          item-title="title"
          item-value="value"
          :items="voiceItems"
          label="Voz de quien no tiene voz propia"
          :loading="catalog.isLoading.value"
          :menu-props="{ maxHeight: 320 }"
          no-data-text="No hay voces disponibles."
          variant="outlined"
          @update:model-value="saveVoice"
        />

        <div class="text-caption text-medium-emphasis mt-1" data-testid="settings-voice-hint">
          Se aplica desde el mensaje siguiente a quien no tenga voz asignada ni voz de comando; el tono de cada
          usuario no cambia.<template v-if="catalog.total.value > 0"> · {{ catalog.total.value }} voces disponibles</template>
        </div>

        <v-divider class="my-4" />

        <div class="d-flex align-center justify-space-between">
          <span class="text-caption text-medium-emphasis">Volumen maestro del TTS</span>
          <span class="text-caption" data-testid="settings-master-volume-value">{{ masterVolumeLabel }}</span>
        </div>
        <v-slider
          v-model="masterVolume"
          color="primary"
          data-testid="settings-master-volume"
          density="compact"
          :disabled="saving === 'masterVolume'"
          hide-details
          :max="1"
          :min="0"
          prepend-icon="mdi-volume-high"
          :step="0.05"
          @end="saveMasterVolume"
          @update:model-value="queueMasterVolume"
        />
        <div class="text-caption text-medium-emphasis" data-testid="settings-master-volume-hint">
          Escala el volumen individual de cada usuario en toda la reproducción.
        </div>

        <v-divider class="my-4" />

        <div class="d-flex align-center justify-space-between">
          <span class="text-caption text-medium-emphasis">Timbre maestro del TTS</span>
          <span class="text-caption" data-testid="settings-master-timbre-value">{{ masterTimbreLabel }}</span>
        </div>
        <v-slider
          v-model="masterTimbre"
          color="primary"
          data-testid="settings-master-timbre"
          density="compact"
          :disabled="saving === 'masterTimbre'"
          hide-details
          :max="2"
          :min="0"
          prepend-icon="mdi-waveform"
          :step="0.05"
          @end="saveMasterTimbre"
          @update:model-value="queueMasterTimbre"
        />
        <div class="text-caption text-medium-emphasis" data-testid="settings-master-timbre-hint">
          Desplaza el timbre individual de cada usuario antes de sintetizar (1 = sin cambio).
        </div>

        <v-divider class="my-4" />

        <v-switch
          v-model="dark"
          color="primary"
          data-testid="settings-theme"
          density="compact"
          :disabled="saving === 'theme'"
          hide-details
          :label="dark ? 'Tema oscuro' : 'Tema claro'"
          :prepend-icon="dark ? 'mdi-weather-night' : 'mdi-white-balance-sunny'"
          @update:model-value="saveTheme"
        />

        <v-alert
          v-if="catalog.error.value"
          class="mt-3"
          data-testid="settings-catalog-error"
          density="compact"
          type="warning"
          variant="tonal"
        >
          {{ catalog.error.value }}
        </v-alert>

        <v-alert
          v-if="settings.error.value"
          class="mt-3"
          data-testid="settings-load-error"
          density="compact"
          type="warning"
          variant="tonal"
        >
          {{ settings.error.value }}
        </v-alert>

        <v-alert v-if="error" class="mt-3" data-testid="settings-error" density="compact" type="error" variant="tonal">
          {{ error }}
        </v-alert>
      </v-card-text>

      <v-card-actions>
        <v-spacer />
        <v-btn data-testid="settings-close" variant="text" @click="modelValue = false">Cerrar</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
