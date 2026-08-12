"""The sidecar's routes.

    GET    /health
    POST   /v1/diarize        202 new · 200 known key · 429 slot held by a different key
    POST   /v1/transcribe     the same, for faster-whisper — Phase 4b
    GET    /v1/tasks/{id}     404 never seen · state `lost` after a restart
    DELETE /v1/tasks/{id}     204, idempotent, 204 even if already terminal

**Both workloads share one registry, one journal and one slot**, which is the whole reason
Phase 3 built the task API before it had a second caller. A `--diarize --provider
faster-whisper` run therefore takes the **sum** of the two stages rather than their max, and
the CLI estimate says so: both saturate every core and allocate GB-scale tensors, so
overlapping them is slower than serialising them and can OOM the container.

The distinction between a 404 and a `lost` state is the one an engine cannot recover from
if it is got wrong: 404 means "never seen, safe to submit" while `lost` means "this ran and
was killed", which must count as an attempt. See `tasks.py`.

Model loading happens in the lifespan, once. A failure there does not stop the service —
`/health` reports `model_unavailable` with the exact gate URLs instead, because a newsroom
whose container exits on a missing Hugging Face token has nothing to read to find out why.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from typing import AsyncIterator, Optional

from fastapi import FastAPI, Response
from fastapi.responses import JSONResponse

from .asr import asr_available, get_model, loaded_model_name, loading_model_name, run_transcription
from .audio import fetched_audio, probe_duration_ms
from .config import Settings, get_settings
from .diarize import Pipeline, load_pipeline, run_diarization
from .schemas import (
    DiarizeRequest,
    DiarizeResult,
    Health,
    ModelStatus,
    Slots,
    TaskAccepted,
    TaskStatus,
    TranscribeRequest,
    TranscribeResult,
)
from .tasks import Busy, Task, TaskRegistry, task_id_for

log = logging.getLogger(__name__)


class State:
    """Process-wide singletons. Assembled in the lifespan, read by the routes."""

    settings: Settings
    registry: TaskRegistry
    pipeline: Optional[Pipeline] = None
    model_error: Optional[str] = None


state = State()


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    state.settings = settings
    os.environ.setdefault("HF_HOME", settings.hf_home)
    if settings.torch_threads is not None:  # pragma: no cover — needs torch installed
        try:
            import torch

            torch.set_num_threads(settings.torch_threads)
        except ImportError:
            pass

    state.registry = TaskRegistry(
        data_dir=settings.data_dir,
        ttl_s=settings.task_ttl_s,
        max_slots=settings.max_concurrent_tasks,
    )
    recovered = state.registry.load_journal()
    if recovered:
        log.info("recovered %d task ids from the journal, all reported as lost", recovered)

    try:
        state.pipeline = load_pipeline(
            settings.diarization_model, device=settings.device, hf_token=settings.hf_token
        )
    except Exception as err:  # noqa: BLE001 — the service must start in order to explain
        state.model_error = str(err)
        log.error("diarization model unavailable: %s", err)

    yield


app = FastAPI(title="thibi sidecar", version="0.1.0", lifespan=lifespan)


@app.get("/health", response_model=Health)
def health() -> Health:
    settings = state.settings
    max_slots, busy = state.registry.slots()
    measured = state.registry.measured_realtime_factor()

    torch_version = "not_installed"
    pyannote_version = "not_installed"
    try:  # pragma: no cover — versions are whatever the image installed
        import torch

        torch_version = torch.__version__
        import pyannote.audio

        pyannote_version = pyannote.audio.__version__
    except ImportError:
        pass

    # ASR loads lazily — its model is a request parameter, not configuration — so
    # `not_loaded` here means "nothing has asked yet", which is the normal steady state on a
    # diarization-only instance. `unavailable` means the image cannot run it at all.
    loading = loading_model_name()
    if not asr_available():
        asr_state = "unavailable"
    elif loading is not None:
        # Neither of these calls waits on the load. `/health` is the container's HEALTHCHECK
        # and a cold `large-v3` takes minutes; reporting from behind the load lock marked the
        # container unhealthy for the whole download. Measured 2026-08-12.
        asr_state = "loading"
    elif loaded_model_name() is not None:
        asr_state = "loaded"
    else:
        asr_state = "not_loaded"

    unavailable = state.pipeline is None
    detail = None
    if unavailable:
        gates = "\n".join(f"  {url}" for url in settings.gate_urls)
        # All three, always. They are gated separately, and the error only ever names the
        # one that happened to fail first — which under pyannote 4.x is
        # `speaker-diarization-community-1`, a repo whose name appears nowhere in the model
        # id the operator configured. Measured on the built image, 2026-08-11.
        detail = (
            f"{state.model_error}\n\nAccept the terms for ALL of these gated models with "
            f"the Hugging Face account that owns SIDECAR_HF_TOKEN:\n{gates}"
        )

    return Health(
        status="degraded" if unavailable else "ok",
        models=ModelStatus(
            diarization="unavailable" if unavailable else "loaded",
            asr=asr_state,
        ),
        asr_model=loaded_model_name() or loading,
        device=settings.device,
        torch=torch_version,
        pyannote=pyannote_version,
        slots=Slots(max=max_slots, busy=busy),
        # **Diarization's, and only diarization's.** Phase 4b gave this registry a second
        # workload whose factor is an order of magnitude different; blending them would make
        # the estimate shown before a diarization depend on how much ASR ran that day.
        realtime_factor_estimate=measured
        if measured is not None
        else settings.default_realtime_factor,
        realtime_factors=state.registry.measured_realtime_factors(),
        detail=detail,
    )


def _accepted(task: Task) -> TaskAccepted:
    return TaskAccepted(
        task_id=task.task_id,
        state=task.state,
        accepted_at=task.accepted_at,
        expires_at=task.expires_at,
    )


@app.post("/v1/diarize")
def diarize(request: DiarizeRequest) -> Response:
    if state.pipeline is None:
        return JSONResponse(
            status_code=503,
            content={
                "error": {
                    "code": "model_unavailable",
                    "message": state.model_error or "the diarization model is not loaded",
                    "retryable": True,
                    "gates": state.settings.gate_urls,
                }
            },
        )

    pipeline = state.pipeline
    settings = state.settings

    def run(task: Task) -> DiarizeResult:
        with fetched_audio(
            request.audio_url,
            expected_duration_ms=request.expected_duration_ms,
            tolerance_ms=settings.duration_tolerance_ms,
            task_id=task.task_id,
        ) as audio:
            return run_diarization(
                pipeline,
                audio,
                request,
                task,
                model=settings.diarization_model,
                device=settings.device,
                audio_duration_ms=probe_duration_ms(audio),
            )

    try:
        task, created = state.registry.submit(request.idempotency_key, run)
    except Busy as busy:
        # 429 with Retry-After, and the engine must NOT count this as an attempt: nothing
        # was tried. This is what makes the single slot visible to the caller rather than a
        # mysterious timeout.
        return JSONResponse(
            status_code=429,
            headers={"Retry-After": str(busy.retry_after_s)},
            content={"error": "busy", "retry_after_s": busy.retry_after_s},
        )

    # 202 for a new task, 200 for a key we already know — in flight or complete. The engine
    # reads the status code to tell "I started this" from "this was already running".
    return JSONResponse(
        status_code=202 if created else 200,
        content=_accepted(task).model_dump(),
    )


@app.post("/v1/transcribe")
def transcribe(request: TranscribeRequest) -> Response:
    """faster-whisper, Phase 4b. Same lifecycle as `/v1/diarize`, same slot.

    The 503 differs from diarization's in one way worth stating: pyannote's is a *gate*
    problem, which a human fixes on a web page, so its message carries three URLs. This one
    is either a missing model or an image without faster-whisper in it, and the remedy is
    `thibi models pull`.
    """
    settings = state.settings

    if request.model not in settings.asr_allowed_models:
        # 400 rather than 503: nothing is broken, the request asked for something this
        # instance will not fetch. Allowlisted because `model` reaches `WhisperModel(name)`,
        # which downloads and runs whatever it is handed — see `config.asr_allowed_models`.
        return JSONResponse(
            status_code=400,
            content={
                "error": {
                    "code": "bad_request",
                    "message": (
                        f"model {request.model!r} is not in this instance's allowlist: "
                        + ", ".join(settings.asr_allowed_models)
                    ),
                    "retryable": False,
                }
            },
        )

    def run(task: Task) -> TranscribeResult:
        # Loaded inside the worker, not in the request handler. The first load of `large-v3`
        # downloads ~3 GB, and doing that on the request thread would hold the HTTP
        # connection open for minutes and time out the client that is about to poll anyway.
        model = get_model(
            request.model,
            compute_type=request.compute_type,
            device=settings.device,
            download_root=settings.hf_home,
            cpu_threads=settings.asr_cpu_threads,
        )
        with fetched_audio(
            request.audio_url,
            expected_duration_ms=request.expected_duration_ms,
            tolerance_ms=settings.duration_tolerance_ms,
            task_id=task.task_id,
        ) as audio:
            return run_transcription(
                model,
                audio,
                request,
                task,
                device=settings.device,
                audio_duration_ms=probe_duration_ms(audio),
            )

    try:
        task, created = state.registry.submit(request.idempotency_key, run)
    except Busy as busy:
        return JSONResponse(
            status_code=429,
            headers={"Retry-After": str(busy.retry_after_s)},
            content={"error": "busy", "retry_after_s": busy.retry_after_s},
        )

    return JSONResponse(
        status_code=202 if created else 200,
        content=_accepted(task).model_dump(),
    )


@app.get("/v1/tasks/{task_id}")
def get_task(task_id: str) -> Response:
    task = state.registry.get(task_id)
    if task is None:
        # Never seen. The engine reads this as "safe to submit", which is only true because
        # the journal turns a restarted task into `lost` rather than letting it 404.
        return JSONResponse(status_code=404, content={"error": "not_found", "task_id": task_id})
    return JSONResponse(
        status_code=200,
        content=TaskStatus(
            task_id=task.task_id,
            state=task.state,
            progress=task.progress,
            step=task.step,
            started_at=task.started_at,
            finished_at=task.finished_at,
            result=task.result,
            error=task.error,
        ).model_dump(),
    )


@app.delete("/v1/tasks/{task_id}", status_code=204)
def cancel_task(task_id: str) -> Response:
    # 204 whether it was running, already terminal, or unknown. Cancellation is an
    # instruction about a desired end state, and a caller cancelling twice — or cancelling
    # something that finished a moment earlier — has not made a mistake.
    state.registry.cancel(task_id)
    return Response(status_code=204)


@app.get("/v1/tasks/by-key/{idempotency_key}")
def task_id_for_key(idempotency_key: str) -> Response:
    """The id a key maps to, without submitting anything.

    Not in the original contract. It exists so the deterministic-id claim is testable from
    the outside: the engine computes `uuid5(NAMESPACE_URL, run_step_id)` itself, and a
    contract test that could only check that by reading Python source would not be checking
    anything.
    """
    return JSONResponse(status_code=200, content={"task_id": task_id_for(idempotency_key)})
