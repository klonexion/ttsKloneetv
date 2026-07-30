"""Servidor HTTP mínimo sobre MeloTTS (español).

Expone dos rutas para que `backend/src/tts/melo-engine.js` las consuma:

- `GET /health`  — para saber si el contenedor está arriba y qué voces tiene.
- `POST /speak`  — sintetiza y devuelve un WAV crudo (PCM 16 bits).

El pitch NO se controla acá: `speed` es lo único que este servidor expone para
eso (el motor de Node pide `1 / factor` y reescribe la cabecera del WAV con
`sampleRate * factor`, el mismo truco que ya usan los motores Piper y SAPI del
backend). Mantener esa lógica en un solo lugar (Node) evita duplicarla en dos
lenguajes.

El timbre sí viaja directo: `noise_scale`/`noise_scale_w` son parámetros
propios de `tts_to_file()` (familia VITS, controlan cuánto ruido de generador
mete el modelo) y no tienen equivalente en el truco de pitch, así que Node
manda los valores ya calculados y acá solo se pasan tal cual, con los defaults
de MeloTTS (0.6/0.8) si no vienen.
"""
import io
import os

import soundfile as sf
from fastapi import FastAPI, Response
from melo.api import TTS
from pydantic import BaseModel

DEVICE = os.environ.get("MELO_DEVICE", "cpu")
LANGUAGE = os.environ.get("MELO_LANGUAGE", "ES")

app = FastAPI()
model = TTS(language=LANGUAGE, device=DEVICE)
SPEAKER_IDS = model.hps.data.spk2id
# `HParams` (melo/utils.py) no define `__iter__`, solo `.keys()`/`.items()`/`.values()`
# delegando a `self.__dict__`: `next(iter(SPEAKER_IDS))` revienta con
# "attribute name must be string, not 'int'" (cae al fallback de iteración por
# `__getitem__(0)`, `__getitem__(1)`, ... que hace `getattr(self, 0)`).
DEFAULT_SPEAKER_NAME = next(iter(SPEAKER_IDS.keys()))
SAMPLE_RATE = model.hps.data.sampling_rate


class SpeakRequest(BaseModel):
    text: str
    speed: float = 1.0
    speaker: str | None = None
    noise_scale: float = 0.6
    noise_scale_w: float = 0.8


@app.get("/health")
def health():
    return {
        "status": "ok",
        "language": LANGUAGE,
        "device": DEVICE,
        "sample_rate": SAMPLE_RATE,
        "speakers": list(SPEAKER_IDS.keys()),
    }


@app.post("/speak")
def speak(req: SpeakRequest):
    text = (req.text or "").strip()
    if not text:
        return Response(status_code=400, content=b"texto vacio")

    speaker_name = req.speaker if req.speaker in SPEAKER_IDS else DEFAULT_SPEAKER_NAME
    speed = max(0.5, min(2.0, req.speed or 1.0))
    # Mismo criterio de recorte que `speed`: un valor fuera de rango no revienta,
    # se recorta. Los defaults de MeloTTS (0.6/0.8) están cerca del centro.
    noise_scale = max(0.1, min(1.2, req.noise_scale))
    noise_scale_w = max(0.1, min(1.2, req.noise_scale_w))

    audio = model.tts_to_file(
        text,
        SPEAKER_IDS[speaker_name],
        output_path=None,
        speed=speed,
        noise_scale=noise_scale,
        noise_scale_w=noise_scale_w,
        quiet=True,
    )

    buffer = io.BytesIO()
    sf.write(buffer, audio, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    return Response(content=buffer.getvalue(), media_type="audio/wav")
