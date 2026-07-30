---
name: imitador-de-servicios-externos
description: Patrón validado en T-003 (OAuth), T-004 (EventSub), T-006 (Helix send) y T-007 (Get Chatters) para verificar integraciones externas sin credenciales: URLs base configurables + imitador local en backend/scripts/.
metadata:
  type: project
---

Cuando una tarea integra un servicio externo y el operador todavía no puso sus
credenciales (`backend/.env` no existe: está git-ignorado), el patrón que ya
funcionó cuatro veces —T-003 (OAuth), T-004 (EventSub), T-006 (Helix send) y
T-007 (Get Chatters)— es:

1. Implementar contra los endpoints **reales**, leyendo la URL base de
   configuración con el valor real como default (`TWITCH_AUTH_BASE_URL`,
   `TWITCH_API_BASE_URL`, `TWITCH_EVENTSUB_WS_URL`; ver `TWITCH_DEFAULTS` en
   `backend/src/config.js`).
2. Escribir un **imitador** en `backend/scripts/` que hable el mismo contrato,
   exija las credenciales dummy igual que el real y exponga `/_fake/...` con
   contadores y mandos para que las pruebas cuenten llamadas reales y provoquen
   escenarios (reconexión, caída, entrega duplicada).
3. Un script de humo que levante el imitador **y el backend real como proceso
   hijo** apuntado a él, con `DB_FILE` a una base temporal y un puerto libre de
   `net.createServer().listen(0)`.
4. Añadir una comprobación de que **los defaults siguen siendo los endpoints
   reales**, para que el imitador no se cuele en producción.

Piezas ya escritas y reutilizables:

- `scripts/fake-twitch.js` — OAuth (`/oauth2/authorize`, `/oauth2/token` con
  rotación del refresh) y `/helix/users`. Exporta `createFakeTwitchApp` (app
  Express con un 404 catch-all al final: **no se le pueden añadir rutas después**)
  y `FAKE_CHANNEL`.
- `scripts/fake-eventsub.js` — WebSocket de EventSub + `POST
  /helix/eventsub/subscriptions`, y **monta `createFakeTwitchApp` como fallback**
  (`app.use(subApp)`), así que un solo proceso sirve de `TWITCH_AUTH_BASE_URL`,
  `TWITCH_API_BASE_URL` y `TWITCH_EVENTSUB_WS_URL`. Ese es el truco para extender
  el imitador sin editar `fake-twitch.js`: app padre con las rutas nuevas primero.
- `scripts/fake-helix-chat.js` (T-006) — `POST /helix/chat/messages` con mandos
  `/_fake/chat/{sent,fail,drop,reset}`; monta `fake-twitch.js` como fallback y
  exporta `createFakeHelixChatRoutes()` (un `express.Router` **sin** catch-all,
  reutilizable dentro de otra app). **T-007 puede sumarle Get Chatters ahí.** Dos
  ideas que valió la pena escribir: (1) si el imitador de EventSub vive en otro
  puerto, basta con **reenviar** `POST /helix/eventsub/subscriptions` a él para que
  un solo `TWITCH_API_BASE_URL` sirva para todo; (2) hacer **eco** del mensaje
  enviado por el mando `say` de EventSub reproduce que Twitch te devuelve tu
  propio mensaje, y así una sola prueba recorre input → Helix → EventSub → `/ws`.
  El contador `rejected` cuenta solo rechazos por headers/parámetros inválidos
  (no los fallos programados), de modo que el gate puede exigir `rejected === 0`
  como prueba de que el backend llama bien.

- `scripts/fake-chatters.js` (T-007) — `GET /helix/chat/chatters` paginado (valida
  bearer, `client-id`, `broadcaster_id`, `moderator_id`, `first` y el cursor) con
  mandos `/_fake/chatters/{set,fail,stats}`; `set` cambia el roster para simular
  entradas y salidas entre polls, y `fail` provoca el 401 por scope. Exporta
  `createFakeChattersApp()` (sin catch-all) y `startFakeChatters({ forwardBaseUrl })`:
  con `forwardBaseUrl` **reenvía por HTTP** lo que no implementa a otro imitador
  (`body: req, duplex: 'half'` para no reserializar), así **dos imitadores en
  puertos distintos se ven como un solo `TWITCH_API_BASE_URL`** y el mismo
  escenario puede consultar chatters *y* recibir mensajes por EventSub. Es la
  generalización de la idea de T-006 y la forma más limpia de combinar imitadores
  sin editar los de otras tareas.

Detalles que hicieron falta y no son obvios:

- Sembrar la sesión escribiendo directo en SQLite con `openDatabase(dbFile)` +
  repositorios es más simple que recorrer el OAuth, pero el `expires_at` debe
  quedar **por encima del margen de refresco (5 min)** o el ciclo de T-003 intenta
  refrescar un refresh token que el imitador no conoce y borra la sesión.
- Los intervalos que el servicio consulta tienen que ser configurables
  (`TWITCH_TOKEN_CHECK_INTERVAL_MS`, `TWITCH_CHAT_SESSION_POLL_MS`) o el gate
  espera segundos por comprobación.
- Nada de estado en memoria: leer SQLite en cada uso permite que el script fuerce
  cambios desde otro proceso (WAL lo hace posible).
- `fetch(url, { redirect: 'manual' })` deja inspeccionar cada 302 del OAuth.
- **Un gate sin control negativo puede pasar en falso.** Comprobar a mano que
  falla al revertir el arreglo (p. ej. `git stash push -- <archivo>`, correr,
  `git stash pop`) es rápido y ha descubierto ya dos aserciones vacías.
- **No leas los contadores del imitador justo después del primer efecto:** si el
  poll hace varias peticiones (paginación), `stats()` puede verse a mitad del
  ciclo. Envolver la aserción en el `waitFor` del propio script evita un falso
  rojo (le pasó a T-007 con la comprobación del cursor).

**Why:** deja la integración verificada de forma determinista y repetible sin
secretos, y el mismo imitador sirve para la verificación en navegador.

**How to apply:** reusar los dos imitadores y sumarles endpoints. Ver
[[gates-de-verificacion]] y [[verificacion-en-navegador]].
