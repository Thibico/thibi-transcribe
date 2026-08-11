"""The sidecar's four routes.

    GET    /health
    POST   /v1/diarize        202 new · 200 known key · 429 slot held by a different key
    GET    /v1/tasks/{id}     404 never seen · state `lost` after a restart
    DELETE /v1/tasks/{id}     204, idempotent, 204 even if already terminal

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

from .asr import router as asr_router
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
app.include_router(asr_router)


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
            asr="not_loaded",  # Phase 4b
        ),
        device=settings.device,
        torch=torch_version,
        pyannote=pyannote_version,
        slots=Slots(max=max_slots, busy=busy),
        realtime_factor_estimate=measured
        if measured is not None
        else settings.default_realtime_factor,
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
