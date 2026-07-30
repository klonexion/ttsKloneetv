---
name: no-es-yardos
description: Este repo (streamer-chat-tts-hub) NO es YardOS: npm sin workspaces, JS puro sin typecheck, y no existen scripts/ralph.sh ni docs/ralph-loop-spec.md.
metadata:
  type: project
---

La definición del subagente `ralph-loop-iteration` fue escrita para otro repo
(YardOS) y **no aplica aquí**. En este proyecto:

- Gestor: **npm**, dos paquetes independientes (`backend/`, `frontend/`). No hay
  pnpm ni workspaces, así que `--filter` no existe: se usa
  `npm --prefix backend run <script>`.
- **JavaScript puro, sin TypeScript** → no hay typecheck. Los gates son
  `lint` en ambos paquetes y `build` en frontend.
- No existen `scripts/ralph.sh` ni `docs/ralph-loop-spec.md`: el contrato de cada
  iteración llega en el prompt del orquestador
  (`scripts/prompts/active/streamer-chat-tts-hub.v2.txt`).
- Nada de multi-tenancy, Kysely, Keycloak, PGlite/event_queue, Storybook ni
  vue-i18n. La rama de integración es `main`, no `develop`.
- `docs/decisiones.md` y `docs/pitch-grill-me.md` son **solo lectura**; el único
  doc que se edita es el exec-plan (marcar checkboxes propios + notas).

**Why:** aplicar los "non-negotiables" de YardOS aquí produciría trabajo inválido
y comandos que fallan.

**How to apply:** al arrancar una iteración en este repo, ignora la sección de
YardOS de tu definición y toma las convenciones del `README.md` y de las notas de
T-001 en el exec-plan.
