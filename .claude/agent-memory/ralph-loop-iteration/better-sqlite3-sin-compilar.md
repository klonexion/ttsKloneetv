---
name: better-sqlite3-sin-compilar
description: better-sqlite3 13.x instala sin compilar en macOS/Node 24 y en Windows 11 porque trae prebuilds N-API dentro del tarball de npm.
metadata:
  type: project
---

`better-sqlite3` (13.0.1, verificado 2026-07-24 en Node v24.16.0 / macOS arm64)
**no compila nada** al instalarse: el tarball de npm incluye
`node_modules/better-sqlite3/prebuilds/<plataforma>-<arch>.node` para
darwin-{arm64,x64}, linux, linuxmusl y **win32-{x64,arm64}**. `npm install`
tarda ~2 s y no necesita Xcode CLT ni MSVC build tools.

**Why:** el aviso habitual de "módulo nativo + Node nuevo = compilar desde
fuente y posible fallo en Windows 11 (entorno de producción de este proyecto)"
**no aplica** aquí; gastar tiempo en workarounds de node-gyp o en evaluar
`node:sqlite` como alternativa sería trabajo inútil.

**How to apply:** instalar con `npm --prefix backend install better-sqlite3` sin
flags especiales. Si alguna tarea futura considera bajar de la versión 12,
revisar antes que la versión elegida siga trayendo `prebuilds/` (las versiones
viejas usaban `prebuild-install`, que descarga de GitHub Releases y sí puede
fallar sin red o sin prebuild para el ABI). Ver [[no-es-yardos]].
