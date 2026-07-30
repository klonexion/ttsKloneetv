---
name: shutdown-backend-cuelga-con-ws
description: El apagado del backend con clientes conectados ya está arreglado en T-004 (terminate + closeAllConnections); aquí queda por qué hacían falta las DOS cosas y cómo evitar reintroducirlo.
metadata:
  type: project
---

**Arreglado en T-004** (antes: `SIGTERM` no terminaba el backend si había un
WebSocket conectado, y T-005/T-003 tuvieron que usar `SIGKILL`). Hicieron falta
**dos** cosas, y con una sola el proceso sigue sin cerrar limpiamente:

1. `wss.close()` **no cierra los sockets ya abiertos**: hay que recorrer
   `wss.clients` con `terminate()` antes, o su callback nunca se llama
   (`backend/src/ws/hub.js`).
2. `server.close()` solo deja de aceptar conexiones nuevas y espera a las
   abiertas. Las **keep-alive del proxy de Vite** no terminan solas y
   `closeIdleConnections()` no basta: hace falta `closeAllConnections()`
   (`backend/src/server.js`). Este segundo caso **no se ve** en una prueba que
   solo use `fetch` + un cliente `ws`; se vio con el navegador real detrás de
   Vite, y se reproduce en pruebas abriendo un socket TCP con una petición HTTP a
   medio escribir (sin el CRLF final), que cuenta como conexión no-ociosa.

`server.js` tiene además un temporizador de seguridad de 5 s que fuerza la salida
y loguea `cierre forzado`. **Ojo al verificar:** con ese temporizador el proceso
sale igual aunque el cierre esté roto, así que una prueba de "SIGTERM termina el
proceso" pasa en falso. `test:eventsub` mide el tiempo (< 2 s) y falla si
aparece `cierre forzado` — replicar ese estilo si se toca el shutdown.

**Why:** el criterio de T-001 (`pm2 stop all` tumba todo) y el gate de
integración final dependen de esto.

**How to apply:** para probar reconexiones ya sirve `SIGTERM` (el frontend pasa a
`Reconectando…`). Si una iteración toca `hub.js` o el shutdown, correr
`npm --prefix backend run test:eventsub` y comprobar que el cierre sigue siendo
de milisegundos. Va junto con [[gates-de-verificacion]] y
[[verificacion-en-navegador]].
