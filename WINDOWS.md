# Puesta en marcha en Windows 11

Esta guía es para el zip del proyecto: trae **solo código fuente**. Todo lo que es
binario o específico de la máquina (dependencias de npm, binario y voces de Piper,
certificados TLS, base de datos) se genera acá con los pasos de abajo. Es a
propósito: los artefactos de macOS (`.dylib`, `better-sqlite3` compilado para
arm64) no funcionan en Windows.

## 0) Requisitos

- **Node.js 20, 22 o 24 (x64)** — <https://nodejs.org> (el instalador `.msi`).
  Comprobá con `node --version`.
- **Git** (opcional, solo si querés versionar).
- **mkcert** para el certificado local: `choco install mkcert` o
  `scoop install mkcert`.

Corré todo desde **PowerShell** en la carpeta donde descomprimiste el zip.

## 1) Dependencias

```powershell
npm install
```

Esto instala la raíz y, por `postinstall`, `backend/` y `frontend/`.
`better-sqlite3` baja un binario precompilado para Windows x64; si tu versión de
Node fuera demasiado nueva y tuviera que compilar, instalá las herramientas de
build una sola vez:

```powershell
npm install --global windows-build-tools   # o: winget install Microsoft.VisualStudio.2022.BuildTools
```

## 2) Configuración (`.env`)

```powershell
Copy-Item .env.example .env
```

Solo dos variables son obligatorias; el resto ya tiene default razonable:

```
TWITCH_CLIENT_ID=<tu client id>
TWITCH_CLIENT_SECRET=<tu client secret>
```

Los sacás de <https://dev.twitch.tv/console/apps>. **No vienen en el zip** a
propósito: son secretos.

En la app de Twitch, el *OAuth Redirect URL* tiene que ser exactamente
`https://localhost:3000/auth/callback` (con `HTTPS=true`, que es el default del
`.env.example`).

## 3) Certificado local (HTTPS)

Twitch solo acepta `https` en los redirect URI. Una sola vez por máquina:

```powershell
mkcert -install                     # pide elevación: confía la CA local
mkdir certs; cd certs
mkcert localhost 127.0.0.1 ::1
Rename-Item localhost+2.pem localhost.pem
Rename-Item localhost+2-key.pem localhost-key.pem
cd ..
```

Los `.pem` de la máquina de desarrollo **no sirven acá**: la CA que los firmó no
está instalada en este Windows.

> Si preferís arrancar sin certificados para una primera prueba, poné
> `HTTPS=false` en el `.env`. Todo funciona en HTTP plano salvo el login de
> Twitch.

## 4) Voces de Piper (opcional)

```powershell
npm --prefix backend run setup:piper
```

Baja el binario de Piper para Windows (`piper_windows_amd64.zip`, con sus DLL) y
dos voces en español a `backend\vendor\` — unos 150 MB. Es **opcional**: sin
esto, las voces `piper:*` no aparecen en `/api/voices` y el resto (incluido el TTS
de Edge y el del navegador) funciona igual.

## 4b) MeloTTS (opcional, Docker)

Motor de mejor calidad que Piper, con pesos **MIT** (a diferencia de XTTS-v2 o
Fish Speech, no-comerciales). Corre en un contenedor aparte — hace falta
[Docker Desktop](https://www.docker.com/products/docker-desktop/) instalado y
arrancado. **No hay que levantarlo a mano**: `npm start` ya corre
`docker compose up -d melotts` por su cuenta (ver `scripts/docker-melo.mjs`).
La primera vez compila la imagen y tarda varios minutos; seguí el progreso con:

```powershell
docker compose logs -f melotts
```

También es **opcional**: sin Docker instalado, sin el contenedor arriba, o si
falla el build, `npm start` avisa y sigue igual — las voces `melo:*` no
aparecen en `/api/voices` y el resto funciona igual. Ver `docker/melotts/`.

## 5) Arrancar

```powershell
npm start          # docker compose up -d melotts + pm2: backend, frontend y MeloTTS
npm run status     # estado de tts-backend / tts-frontend (PM2)
npm run logs       # logs en vivo (también quedan en logs\)
npm stop           # detiene los tres (pm2 stop + docker compose stop melotts)
npm run down       # los quita del todo (pm2 delete + docker compose down)
```

Abrí <https://localhost:5173> en el navegador. La base de datos SQLite se crea
sola en `backend\data\app.sqlite` en el primer arranque.

Sin PM2, en dos terminales:

```powershell
npm run dev:backend
npm run dev:frontend
```

## 6) Verificación

```powershell
npm run lint
npm run build
npm --prefix backend run test:db
npm --prefix backend run test:settings
```

## Si algo falla

| Síntoma | Causa y arreglo |
| --- | --- |
| `HTTPS=true pero no existe el certificado en ...` | Falta el paso 3, o los `.pem` no se llamaron `localhost.pem` / `localhost-key.pem`. |
| El navegador desconfía del certificado | Falta `mkcert -install` (o se corrió sin elevación). Reiniciá el navegador después. |
| `Error: Could not locate the bindings file` (better-sqlite3) | El `node_modules` es de otra plataforma o de otra versión de Node. `Remove-Item -Recurse -Force backend\node_modules` y `npm install` de nuevo. |
| El puerto 5173 o 3000 está ocupado | `Get-NetTCPConnection -LocalPort 5173` para ver quién lo tiene, o cambiá `FRONTEND_PORT` / `BACKEND_PORT` en el `.env`. |
| Twitch responde `redirect_mismatch` | El *OAuth Redirect URL* de la app de Twitch no coincide con `TWITCH_REDIRECT_URI`. |
| Las voces `piper:*` no aparecen | Falta el paso 4, o falló la descarga: `npm --prefix backend run setup:piper -- --force`. |
| Las voces `melo:*` no aparecen | Falta el paso 4b, o el contenedor no está arriba: `docker compose ps` y `docker compose logs melotts`. |
