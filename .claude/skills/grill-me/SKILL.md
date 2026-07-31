---
name: grill-me
description: Critica a fondo un pitch, plan o decisión de diseño de este proyecto — señala huecos, riesgos, supuestos débiles y preguntas sin responder, sin suavizar el feedback. Úsala cuando el usuario pida "grillame", "grill me", una revisión dura de una idea, o cuando quiera poner a prueba el pitch en docs/pitch-grill-me.md antes de construir.
---

# Grill Me

Revisión crítica directa de una idea, pitch o decisión técnica de este proyecto. El objetivo no es validar — es encontrar lo que se rompería, lo que falta decidir, y lo que se está asumiendo sin evidencia.

## Qué target usar

- Si el usuario da un argumento (archivo, tema o texto pegado), grillá eso.
- Si no da nada, usá `docs/pitch-grill-me.md` como default — es el pitch original del proyecto y ya tiene una sección "Puntos que sé que están abiertos (grillame aquí)" pensada para esto.
- Si el pitch ya fue grillado antes y el proyecto avanzó, contrastá también contra el estado actual del código (`backend/`, `frontend/`, `docs/decisiones.md`) para ver qué preguntas ya se resolvieron y cuáles siguen abiertas.

## Cómo grillar

1. **Leé el target completo** antes de opinar. No críticar por encima.
2. **Buscá contradicciones internas**: cosas que el documento afirma en una sección y desmiente (o deja sin resolver) en otra.
3. **Señalá supuestos no verificados**: afirmaciones que suenan a hecho pero son deseo ("los usuarios van a...", "esto va a escalar...").
4. **Marcá lo que falta decidir**, no solo lo que está mal. Un hueco de decisión (ej. "¿quién sostiene la conexión EventSub?") es tan importante como un error.
5. **Priorizá por impacto real**: qué decisión, si se toma mal, cuesta más reescribir después. No trates todos los puntos como igual de urgentes.
6. **Sé específico, no genérico.** "Definí la cola de TTS" es débil. "Si llegan 20 mensajes en 2s, ¿se leen los 20 en orden, se descartan los viejos, o se puede saltar el actual? Esto cambia el diseño de `tts/pipeline.js`" es útil.
7. **Proponé, no solo objetes.** Cada punto duro debería venir con una pregunta concreta que el usuario pueda responder en una frase, o una opción por defecto razonable si no la responde.

## Tono

Directo y sin adornos. Nada de "¡buen trabajo!" antes de la crítica ni suavizar con "solo una sugerencia menor" cuando es un problema real. El usuario pidió que lo grillen, no que lo reconforten. Aun así, la crítica es sobre la idea, no sobre la persona — cero comentarios sobre habilidad o esfuerzo.

## Formato de salida

Lista corta agrupada por severidad (bloqueante / importante / a tener en cuenta), cada ítem en una o dos líneas: el problema + la pregunta o decisión pendiente que lo resuelve. Cerrá con máximo 3 preguntas que el usuario debería responder primero, ordenadas por impacto.
