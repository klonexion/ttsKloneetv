---
name: verificacion-en-navegador
description: Cómo cumplir el criterio "Verify in browser" en esta máquina sin la extensión de Chrome (headless Chrome por CDP), con las trampas ya resueltas.
metadata:
  type: project
---

Para el criterio **"Verify in browser"** (lo piden T-001, T-003, T-005–T-013 del
exec-plan) no hay herramientas de navegador disponibles: la extensión Claude in
Chrome **no está conectada**, así que `mcp__claude-in-chrome__*` falla. Chrome sí
está instalado en `/Applications/Google Chrome.app` y se maneja por CDP sin
añadir dependencias al repo:

1. Lanzar `--headless=new --remote-debugging-port=<puerto propio>
   --user-data-dir=<scratchpad>/chrome-profile-<tarea>`. **Elige un puerto CDP
   distinto del 9222 por tarea** (p. ej. 9231): varios subagentes en paralelo
   hacen `pkill -9 -f "remote-debugging-port=9222"` al arrancar y te matan Chrome a
   media corrida (le pasó a T-007 con T-006/T-008 corriendo a la vez).
2. Hablar CDP con el módulo `ws` que ya vive en `backend/node_modules` (script
   `.mjs` **en el scratchpad, nunca en el repo**): `Target.createTarget` +
   `Target.attachToTarget {flatten:true}`, `Emulation.setDeviceMetricsOverride`
   para cada tamaño de pantalla exigido, `Runtime.evaluate` para leer el DOM real
   y `Page.captureScreenshot` a un PNG que se lee con la tool Read.
3. Suscribirse a `Runtime.consoleAPICalled` y `Runtime.exceptionThrown` para
   reportar errores de consola, no solo "compiló".
4. Al terminar: `pkill -9 -f "remote-debugging-port=9222"`.

**Escribir en un input de Vue por CDP** (T-006): `Runtime.evaluate` con
`element.focus()` + `Input.insertText { text }` dispara el evento `input` real, así
que el `v-model` se entera; luego `Input.dispatchKeyEvent` (`keyDown` + `keyUp`,
`key: 'Enter'`, `windowsVirtualKeyCode: 13`, `text: '\r'`) activa
`@keydown.enter`. Asignar `input.value` a mano **no** actualiza el modelo. Para
borrar, mandar `Backspace` una vez por carácter.

Trampas ya pagadas (T-005, 2026-07-24; T-006, 2026-07-24):

- **No sondees con `fetch` un puerto cuyo servidor se está cayendo:** undici tira
  `Error: setTypeOfService EINVAL` **fuera** de la promesa y mata el proceso de
  Node (se comió una corrida entera). Para esperar a que el backend muera, usa el
  evento `exit` del proceso hijo (o `net.connect`), no `fetch`.
- **Con el backend caído, el `fetch` del navegador no rechaza:** el proxy de Vite
  responde `500` sin JSON. Si el criterio pide "aviso visible cuando falla",
  hay que cubrir ese caso además del `TypeError` de red, o el aviso sale vacío.

- **Mata Chrome antes de relanzarlo.** Si un run anterior murió sin `chrome.kill()`,
  el nuevo proceso no puede tomar el puerto y `fetch /json/version` te devuelve el
  navegador viejo (misma sesión, DOM equivocado).
- **Ponle timeout a cada llamada CDP y escucha el `close` del WebSocket** (T-007):
  si Chrome muere a media corrida, una promesa pendiente sin timeout deja el
  script colgado para siempre (se perdió una corrida de 7 min así) y encima los
  servidores de apoyo siguen escuchando; hay que rechazar y pasar por el `finally`
  que los apaga.
- **Los `v-*` de Vuetify tienen props con nombres de atributos HTML**: `v-list-item`
  toma `title` como prop y pinta el tooltip **como texto** en la fila. Si algo se
  ve duplicado en la captura, sospecha de eso antes que del CSS. Mirar la captura
  con la tool Read (no solo aserciones de DOM) es lo que lo descubrió.
- **`innerText` de un botón oculto por `v-show` devuelve ""**: para localizar
  elementos condicionales usa `textContent`, no `innerText`.
- **Los servidores de apoyo no sobreviven al final del comando Bash.** `nohup` +
  `&` funciona dentro de un run; `setsid` **no existe en macOS**. Si un script de
  verificación necesita reiniciar el backend a mitad, que lo relance él mismo con
  `spawn(..., { detached: true })`.
- **Vite escucha en `[::1]`, no en `127.0.0.1`** (T-010): esperarlo con
  `net.connect({ host: '127.0.0.1' })` da timeout aunque esté arriba y perfectamente
  servible por `http://localhost:<puerto>`. Espéralo con un `fetch` a `localhost` y
  **comprueba que el HTML es el de este repo** (`index.html` referencia
  `/src/main.js`), que además distingue del dev server ajeno del 5173
  ([[puerto-5173-ocupado]]).
- **Un script de verificación en el scratchpad no resuelve especificadores desnudos**
  (`import { WebSocket } from 'ws'` falla aunque se lance con `cwd` en `backend/`):
  hay que importar por ruta absoluta desde `backend/node_modules/`, y `ws` es CommonJS,
  así que se importa el default y se desestructura.
- `assert.notMatch` **no existe** en `node:assert/strict`; es `assert.doesNotMatch`
  (falla como "assert.notMatch is not a function", que parece un error del entorno).
- Para inyectar datos sin que exista aún el productor real (p. ej. verificar el
  render de `/ws` antes de que T-004 traiga EventSub): un harness en el scratchpad
  que **importe el backend real** (`createApp` + `createWsHub`) y añada una ruta
  local que llame a `broadcast()`. Ejercita el camino real sin editar el repo.

**Why:** verificar de verdad es obligatorio y falsificar verde no es opción; sin
esta ruta la única alternativa sería instalar un navegador headless como
dependencia, lo que contaminaría el repo.

**How to apply:** úsalo en cualquier iteración cuyo criterio de aceptación diga
"Verify in browser". Va junto con [[puerto-5173-ocupado]] y
[[shutdown-backend-cuelga-con-ws]].
