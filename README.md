# Streamer Chat TTS Hub — Fase 1 (Twitch)

App web **local** para el streamer: ve el chat de Twitch en vivo, escribe en él y
lo escucha por TTS con voces distinguibles por usuario. Un solo usuario,
corriendo en la máquina del streamer (desarrollo en macOS, producción en
Windows 11).

- **Instalación en Windows 11 paso a paso: [`WINDOWS.md`](WINDOWS.md)**
- Diseño y alcance: [`docs/decisiones.md`](docs/decisiones.md) (fuente de verdad)
- Plan de ejecución: [`docs/exec-plans/active/streamer-chat-tts-hub.md`](docs/exec-plans/active/streamer-chat-tts-hub.md)

## Requisitos

- **Node.js ≥ 20** (probado con v24) y npm.
- Una app registrada en <https://dev.twitch.tv/console/apps> con el redirect URI
  `http://localhost:3000/auth/callback`.
- **PM2 no necesita instalación global**: viene como dependencia de desarrollo de
  la raíz y se invoca desde los scripts de npm (funciona igual en macOS y en
  Windows 11).

## Instalación

```bash
npm install          # instala la raíz y, vía postinstall, backend/ y frontend/
```

Luego crea tu configuración local. Toda la configuración del proyecto —backend y
frontend— vive en un **único `.env` en la raíz del repo**, que nunca se commitea:

```bash
cp .env.example .env      # macOS / Linux
copy .env.example .env    # Windows (cmd)
```

Solo dos variables son obligatorias: rellena `TWITCH_CLIENT_ID` y
`TWITCH_CLIENT_SECRET` con las credenciales de tu app de
[dev.twitch.tv/console](https://dev.twitch.tv/console). Todo lo demás tiene
default razonable y está documentado en `.env.example` (24 variables: puertos,
URLs, base de datos, los dos motores TTS y los temporizadores de Twitch).

## HTTPS (obligatorio para Twitch)

Twitch solo acepta `https` en los *OAuth Redirect URLs*, así que la app se sirve
con un certificado local. Una sola vez:

macOS:

```bash
brew install mkcert
mkcert -install                     # confía la CA local (pide contraseña)
mkdir -p certs && cd certs
mkcert localhost 127.0.0.1 ::1
mv localhost+2.pem localhost.pem && mv localhost+2-key.pem localhost-key.pem
```

Windows 11 (PowerShell; `mkcert -install` pide elevación):

```powershell
choco install mkcert                # o: scoop install mkcert
mkcert -install
mkdir certs; cd certs
mkcert localhost 127.0.0.1 ::1
Rename-Item localhost+2.pem localhost.pem
Rename-Item localhost+2-key.pem localhost-key.pem
cd ..
```

Los certificados son **por máquina**: no se copian de una a otra (la CA local que
los firma solo está instalada donde se corrió `mkcert -install`).

Con `HTTPS=true` en el `.env`, el backend y el dev server de Vite usan ese
certificado, y los defaults de `TWITCH_REDIRECT_URI` y `FRONTEND_URL` pasan
solos a `https` — no hay que sincronizarlos a mano. `certs/` está git-ignorado:
la clave privada nunca se commitea.

En la app de Twitch, el *OAuth Redirect URL* debe coincidir exactamente con
`TWITCH_REDIRECT_URI`, que con HTTPS activo es
`https://localhost:3000/auth/callback`.

> Con `HTTPS=false` (el default) todo sigue en HTTP plano. Las pruebas de humo
> fuerzan `HTTPS=false` en el backend hijo que arrancan, así que no dependen de
> tener certificados.

> `backend/.env` se sigue leyendo si existe, como override local opcional, pero
> la raíz tiene precedencia y es donde conviene configurar todo.

## Motores TTS

Cuatro motores, todos opcionales salvo el del navegador (que es el respaldo y
nunca se puede quitar):

| Motor | Dónde sintetiza | Requiere | Setup |
| --- | --- | --- | --- |
| `browser` | navegador (Web Speech API) | nada | ninguno, siempre disponible |
| `edge` | Microsoft, en la nube | internet | ninguno (`TTS_EDGE_ENABLED=true` por default) |
| `piper` | local, proceso hijo | binario + modelos (~150 MB) | `npm --prefix backend run setup:piper` |
| `sapi` | local, voces de Windows | Windows | ninguno (usa lo que el sistema ya tenga instalado) |
| `melo` | local, contenedor Docker | Docker | automático con `npm start` |

`melo` es MeloTTS en español: mejor calidad que Piper, con pesos **MIT** (a
diferencia de XTTS-v2 o Fish Speech, que son de uso no-comercial — importante
si el canal genera ingresos). Corre en un contenedor aparte porque el modelo es
PyTorch, no un binario nativo.

`npm start` ya llama a `docker compose up -d melotts` por su cuenta (ver
`scripts/docker-melo.mjs`) — nada que hacer a mano. La primera vez compila la
imagen y tarda varios minutos; seguí el progreso con:

```bash
docker compose logs -f melotts
```

`npm stop` para el contenedor (`docker compose stop melotts`, rápido de
retomar) y `npm run down` lo remueve del todo (`docker compose down`), en
paralelo a lo que hacen con PM2. Si Docker no está instalado, no está
corriendo, o el build falla, **ninguno de los tres scripts se rompe por eso**:
solo avisan y siguen — la app funciona igual, las voces `melo:*` simplemente no
aparecen en `GET /api/voices`, la misma degradación limpia que Piper sin
instalar. Ver `docker/melotts/` y la sección 8 de `.env.example` para las
variables (`TTS_MELO_ENABLED`, `TTS_MELO_URL`, `TTS_MELO_TIMEOUT_MS`).

## Encender y apagar (PM2 + Docker)

Los mismos comandos en macOS y en Windows 11:

```bash
npm start      # docker compose up -d melotts, luego pm2 start → backend, frontend y MeloTTS
npm run status # = pm2 status                                  → estado de backend/frontend
npm run logs   # = pm2 logs                                    → logs en vivo (también en logs/)
npm stop       # pm2 stop, luego docker compose stop melotts   → detiene los tres
npm run down   # pm2 delete, luego docker compose down         → los quita del todo
```

El paso de Docker es **best-effort**: si Docker no está instalado o no está
corriendo, `npm start`/`stop`/`down` avisan y siguen igual con PM2 (ver
`scripts/docker-melo.mjs`).

Si prefieres invocar PM2 directamente, usa `npx` para tomar la copia local del
repo (no hace falta `npm i -g pm2`):

```bash
npx pm2 start ecosystem.config.js
npx pm2 stop all
```

Una vez arriba:

- Backend: <http://localhost:3000> — salud en <http://localhost:3000/api/health>
  (`{"status":"ok"}`).
- Frontend: <http://localhost:5173> — abre esta URL en el navegador.

### Desarrollo sin PM2

```bash
npm run dev:backend   # node --watch src/server.js
npm run dev:frontend  # vite (con HMR)
```

## Quality gates

Se ejecutan en cada tarea; no hay typecheck (el proyecto es JavaScript puro).

```bash
npm run lint    # eslint en backend/ y frontend/
npm run build   # build de producción del frontend
```

## Estructura

```
.
├── .env.example          # ÚNICA referencia de configuración (24 variables)
├── .env                  # tu configuración local — git-ignorada
├── ecosystem.config.js   # PM2: procesos tts-backend y tts-frontend
├── package.json          # scripts de orquestación (start/stop/lint/build)
├── backend/              # Express (REST + OAuth) + ws (WebSocket al frontend)
│   └── src/
│       ├── app.js        # app Express: /api/*, /auth/*
│       ├── config.js     # carga el .env de la raíz y expone la configuración
│       ├── logger.js     # logger mínimo (nunca loguear secretos)
│       ├── server.js     # entrypoint: HTTP + WebSocket
│       └── ws/hub.js     # hub del WebSocket /ws (broadcast al frontend)
└── frontend/             # Vue 3 + Vite + Vuetify 3 (tema oscuro default)
    ├── vite.config.js    # dev server 5173 + proxy /api, /auth, /ws → :3000
    └── src/
        ├── App.vue       # página placeholder (T-005 monta el shell real)
        ├── main.js
        └── plugins/vuetify.js
```

Carpetas que crean las tareas siguientes (todas git-ignoradas en cuanto a
artefactos): `backend/data/` (SQLite, T-002), `backend/src/db/` (repositorios,
T-002), `backend/src/providers/` (`ChatProvider`/`TwitchProvider`, T-004),
`backend/src/tts/` (`TTSEngine` y registro, T-008→T-010),
`backend/vendor/piper/` (binario y modelos de Piper, T-010).

## Convenciones establecidas por el scaffold

- **JavaScript puro**, sin TypeScript. Módulos ES (`"type": "module"`) en ambos
  paquetes; `ecosystem.config.js` es CommonJS porque PM2 lo requiere.
- **Dos paquetes npm independientes** (`backend/`, `frontend/`): no hay
  workspaces. Desde la raíz se orquesta con `npm --prefix <paquete> run <script>`.
- **ESLint 9 flat config** por paquete (`eslint.config.js`); cada paquete expone
  `lint` y `lint:fix`.
- **Multiplataforma**: sin rutas POSIX hardcodeadas, sin comandos exclusivos de
  Unix en los scripts; PM2 invoca entrypoints de Node directamente (nunca
  `npm run ...`, que rompe en Windows).
- **El frontend usa siempre rutas relativas** (`/api/...`, `/ws`) y depende del
  proxy de Vite; no hay orígenes hardcodeados en el código de la app.
- **Configuración y secretos**: un único `.env` en la raíz (git-ignorado), leído
  por el backend y por `vite.config.js`. Únicamente se commitea `.env.example`.
  Precedencia: entorno del proceso > `.env` de la raíz > `backend/.env` (legado).
