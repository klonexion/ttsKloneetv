---
name: editar-en-el-worktree-no-en-el-repo
description: Trampa de ruta al trabajar en un worktree aislado: el exec-plan se edita en /Users/carloslandin/clandin/tts_v1_worktrees/<tarea>/docs/..., no en el checkout principal.
metadata:
  type: feedback
---

Cada iteración trabaja en un worktree **fuera** del repo
(`/Users/carloslandin/clandin/tts_v1_worktrees/<tarea>`), pero el exec-plan se leyó
al principio desde el checkout principal (`/Users/carloslandin/clandin/tts_v1`). Es
facilísimo editarlo **ahí** por inercia: la ruta se ve igual y la herramienta no se
queja. Pasó en T-009 con las notas del plan.

Se arregla sin perder nada, en este orden:

1. `cp <ruta-en-el-repo-principal> <scratchpad>/copia.md`
2. copiar la copia **al worktree**;
3. `git -C <repo-principal> checkout -- <ruta>` (seguro **solo** porque ese cambio ya
   está a salvo en el worktree; ver [[control-negativo-sin-git-checkout]]);
4. `git status` en los dos árboles para confirmar: principal limpio, worktree con el
   cambio.

Prevención: antes de editar, comprueba que la ruta absoluta empieza por
`tts_v1_worktrees/`. Y al terminar, `git status` en el checkout principal debe estar
**limpio**: si sale algo modificado ahí, es trabajo tuyo colocado en el sitio
equivocado.

**Why:** un commit de la iteración que no incluye las notas del plan (o, peor, dejar
el checkout principal sucio para la siguiente ola) rompe la fase de merge del
orquestador.

**How to apply:** siempre que la iteración toque archivos que también existían en el
checkout principal, muy en especial `docs/exec-plans/active/*.md`.
