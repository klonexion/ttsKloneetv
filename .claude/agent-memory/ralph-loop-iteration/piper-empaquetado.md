---
name: piper-empaquetado
description: Trampas del empaquetado de Piper (rhasspy/piper 2023.11.14-2) en macOS: el tar no trae las dylib y el binario no tiene LC_RPATH; el zip de Windows sí está completo.
metadata:
  type: project
---

Piper se instala con `npm --prefix backend run setup:piper` (T-010) a
`backend/vendor/`, git-ignorado. Lo que costó descubrir y sigue siendo cierto
mientras la release esté fijada:

- **La última release con binarios es `2023.11.14-2`** de `rhasspy/piper`
  (comprobado 2026-07-25 por la API de GitHub). El desarrollo siguió en otro
  repositorio con distribución por Python/wheels, que no sirve para un backend Node.
- **Los dos artefactos de macOS están incompletos:** no traen
  `libespeak-ng.1.dylib`, `libpiper_phonemize.1.dylib` ni
  `libonnxruntime.1.14.1.dylib` (solo el `dSYM`), así que el binario no arranca
  (`dyld: Library not loaded: @rpath/libespeak-ng.1.dylib`). Se completan desde la
  release `2023.11.14-4` de **`rhasspy/piper-phonemize`**, cuyo `lib/` sí las tiene.
  Al copiarlas hay que **recrear los enlaces simbólicos**, no seguirlos: hay dos
  nombres para `libonnxruntime` (23 MB cada copia).
- **Y aun con las dylib al lado, el binario no tiene `LC_RPATH`** (`otool -l` no
  devuelve nada): dyld solo mira `/usr/local/lib` y `/usr/lib`. Hay que lanzarlo con
  `DYLD_LIBRARY_PATH` = directorio del binario. `install_name_tool -add_rpath` no es
  opción: exige Xcode y **volver a firmar** en arm64.
- **El zip de Windows (`piper_windows_amd64.zip`) sí está completo** (`espeak-ng.dll`,
  `onnxruntime.dll`, `piper_phonemize.dll`, `piper.exe`), y el cargador de Windows
  busca los DLL junto al `.exe`: la máquina de producción no necesita nada de lo
  anterior.
- **Flags reales del CLI** (`piper --help` de esa release): `-m/--model`,
  `-c/--config`, `-f/--output_file` (`-` = stdout), `--output_raw`, `-s/--speaker`,
  `--length_scale`, `--noise_scale`, `--noise_w`, `--sentence_silence`,
  `--espeak_data`, `--json-input`, `-q/--quiet`. **No hay control de tono.** El tono
  se consigue declarando `sampleRate × f` en la cabecera WAV y compensando con
  `--length_scale × f`; medido: pitch 1.3 deja la duración a 0.89× (el silencio final
  no se estira).
- Los modelos viven en `huggingface.co/rhasspy/piper-voices` y su ruta se **deriva**
  del nombre: `es_ES-davefx-medium` → `es/es_ES/davefx/medium`. Español disponible:
  es_ES (carlfm, davefx, sharvard, mls_*) y es_MX (ald, claude). Un `medium` son
  ~60 MB; síntesis de una frase ~0.5 s en Apple Silicon.
- `tar` descomprime `.tar.gz` **y** `.zip` en macOS y en Windows 10/11
  (`System32\tar.exe` es bsdtar), así que no hacen falta `unzip` ni dependencias npm.

**Why:** sin esto se concluye que "el binario de Piper está roto" o se pierde media
iteración con node-gyp, codesign o `install_name_tool`.

**How to apply:** al tocar `backend/src/tts/piper-*.js` o `scripts/setup-piper.js`, o
si `test:piper` empieza a fallar en el bloque real. Ver [[gates-de-verificacion]] y
[[tts-en-navegador-headless]].
