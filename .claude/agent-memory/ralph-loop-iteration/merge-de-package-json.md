---
name: merge-de-package-json
description: En este repo el único conflicto recurrente al mergear main es backend/package.json, y la resolución correcta es siempre la unión de scripts de las dos ramas.
metadata:
  type: project
---

Cada tarea añade sus scripts a `backend/package.json` (`test:<algo>` +
`fake-<algo>`), así que **ese archivo choca en todos los merges de `main`** cuando
dos olas avanzaron en paralelo. Todo lo demás (módulos nuevos en `src/`, scripts
de humo, el exec-plan) mergea limpio porque cada tarea toca archivos distintos.

La resolución correcta es **la unión de los scripts de ambos lados**, sin tocar
`dependencies`/`devDependencies` (hasta ahora idénticas en las tres etapas).
Comprobarlo objetivamente en vez de a ojo:

```
git show :1:backend/package.json   # base
git show :2:backend/package.json   # ours (tu rama)
git show :3:backend/package.json   # theirs (main)
```

Parsea las tres con `node -e` y compara `Object.keys(p.scripts)` y las deps: si el
árbol de trabajo es exactamente `union(etapa2, etapa3)` y `JSON.parse` no falla,
la resolución está bien y solo falta `git add backend/package.json`.

**Ojo con el estado heredado:** un merge a medias sobrevive entre iteraciones
(`MERGE_HEAD` presente, `UU` en el índice). Las notas de agent-memory que
aparecen como `M`/`A` staged en ese estado **vienen de `main`**, no son ediciones
sueltas de la iteración: no las descartes.

**Why:** el conflicto parece sustancial (el manifiesto del paquete) pero es
mecánico; tratarlo como tal ahorra una iteración, y verificarlo con las tres
etapas evita perder el gate de otra tarea sin notarlo.

**How to apply:** al cerrar la fase de merge de cualquier tarea. Después corre
los nueve gates de [[gates-de-verificacion]] sobre el resultado.
