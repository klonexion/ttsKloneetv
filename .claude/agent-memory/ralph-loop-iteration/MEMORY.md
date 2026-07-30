# Memoria — ralph-loop-iteration (streamer-chat-tts-hub)

- [Verificación en navegador](verificacion-en-navegador.md) — sin extensión de Chrome: manejar Chrome headless por CDP con el módulo `ws`, sin añadir dependencias.
- [Puerto 5173 ocupado](puerto-5173-ocupado.md) — un Vite ajeno escucha en `*:5173`; verifica por `<title>` y `lsof`, no por código HTTP.
- [Este repo no es YardOS](no-es-yardos.md) — npm sin workspaces, JS puro sin typecheck, sin `scripts/ralph.sh`; ignora los non-negotiables de YardOS.
- [Gates de verificación](gates-de-verificacion.md) — comandos exactos: lint por paquete, build del frontend y los once `test:*` del backend (con la ruta correcta de `TTS_PIPER_DIR`); y cómo probar sin choques de puerto.
- [Empaquetado de Piper](piper-empaquetado.md) — el tar de macOS viene sin dylib y el binario sin `LC_RPATH`; el zip de Windows sí está completo; flags reales del CLI.
- [Imitar servicios externos](imitador-de-servicios-externos.md) — URLs base configurables + imitador en `backend/scripts/`: verifica integraciones sin credenciales reales.
- [Apagado del backend](shutdown-backend-cuelga-con-ws.md) — arreglado en T-004; hacen falta `terminate()` de los clientes **y** `closeAllConnections()`, y el temporizador de 5 s enmascara regresiones.
- [better-sqlite3 no compila](better-sqlite3-sin-compilar.md) — 13.x trae prebuilds N-API en el tarball (incluido win32-x64): sin node-gyp ni build tools.
- [TTS en navegador headless](tts-en-navegador-headless.md) — headless no habla (Web Speech), pero un `<audio>` sí suena; verifica por `window.__ttsHub` y ojo con los Proxies de Vue en CDP.
- [Trampas de edge-tts-universal](edge-tts-universal-trampas.md) — promesas que nunca rechazan, pitch en Hz, y por qué el temporizador del timeout no se puede `unref()`.
- [Editar en el worktree, no en el repo](editar-en-el-worktree-no-en-el-repo.md) — es fácil tocar el exec-plan del checkout principal por inercia: cómo detectarlo y moverlo sin perderlo.
- [Merge de package.json](merge-de-package-json.md) — el único conflicto recurrente al mergear `main`: resuélvelo como unión de scripts, verificando las etapas 1/2/3.
- [Control negativo sin git checkout](control-negativo-sin-git-checkout.md) — sabotea con `perl -0pi` y restaura desde una copia: `git checkout --` borra el trabajo sin commitear.
- [Interactuar con Vuetify por CDP](interactuar-con-vuetify-por-cdp.md) — switch/slider/select: qué clic usa cada uno, el `end` que el teclado no dispara y por qué `nth=0` engaña.
- [Estado en memoria tras reiniciar](estado-en-memoria-tras-reiniciar.md) — chat, columna de usuarios y cola se vacían al reiniciar el backend: no es una regresión, inyecta un mensaje nuevo.
- [NOT NULL y "sin asignar"](columnas-not-null-y-valor-sin-asignar.md) — `users.pitch/volume` no admiten null: lo aleatorio se reparte al INSERTAR y puede coincidir con el default.
