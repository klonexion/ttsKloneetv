---
name: columnas-not-null-y-valor-sin-asignar
description: En este esquema `users.pitch`/`users.volume` son NOT NULL DEFAULT 1, así que no hay valor que signifique "sin asignar": lo aleatorio se reparte al INSERTAR, no después.
metadata:
  type: project
---

`users.pitch` y `users.volume` son `NOT NULL DEFAULT 1` (esquema de T-002, fijado por
el plan). Consecuencia que se pagó al implementar T-011: **no existe ningún valor que
signifique "todavía sin asignar"**, así que un modelo del tipo «si el usuario no tiene
pitch, sortéaselo» es irrealizable — `pitch = 1` puede ser el default de la columna o
una elección deliberada del operador, y son indistinguibles.

La salida limpia, y lo que el esquema ya permitía: **repartir el valor en la
inserción**. `users.upsert()` aplica `volume`/`pitch` **solo al insertar** (en los
mensajes siguientes no los pisa), así que el relay pasa el pitch aleatorio en el
primer mensaje del usuario y la persistencia sale gratis, sin escrituras en el camino
de lectura.

Dos secuelas que conviene recordar:

- Las filas creadas **antes** de que existiera el sorteo se quedan con el default.
  Si el valor es visible para el usuario, hay que darle una forma de re-rodarlo desde
  la UI (en T-011, el botón del dado junto al pitch); una migración de datos sería más
  invasiva y `migrations.js` es de otro territorio.
- **El valor sorteado puede coincidir con el default** (1.00 es uno de los 61 valores
  posibles de [0.8, 1.4] con 2 decimales). Ninguna aserción puede exigir
  `pitch !== 1` para un solo usuario sin volverse intermitente: hay que medirlo sobre
  un grupo (ocho usuarios) o con la fuente de aleatoriedad inyectada.

**Why:** el hueco que había dejado la tarea anterior apuntaba a
`updatePreferences()` en el pipeline, que no puede funcionar por esto; entenderlo
antes de escribir código ahorró rehacer el modelo.

**How to apply:** al añadir cualquier preferencia por usuario con valor "sorteado" o
"heredado". Ver [[gates-de-verificacion]].
