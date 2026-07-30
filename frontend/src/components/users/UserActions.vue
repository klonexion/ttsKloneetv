<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { saveUserPreferences } from '../../stores/users.js';
import { GLOBAL_VOICE_VALUE, useVoiceCatalog } from '../../stores/voices.js';
import { USER_FLAG_ICONS, describeVoiceSource } from '../../utils/user-format.js';

/**
 * Acciones por usuario (T-011): rellena el hueco que dejó T-007 en el panel de
 * detalle con los controles funcionales —silenciar el TTS, ignorar, volumen,
 * pitch y voz—.
 *
 * Cómo se comporta, y por qué:
 *
 * - **Escribe siempre por el backend** (`saveUserPreferences`), nunca en el store:
 *   SQLite es la autoridad y el pipeline lo relee en cada mensaje, así que el
 *   cambio aplica al siguiente mensaje del usuario **sin reiniciar nada**.
 * - Los controles se pintan desde `props.user`, que se refresca con la trama
 *   `users:list` y con la respuesta del `PATCH`. Si una escritura falla, el
 *   control vuelve al valor guardado y el aviso queda a la vista.
 * - Los sliders guardan **al soltar** (`@end`) y, con un pequeño retardo, en
 *   cualquier otro cambio: Vuetify emite `end` solo con ratón o dedo, así que sin
 *   la segunda vía mover el slider con el teclado no guardaría nada. El retardo es
 *   lo que evita una petición por pixel durante el arrastre.
 * - **Timbre** es un control aparte del pitch, mismo patrón (slider + dado para
 *   rodar uno al azar): cambia la textura de la síntesis (ruido de generador en
 *   Piper/MeloTTS, una variación de velocidad chica en edge-tts/SAPI/Loquendo)
 *   en vez del tono. Ver `backend/src/tts/voice-model.js` para el porqué.
 * - El selector de voz se alimenta de `GET /api/voices` (agrupado por motor,
 *   español primero). Elegir una voz aquí es un `override` del streamer: lo marca
 *   el backend, y **no cambia la voz global**. Con los tres motores registrados el
 *   catálogo pasa de 45 voces y el menú de Vuetify virtualiza, así que el grupo del
 *   último motor se alcanza scrolleando (ver el comentario del template).
 */
const props = defineProps({
  user: {
    type: Object,
    required: true,
  },
});

/** Rango del slider de pitch: útil sin llegar a lo irreconocible (la API acepta 0–2). */
const PITCH_MIN = 0.5;
const PITCH_MAX = 1.5;
const PITCH_STEP = 0.05;

/** Mismo rango que el pitch: ver la constante de arriba. */
const TIMBRE_MIN = 0.5;
const TIMBRE_MAX = 1.5;
const TIMBRE_STEP = 0.05;

const catalog = useVoiceCatalog();

/** Preferencia que se está guardando (`''` = ninguna): deshabilita solo esa. */
const saving = ref('');
const error = ref('');

const muted = ref(false);
const ignored = ref(false);
const volume = ref(1);
const pitch = ref(1);
const timbre = ref(1);
const voice = ref(GLOBAL_VOICE_VALUE);

/** Vuelve a poner los controles en lo que dice la fila guardada. */
function syncFromUser() {
  const user = props.user;
  muted.value = user.muted === true;
  ignored.value = user.ignored === true;
  volume.value = typeof user.volume === 'number' ? user.volume : 1;
  pitch.value = typeof user.pitch === 'number' ? user.pitch : 1;
  timbre.value = typeof user.timbre === 'number' ? user.timbre : 1;
  voice.value = typeof user.voiceId === 'string' && user.voiceId !== '' ? user.voiceId : GLOBAL_VOICE_VALUE;
}

watch(() => props.user, syncFromUser, { immediate: true, deep: true });

// El catálogo se pide al abrir el panel (y queda cacheado para las veces siguientes).
onMounted(() => void catalog.load());

const volumeLabel = computed(() => `${Math.round(volume.value * 100)} %`);
const pitchLabel = computed(() => pitch.value.toFixed(2));
const timbreLabel = computed(() => timbre.value.toFixed(2));
const voiceSourceLabel = computed(() => describeVoiceSource(props.user.voiceSource));

/**
 * Items del selector: "voz global" primero, después una cabecera por motor con sus
 * voces en el orden que ya trae el backend (español primero). Si el usuario tiene
 * una voz que no está en el catálogo (motor apagado, id escrito a mano), se añade
 * para que el selector la muestre en vez de quedar en blanco.
 */
const voiceItems = computed(() => {
  const items = [{ value: GLOBAL_VOICE_VALUE, title: 'Voz global del canal' }];

  for (const group of catalog.groups.value) {
    items.push({ type: 'subheader', title: `${group.label} · ${group.voices.length}` });
    for (const item of group.voices) {
      items.push({ value: item.id, title: item.label });
    }
  }

  const current = props.user.voiceId;
  if (typeof current === 'string' && current !== '' && !items.some((item) => item.value === current)) {
    items.push({ type: 'subheader', title: 'Voz asignada fuera del catálogo' }, { value: current, title: current });
  }

  return items;
});

/** Guarda un patch y, si falla, revierte los controles a lo persistido. */
async function save(key, patch) {
  saving.value = key;
  error.value = '';

  try {
    await saveUserPreferences(props.user.userId, {
      ...patch,
      // Si el usuario todavía no tiene fila (un presente que no ha escrito), el
      // backend la crea y necesita su nombre para no guardar solo el id.
      username: props.user.username,
      displayName: props.user.displayName,
    });
  } catch (failure) {
    error.value = failure.message;
    syncFromUser();
  } finally {
    saving.value = '';
  }
}

/**
 * Guardado de los sliders. `@end` (ratón o dedo) guarda al instante; cualquier
 * otro cambio —el teclado, que no emite `end`— guarda tras una pausa, que además
 * colapsa el arrastre en una sola petición.
 */
const SLIDER_SAVE_DELAY_MS = 350;
let sliderTimer = null;

const cancelPendingSlider = () => {
  if (sliderTimer !== null) {
    window.clearTimeout(sliderTimer);
    sliderTimer = null;
  }
};

const saveSliderSoon = (key, patch) => {
  cancelPendingSlider();
  sliderTimer = window.setTimeout(() => {
    sliderTimer = null;
    void save(key, patch);
  }, SLIDER_SAVE_DELAY_MS);
};

const saveSliderNow = (key, patch) => {
  cancelPendingSlider();
  return save(key, patch);
};

onBeforeUnmount(cancelPendingSlider);

const saveMuted = (value) => save('muted', { muted: value === true });
const saveIgnored = (value) => save('ignored', { ignored: value === true });
const saveVolume = (value) => saveSliderNow('volume', { volume: Number(value) });
const queueVolume = (value) => saveSliderSoon('volume', { volume: Number(value) });
const savePitch = (value) => saveSliderNow('pitch', { pitch: Number(value) });
const queuePitch = (value) => saveSliderSoon('pitch', { pitch: Number(value) });
const rollPitch = () => saveSliderNow('pitch', { rerollPitch: true });
const saveTimbre = (value) => saveSliderNow('timbre', { timbre: Number(value) });
const queueTimbre = (value) => saveSliderSoon('timbre', { timbre: Number(value) });
const rollTimbre = () => saveSliderNow('timbre', { rerollTimbre: true });
const saveVoice = (value) =>
  save('voice', { voiceId: value === GLOBAL_VOICE_VALUE || value === null ? null : String(value) });
</script>

<template>
  <div class="user-actions" data-testid="user-actions">
    <v-divider class="mb-3" />

    <div class="text-caption text-medium-emphasis mb-1">Acciones</div>

    <v-switch
      v-model="muted"
      color="warning"
      data-testid="user-actions-muted"
      density="compact"
      hide-details
      :disabled="saving === 'muted'"
      :label="muted ? 'TTS silenciado (no se lee)' : 'Silenciar el TTS de este usuario'"
      :prepend-icon="USER_FLAG_ICONS.muted"
      @update:model-value="saveMuted"
    />

    <v-switch
      v-model="ignored"
      color="error"
      data-testid="user-actions-ignored"
      density="compact"
      hide-details
      :disabled="saving === 'ignored'"
      :label="ignored ? 'Ignorado (ni se muestra ni se lee)' : 'Ignorar a este usuario'"
      :prepend-icon="USER_FLAG_ICONS.ignored"
      @update:model-value="saveIgnored"
    />

    <div class="mt-3">
      <div class="d-flex align-center justify-space-between">
        <span class="text-caption text-medium-emphasis">Volumen</span>
        <span class="text-caption" data-testid="user-actions-volume-value">{{ volumeLabel }}</span>
      </div>
      <v-slider
        v-model="volume"
        color="primary"
        data-testid="user-actions-volume"
        density="compact"
        hide-details
        :max="1"
        :min="0"
        :step="0.05"
        @end="saveVolume"
        @update:model-value="queueVolume"
      />
    </div>

    <div>
      <div class="d-flex align-center justify-space-between">
        <span class="text-caption text-medium-emphasis">Pitch (tono)</span>
        <span class="text-caption" data-testid="user-actions-pitch-value">{{ pitchLabel }}</span>
      </div>
      <div class="d-flex align-center ga-1">
        <v-slider
          v-model="pitch"
          class="flex-grow-1"
          color="primary"
          data-testid="user-actions-pitch"
          density="compact"
          hide-details
          :max="PITCH_MAX"
          :min="PITCH_MIN"
          :step="PITCH_STEP"
          @end="savePitch"
          @update:model-value="queuePitch"
        />
        <v-btn
          data-testid="user-actions-pitch-roll"
          density="comfortable"
          icon="mdi-dice-5-outline"
          :loading="saving === 'pitch'"
          title="Rodar un tono nuevo al azar"
          variant="text"
          @click="rollPitch"
        />
      </div>
    </div>

    <div>
      <div class="d-flex align-center justify-space-between">
        <span class="text-caption text-medium-emphasis">Timbre</span>
        <span class="text-caption" data-testid="user-actions-timbre-value">{{ timbreLabel }}</span>
      </div>
      <div class="d-flex align-center ga-1">
        <v-slider
          v-model="timbre"
          class="flex-grow-1"
          color="primary"
          data-testid="user-actions-timbre"
          density="compact"
          hide-details
          :max="TIMBRE_MAX"
          :min="TIMBRE_MIN"
          :step="TIMBRE_STEP"
          @end="saveTimbre"
          @update:model-value="queueTimbre"
        />
        <v-btn
          data-testid="user-actions-timbre-roll"
          density="comfortable"
          icon="mdi-dice-6-outline"
          :loading="saving === 'timbre'"
          title="Rodar un timbre nuevo al azar"
          variant="text"
          @click="rollTimbre"
        />
      </div>
    </div>

    <!--
      Es un `v-select` (no un autocomplete) a conciencia. El menú **virtualiza**:
      con los tres motores registrados el catálogo pasa de 45 voces y el grupo del
      último motor (Piper) se alcanza **scrolleando** el menú, que es lo verificado
      en navegador. Se probó `v-autocomplete` para poder filtrar y se descartó: su
      caja de texto contiene el título de la voz ya elegida y escribir **se añade**
      a ese texto ("Voz global del canalpiper"), así que el filtro no encuentra nada
      hasta que el usuario borra a mano. Para hacerlo bien hace falta `v-model:search`
      vaciándose al abrir el menú; queda anotado en el exec-plan como mejora.
    -->
    <v-select
      v-model="voice"
      class="mt-1"
      data-testid="user-actions-voice"
      density="compact"
      :disabled="saving === 'voice'"
      hide-details
      item-title="title"
      item-value="value"
      :items="voiceItems"
      label="Voz"
      :loading="catalog.isLoading.value"
      :menu-props="{ maxHeight: 320 }"
      no-data-text="No hay voces disponibles."
      variant="outlined"
      @update:model-value="saveVoice"
    />

    <div class="text-caption text-medium-emphasis mt-1" data-testid="user-actions-voice-source">
      {{ voiceSourceLabel }}<template v-if="catalog.total.value > 0"> · {{ catalog.total.value }} voces disponibles</template>
    </div>

    <v-alert v-if="catalog.error.value" class="mt-2" density="compact" data-testid="user-actions-catalog-error" type="warning" variant="tonal">
      {{ catalog.error.value }}
    </v-alert>

    <v-alert v-if="error" class="mt-2" density="compact" data-testid="user-actions-error" type="error" variant="tonal">
      {{ error }}
    </v-alert>
  </div>
</template>

<style scoped>
.user-actions {
  min-width: 0;
}
</style>
