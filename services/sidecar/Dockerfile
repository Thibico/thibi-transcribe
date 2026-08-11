# One image for both halves of the sidecar: pyannote diarization (Phase 3) and
# faster-whisper ASR (Phase 4b). They share torch, ffmpeg and about 2 GB of wheels, so two
# images would double the pull for no isolation worth having — the two never run
# concurrently anyway, because there is exactly one task slot.
#
# CPU by default. S6 measured pyannote at ~0.6x realtime on six CPU cores; the 8-20x GPU
# figure in the plans is inherited and still unmeasured, and must not be quoted anywhere
# until it is. `--build-arg TORCH_INDEX=https://download.pytorch.org/whl/cu124` builds the
# CUDA variant.

FROM python:3.12-slim AS base

# ffmpeg is not optional: `audio.py` probes every download with ffprobe before diarizing
# it, which is what turns a truncated object into a `bad_audio` failure instead of a
# confident diarization of a third of an interview.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu

# torch first and alone, from the index that decides CPU vs CUDA. Installing it in the same
# resolution as pyannote lets pip pull the default (CUDA) build and silently produce a
# 6 GB image on a machine with no GPU.
RUN pip install --no-cache-dir --index-url "${TORCH_INDEX}" torch torchaudio

RUN pip install --no-cache-dir \
        "pyannote.audio>=4.0,<5" \
        "fastapi>=0.115" \
        "pydantic>=2.9" \
        "pydantic-settings>=2.5" \
        "uvicorn[standard]>=0.31"

# Unprivileged. The sidecar holds no credentials and no database connection — it is a pure
# function of (audio, params) -> turns — and running it as root would give away the one
# property that makes that worth anything.
RUN useradd --create-home --uid 10001 sidecar \
    && mkdir -p /cache/hf /data/tasks \
    && chown -R sidecar:sidecar /cache /data

WORKDIR /srv
COPY --chown=sidecar:sidecar app ./app

USER sidecar

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HF_HOME=/cache/hf \
    SIDECAR_HF_HOME=/cache/hf \
    SIDECAR_DATA_DIR=/data/tasks

# Both are volumes in compose. `hf-cache` is what keeps the model download off every cold
# start — S6 measured 26.4 s cold against 5.7 s warm, and the difference is the weights.
# `/data/tasks` is the journal that makes a restarted task report `lost` rather than 404.
VOLUME ["/cache/hf", "/data/tasks"]

EXPOSE 8081

# `status: degraded` still answers 200 — a sidecar whose Hugging Face gate has not been
# accepted must stay up and say so, because a container that exits on a missing token
# leaves a newsroom with nothing to read.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD curl -fsS http://localhost:8081/health || exit 1

# One worker. Two would each load a multi-GB model into their own process and then
# contend for the same cores, and the semaphore that enforces one task at a time is
# per-process — two workers would quietly become two slots.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8081", "--workers", "1"]
