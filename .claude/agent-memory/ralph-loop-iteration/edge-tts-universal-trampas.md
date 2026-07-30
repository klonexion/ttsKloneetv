---
name: edge-tts-universal-trampas
description: Trampas del paquete edge-tts-universal (promesa que nunca rechaza, pitch en Hz, requiere internet) y el patrón de timeout que hay que ponerle encima.
metadata:
  type: project
---

El motor edge-tts del backend usa `edge-tts-universal` (fijado, T-009). Cosas que
costaron descubrir y que valen para T-010 y para cualquiera que lo toque:

- **Hay caminos en los que su promesa NO rechaza nunca.** Con un proxy inalcanzable
  (`proxy: 'http://127.0.0.1:1'`), `Communicate.stream()` se queda colgado para
  siempre y su propio `connectionTimeout` no dispara. Un cuelgue ahí congelaría la
  cola del frontend esperando el audio, así que **toda llamada va envuelta en un
  `Promise.race` con un timeout que rechaza**. Ese mismo proxy inalcanzable es, por
  eso, la forma **determinista y offline** de provocar "sin internet" en una prueba.
- **Un temporizador de timeout no se puede `unref()`.** Si la promesa que vigila se
  cuelga y el proceso no tiene nada más pendiente, un temporizador sin referencia no
  llega a dispararse y el timeout no sirve de nada: el script muere con
  `Detected unsettled top-level await` (exit 13). Pasó en el primer intento del gate.
- **El pitch es en Hz, no en porcentaje:** valida `/^[+-]\d+Hz$/` y **lanza** si no.
  `rate` y `volume` sí son `%`. El texto lo escapa el paquete (`xml-escape`), así que
  no hay inyección de SSML por el mensaje de chat.
- **Errores útiles del servicio:** una voz inexistente responde `NoAudioReceived` en
  ~0.5 s. Sirve como "error del servicio" real y rápido para probar el respaldo sin
  tocar la red.
- **`listVoices()` devuelve 322 voces (45 en español)** con `ShortName`, `Locale`,
  `Gender` y `FriendlyName`. Es el catálogo real de `GET /api/voices`.
- La síntesis de una frase corta tarda ~0.7–1 s y devuelve MP3 (cabecera `fff3…`);
  ~13 KB por frase.

**Why:** son fallos silenciosos (cuelgue en vez de error) que se comen una
iteración entera, y el paquete no los documenta.

**How to apply:** al tocar `backend/src/tts/edge-engine.js`, al añadir otro motor de
servidor (T-010) o si el gate `test:edge-tts` empieza a colgarse. Ver
[[gates-de-verificacion]] y [[tts-en-navegador-headless]].
