---
name: tts-en-navegador-headless
description: Chrome headless no puede hablar (0 voces y speak() -> not-allowed); cómo verificar la cola TTS de forma determinista con el diagnóstico window.__ttsHub que dejó T-008.
metadata:
  type: project
---

En Chrome headless de esta máquina (verificado 2026-07-24, Chrome 150):
`typeof speechSynthesis !== 'undefined'` pero `getVoices().length === 0` y cada
`speak()` termina en `error: not-allowed`. **No hay forma de "oír" nada en la
verificación**, así que cualquier tarea TTS (T-009 edge, T-010 Piper, T-011
voz/pitch) tiene que verificar el comportamiento observable y dejar la
audibilidad al operador, diciéndolo explícitamente en el reporte.

Lo que T-008 dejó montado para eso, y conviene reutilizar en vez de reinventar:

- **`window.__ttsHub`** (solo con `import.meta.env.DEV`, en
  `frontend/src/stores/tts-queue.js`): `state` (tamaño, pendientes en orden,
  actual, paused, blocked, totales), `spoken` (registro ordenado de lo que se
  pidió hablar, con voz/pitch/volumen), los controles (`skip`/`clear`/`pause`/
  `resume`/`enqueue`/`reset`) y **`registerEngine()`**.
- **El truco clave:** registrar por `registerEngine()` un motor instrumentado que
  guarda los `onEnd` y **no termina solo**. Así la cola se queda quieta y se puede
  medir el orden FIFO, el indicador y cada control sin depender de audio ni de
  temporizaciones. Para el motor real basta leer `spoken`, que se escribe en el
  momento de pedir la síntesis (antes de cualquier audio).
- El motor del navegador tiene un **watchdog de 4 s**: si la síntesis no arranca,
  la cola avanza. Sin eso, en headless la cola se quedaría bloqueada para siempre
  y toda verificación de ráfagas sería imposible.

**Pero un `<audio>` SÍ funciona en headless** (T-009, 2026-07-25): lo que está
roto es Web Speech, no la reproducción de audio. Un motor de servidor (edge, y
mañana Piper) que baja un MP3 y lo pone en un `HTMLAudioElement` **se reproduce de
verdad y dispara `ended`** en `--headless=new`, así que su camino sí se puede
verificar de punta a punta. Dos condiciones:

- lanzar Chrome con `--autoplay-policy=no-user-gesture-required` (sin eso `play()`
  rechaza con `NotAllowedError` y el motor cae al respaldo);
- medir `finishedTotal`/`size` de `window.__ttsHub.state`, no "que se oiga".

**Correlaciona el registro por id de mensaje, no por longitud** (T-013): con los
motores reales cada enunciado dura ~2 s, así que la cola va **por detrás** de las
inyecciones. Un `waitFor` del tipo «`spoken.length` creció» resuelve con la entrada
de un mensaje **anterior**, y leer `spoken[spoken.length - 1]` mide otra cosa: tres
comprobaciones fallaron así en una corrida y el diagnóstico apuntaba al producto.
El mando `/_fake/eventsub/say` devuelve `{ id }`, que es el mismo `id` que usa la
cola: espera `spoken.find(e => e.id === id)` con timeout de ~30 s.

**Trampa de CDP al leer los items de la cola** (T-009): los objetos que viven
dentro de un `ref([])` de Vue son **Proxies reactivos**, y `Runtime.evaluate` con
`returnByValue` los serializa como `{}` en cuanto están anidados (`item.audio` sale
vacío aunque en la página `item.audio.url` funcione). Al instrumentar la cola,
guarda **primitivas** (`audioUrl: String(item.audio.url)`), no subobjetos.

**Why:** sin esto, la única "verificación" posible de un motor TTS sería mirar que
compila, y el criterio "Verify in browser" se cumpliría en falso.

**How to apply:** en la verificación por CDP ([[verificacion-en-navegador]]),
inyectar mensajes con `backend/scripts/fake-eventsub.js` y leer/accionar por
`window.__ttsHub`. Contar los avisos `not-allowed` como esperados, no como
errores de consola. Ver [[gates-de-verificacion]].
