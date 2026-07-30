# MeloTTS (español) detrás de un servidor HTTP mínimo (`server.py`).
#
# MIT tanto el código como los pesos (a diferencia de XTTS-v2/Fish Speech, que
# son no-comerciales) — la única opción de calidad "IA" que no obliga a leer
# letra chica de licencia para usarla en un canal que genera ingresos.
#
# NO usar Python 3.9 (lo que documenta el propio repo de MeloTTS en
# docs/install.md): `boto3` —dependencia dura de `cached_path`, que MeloTTS
# instala para resolver rutas remotas, aunque acá nunca se use S3— dejó de
# publicar releases para 3.9 (mínimo actual: >=3.10). Sin una versión de
# Python que la última release soporte, el resolver de pip retrocede por
# **toda** la historia de versiones de boto3/botocore bajando cada wheel
# entero para leer sus metadatos — un incidente real: ~90 minutos y
# gigabytes bajando versiones de botocore antes de que se lo matara a mano.
# 3.11 evita el problema de raíz (y probablemente el mismo problema con otras
# dependencias más adelante, no solo boto3): la build más nueva de cada
# paquete ya sirve, cero backtracking.
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    build-essential \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Clona el repo (no hay paquete en PyPI con el nombre `melotts` mantenido) e
# instala en modo editable, tal como documenta el propio proyecto.
RUN git clone --depth 1 https://github.com/myshell-ai/MeloTTS.git . \
    && pip install --no-cache-dir -e . \
    && python -m unidic download \
    && pip install --no-cache-dir fastapi "uvicorn[standard]" soundfile

# Descarga el modelo en español durante el build (no en el primer request):
# así el contenedor arranca listo y `docker compose up` es la única espera.
RUN python -c "from melo.api import TTS; TTS(language='ES', device='cpu')"

COPY server.py /app/server.py

EXPOSE 8100
ENV MELO_DEVICE=cpu
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8100"]
