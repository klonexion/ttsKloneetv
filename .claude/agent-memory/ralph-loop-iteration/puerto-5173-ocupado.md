---
name: puerto-5173-ocupado
description: En esta máquina hay un dev server ajeno (yardos-application) escuchando en *:5173, así que curl a 127.0.0.1:5173 puede responder de OTRA app.
metadata:
  type: project
---

En esta máquina corre de forma persistente un Vite ajeno al proyecto
(`/Users/carloslandin/yardos-application/frontend`, título `YardOS`) escuchando
en `*:5173` (IPv6 wildcard, dual-stack). Cuando el frontend de este repo arranca,
Vite se queda con `[::1]:5173` y **`strictPort: true` no detecta el conflicto**
porque son direcciones distintas. Consecuencias observadas (2026-07-25, T-001):

- `curl http://127.0.0.1:5173/` devuelve la app **YardOS**.
- `curl http://localhost:5173/` y `http://[::1]:5173/` devuelven la app **de este
  repo** (macOS resuelve `localhost` a `::1` primero) — igual que el navegador.
- Tras detener nuestros procesos, `[::1]:5173` sigue respondiendo 200: es el
  servidor ajeno vía el wildcard, no un proceso nuestro que no murió.

**Why:** es fácil concluir "el frontend no arrancó" o "el stop no funcionó" a
partir de un `curl` que en realidad habla con otra aplicación.

**How to apply:** al verificar el frontend, comprueba `<title>` (o algún texto
propio) en la respuesta y `lsof -nP -iTCP:5173 -sTCP:LISTEN` para ver qué PID y
qué familia de direcciones responde, en vez de confiar en el código HTTP. Para el
backend (`:3000`) no hay conflicto. Ver [[verificacion-en-navegador]].
