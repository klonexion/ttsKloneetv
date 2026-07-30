---
name: control-negativo-sin-git-checkout
description: Al probar que un gate falla si se revierte el arreglo, NO restaurar con `git checkout -- <archivo>`: borra todo el trabajo no commiteado de ese archivo. Usar una copia de respaldo.
metadata:
  type: feedback
---

Para el control negativo de un gate (comprobar que falla al desactivar lo que
arregla) hay que romper el código a propósito y luego restaurarlo. **No usar
`git checkout -- <archivo>` para restaurar:** en un worktree con trabajo sin
commitear, eso devuelve el archivo al **último commit** y se pierde toda la
edición de la iteración, no solo el sabotaje. Pasó en T-008 con
`backend/src/chat/relay.js` (hubo que reaplicar cinco ediciones).

Receta segura:

1. `cp <archivo> /tmp/<archivo>.bak` **antes** de sabotear.
2. Sabotear con `perl -0pi -e 's/…/…/'` (funciona igual en archivos nuevos sin
   seguimiento, donde `git stash`/`git checkout` no sirven de nada).
3. Correr el gate y comprobar que **falla en las comprobaciones esperadas**
   (anotar cuáles: si falla en otras, la prueba no medía lo que se creía).
4. Restaurar con `cp /tmp/<archivo>.bak <archivo>` y volver a correr el gate.

**El control negativo también descubre aserciones que "pasan por casualidad"**
(T-009): la comprobación «sintetizar la misma frase con dos pitch distintos da
audio distinto» **seguía verde con el pitch saboteado**, porque el servicio de
Microsoft devuelve bytes distintos en dos síntesis idénticas. Moraleja general:
**nunca fijes un comportamiento comparando salidas de un servicio externo**; fija
lo que se le *manda* (una clase falsa que capture los argumentos) y deja para la
red solo "responde y es un archivo válido". Van dos falsos verdes cazados así.

**Why:** el control negativo es obligatorio (un gate que no puede fallar pasa en
falso), pero restaurarlo mal cuesta media iteración reconstruyendo ediciones.

**How to apply:** siempre que se valide un gate nuevo, y muy en especial cuando el
sabotaje cae en un archivo **modificado** (no nuevo). Ver
[[imitador-de-servicios-externos]] y [[gates-de-verificacion]].
