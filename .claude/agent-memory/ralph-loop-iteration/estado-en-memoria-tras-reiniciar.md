---
name: estado-en-memoria-tras-reiniciar
description: Tras reiniciar el backend, el chat y la columna de usuarios salen vacíos a propósito (viven en memoria); una verificación que asserte "sigue habiendo usuarios" falla sin que nada esté roto.
metadata:
  type: project
---

Lo que **no** sobrevive a un reinicio del backend, por diseño del plan:

- **El chat** vive solo en memoria del navegador (no hay historial persistente) y el
  store se vacía al recargar la página: cero líneas hasta el mensaje siguiente.
- **La lista de usuarios**: `active` se calcula sobre los mensajes vistos *desde que
  arrancó el proceso* (`src/users/presence.js`), y el roster de presentes depende de
  Get Chatters, que sin sesión real (o con el imitador de EventSub, que no implementa
  `/helix/chat/chatters`) no devuelve nada. Resultado: columna vacía con
  «Consultando quién está en el chat…».
- **La cola TTS** se limpia al desmontarse el shell.

Lo que sí sobrevive: todo lo de SQLite (`tokens`, `users` con sus preferencias y
pitch, `app_settings`).

**Cómo verificar «el sistema sigue vivo» después de un reinicio**, entonces: inyectar
un mensaje nuevo con `/_fake/eventsub/say` y esperar a que aparezca en `.chat-line` y
su autor en `[data-testid="user-item"]`. Aserciones sobre lo que había *antes* del
reinicio fallan sin que nada esté roto (le pasó a T-013, una comprobación en falso).

**Why:** un reinicio del backend es parte de varios criterios de aceptación (tema
persistido, reconexión), y confundir "estado en memoria vacío" con una regresión
cuesta una corrida de verificación entera.

**How to apply:** en cualquier verificación por CDP que reinicie el backend a mitad.
Ver [[verificacion-en-navegador]] y [[tts-en-navegador-headless]].
