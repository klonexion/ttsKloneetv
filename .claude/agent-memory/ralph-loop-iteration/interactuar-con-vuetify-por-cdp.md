---
name: interactuar-con-vuetify-por-cdp
description: Cómo accionar controles de Vuetify (switch, slider, v-select con menú) desde CDP sin falsos verdes, que el menú del select virtualiza, y por qué v-autocomplete no sustituye a v-select sin más.
metadata:
  type: project
---

Al verificar controles de Vuetify por CDP ([[verificacion-en-navegador]]), lo que
funciona (comprobado en T-011, Chrome 150):

- **`v-switch`:** clic de ratón real (`Input.dispatchMouseEvent` en el centro del
  `input[type=checkbox]`, que aunque esté a `opacity: 0` ocupa el área del control).
  `input.click()` también sirve.
- **`v-list-item` de un menú abierto (`v-select`):** usar **`el.click()`** por
  `Runtime.evaluate`, no coordenadas. VListItem escucha `click` en el nodo, y con
  coordenadas la selección no se aplicaba (el panel se quedaba en el valor viejo sin
  ningún aviso de error).
- **Abrir el menú del `v-select`:** clic de ratón real sobre `.v-field`. Después,
  `document.querySelector('.v-overlay--active .v-list')` es el menú (el diálogo
  también es un overlay activo, pero no contiene ninguna `.v-list`).
- **El menú de `v-select` VIRTUALIZA.** Con 46 items solo se renderizaban 44, y con
  47 (al sumarse un motor TTS) el **último grupo entero desaparecía del DOM**: una
  aserción sobre «están todas las cabeceras» falla aunque la UI esté bien, y otra
  sobre «existe el grupo X» falla aunque el usuario pueda llegar scrolleando. Para
  medirlo hay que **ir scrolleando el contenedor y acumular** lo visto en cada
  ventana (`box.scrollTop += box.clientHeight * 0.8`), nunca leer una sola ventana.
- **`v-autocomplete` no es un `v-select` con filtro.** Su caja de texto contiene el
  título del valor ya elegido y lo que se escribe **se añade** a ese texto
  («Voz global del canal» + «piper» → cero resultados). No hay select-all al enfocar
  (`onFocusin` no lo hace). Para que el filtro sirva con un valor ya seleccionado hay
  que llevar `v-model:search` y vaciarlo en `@update:menu`. Escribir en él por CDP
  necesita `Input.insertText` (los eventos `type: 'char'` no llegan al v-model).
- **`v-slider`:** `.v-slider-thumb` es enfocable; `focus()` + `Input.dispatchKeyEvent`
  con `ArrowLeft`/`ArrowRight` mueve un paso. **`code` tiene que ser el string del
  código físico** (`code: 'ArrowLeft'`), no el número: pasarle el
  `windowsVirtualKeyCode` hace fallar la llamada con «Failed to deserialize
  params.code - BINDINGS: string value expected», que parece un problema del entorno. **Suele perderse la primera pulsación**
  (seis flechas movieron cinco pasos), así que no asertes un valor exacto contra el
  número de pulsaciones: lee el valor que muestra la UI y compara **eso** con lo que
  llegó al backend.

Dos trampas de producto que salieron de aquí, no de la verificación:

- **`v-slider` emite `end` solo con ratón o dedo.** Si el guardado cuelga únicamente
  de `@end`, mover el slider con el **teclado** no guarda nada (bug de accesibilidad
  real). Hay que guardar también en `@update:model-value`, con un pequeño retardo que
  colapse el arrastre en una sola petición.
- **Los pasos del slider producen ruido de coma flotante** (`1 - 0.05*2 =
  0.8999999999999999`) y eso llega tal cual a SQLite y a la API. Redondear en el
  backend, que es donde se persiste.

**La columna de usuarios se reordena por actividad**, así que `nth=0` **no** es el
usuario que crees: abrir el panel «del primero» hizo que siete comprobaciones
midieran a otra persona (y una de ellas *pasó* igual, que es lo peligroso). Localiza
la fila por su texto (`findIndex(el => el.textContent.includes(nombre))`) y confirma
después que el diálogo muestra ese nombre.

**Why:** cada uno de estos puntos costó al menos una corrida de la verificación (~4
min cada una), y el de `nth=0` produjo un diagnóstico completamente equivocado.

**How to apply:** en cualquier iteración que accione UI por CDP. Ver
[[gates-de-verificacion]] y [[tts-en-navegador-headless]].
