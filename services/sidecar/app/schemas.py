"""The contract between the engine and the sidecar.

This module is the whole interface. The sidecar never receives credentials and never talks
to Postgres — it is a pure function of (audio, params) -> turns — which is what makes it
safe to run at low privilege and easy to test. Everything it is allowed to know is here.

Field names are snake_case on the wire because this half is Python; the TypeScript side in
`packages/engine/src/diarize/` maps them at its edge. Keeping the wire in one convention
matters more than matching either language, and a contract test in CI runs the real
TypeScript client against the real container so the two cannot drift apart silently.
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator

TaskState = Literal["queued", "running", "succeeded", "failed", "cancelled", "lost"]

ErrorCode = Literal[
    "busy",
    "bad_audio",
    "audio_unreachable",
    "oom",
    "model_unavailable",
    "deadline_exceeded",
    "cancelled",
    "internal",
]


class DiarizeRequest(BaseModel):
    """A request to diarize one whole file.

    `idempotency_key` is the engine's `run_step_id`, and `task_id = uuid5(NAMESPACE_URL,
    key)`. Deterministic on purpose: the engine can reconstruct the task id without having
    stored the 202 response, so a lost response is recoverable by GET alone.
    """

    idempotency_key: str = Field(min_length=1, max_length=200)

    #: An *internally* presigned MinIO URL. Minted against http://minio:9000, not through
    #: the public reverse proxy — the sidecar is on the compose network and has no business
    #: traversing Caddy to fetch a file from a service beside it.
    audio_url: str = Field(min_length=1)

    #: What the engine believes the duration to be. Checked against ffprobe within +/-1 s,
    #: because diarizing half a file in silence is worse than refusing it.
    expected_duration_ms: int = Field(gt=0)

    num_speakers: Optional[int] = Field(default=None, ge=1, le=64)
    min_speakers: Optional[int] = Field(default=None, ge=1, le=64)
    max_speakers: Optional[int] = Field(default=None, ge=1, le=64)

    #: Server-side backstop, set by the client to its own deadline + 120 s so the client
    #: always wins the race and the failure is attributed on our side. This exists only so
    #: a runaway job frees the slot without a container restart.
    deadline_s: float = Field(gt=0)

    @model_validator(mode="after")
    def _check_speaker_hints(self) -> "DiarizeRequest":
        if self.num_speakers is not None and (
            self.min_speakers is not None or self.max_speakers is not None
        ):
            raise ValueError("num_speakers is exclusive with min_speakers/max_speakers")
        if (
            self.min_speakers is not None
            and self.max_speakers is not None
            and self.min_speakers > self.max_speakers
        ):
            raise ValueError("min_speakers must not exceed max_speakers")
        return self


class Turn(BaseModel):
    """One span attributed to one speaker.

    **Turns may overlap**, including two from the same speaker — pyannote 3.1 emits
    overlapping speech. Nothing on either side of this contract may assume disjointness.
    """

    start_ms: int
    end_ms: int
    speaker: str


class DiarizeResult(BaseModel):
    turns: list[Turn]
    num_speakers: int
    model: str
    params: dict[str, object]
    audio_duration_ms: int
    compute_ms: int
    #: audio_seconds / wall_seconds, the same convention S3 and S6 used. Above 1 is faster
    #: than the audio plays. Recorded per run so the estimate shown to a user before the
    #: next run is measured on this machine rather than inherited from a 2018 laptop.
    realtime_factor: float
    device: str


class TaskError(BaseModel):
    code: ErrorCode
    message: str
    retryable: bool


class TaskAccepted(BaseModel):
    task_id: str
    state: TaskState
    accepted_at: float
    expires_at: float


class TaskStatus(BaseModel):
    task_id: str
    state: TaskState
    #: 0-1 from pyannote's ProgressHook. Absent is not zero — without it an operator watches
    #: nothing happen for an hour and concludes the job has hung.
    progress: Optional[float] = None
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    result: Optional[DiarizeResult] = None
    error: Optional[TaskError] = None


class ModelStatus(BaseModel):
    diarization: Literal["loaded", "not_loaded", "unavailable"]
    asr: Literal["loaded", "not_loaded", "unavailable"]


class Slots(BaseModel):
    max: int
    busy: int


class Health(BaseModel):
    status: Literal["ok", "degraded"]
    models: ModelStatus
    device: str
    torch: str
    pyannote: str
    slots: Slots
    #: Seeded from S6's measured ~0.6x and replaced by this instance's own rolling median
    #: once it has run anything. The number gets more honest on its own.
    realtime_factor_estimate: float
    #: Present when a model is unavailable: the exact URL a human has to open to accept the
    #: gate. This is the most common first-run failure for a self-hosting newsroom, and
    #: "model_unavailable" without the link is a support ticket.
    detail: Optional[str] = None
