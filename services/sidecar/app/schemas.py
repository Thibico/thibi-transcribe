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

from typing import Literal, Optional, Union

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
    #: The discriminator. Added in Phase 4b, when `/v1/tasks/{id}` gained a second result
    #: shape: one registry, one slot and one journal now serve two workloads, and a client
    #: that had to tell them apart by guessing which fields are present would be a contract
    #: nobody wrote down. Phase 3's clients ignore unknown fields, so adding it is safe.
    kind: Literal["diarize"] = "diarize"
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


class TranscribeRequest(BaseModel):
    """A request to transcribe one whole file with faster-whisper.

    Deliberately the same lifecycle as `DiarizeRequest` — same `idempotency_key`, same
    `uuid5` task id, same 429 on the single slot, same `lost` after a restart. That reuse is
    the payoff Phase 3 was designed for and the reason this half is small.

    **No chunking.** `maxConcurrentRequests` is 1 and the model takes the whole normalized
    file, so word timings are continuous and there is no seam to de-duplicate.
    """

    idempotency_key: str = Field(min_length=1, max_length=200)
    audio_url: str = Field(min_length=1)
    expected_duration_ms: int = Field(gt=0)

    #: ISO-639-1 where Whisper knows it. `None` means autodetect, which the engine only
    #: sends deliberately — a wrong autodetect is the failure mode Phase 4a measured on Groq,
    #: where Burmese came back as Vietnamese at HTTP 200.
    language: Optional[str] = Field(default=None, max_length=10)

    #: `large-v3` for non-English, `large-v3-turbo` behind a speed preference, and
    #: `distil-large-v3` only for English — it is an English-only distillation, which is why
    #: the overview's "default to distil-large-v3" was corrected (Phase 4 risk 1).
    model: str = "large-v3"
    compute_type: str = "int8"
    beam_size: int = Field(default=5, ge=1, le=10)

    word_timestamps: bool = True
    vad_filter: bool = True
    vad_min_silence_ms: int = Field(default=500, ge=0)

    #: The glossary, already truncated to the token budget by `buildWhisperPrompt`. The
    #: sidecar does not know what a glossary is and must not start deciding.
    initial_prompt: Optional[str] = None

    #: **False, and not configurable.** The default `True` is the classic faster-whisper
    #: repetition-loop trigger on long low-resource audio, which is the entire use case.
    #: Exposed as a field only so the value is visible in `params` and in a test.
    condition_on_previous_text: bool = False

    deadline_s: float = Field(gt=0)


class TranscribeWord(BaseModel):
    start_ms: int
    end_ms: int
    word: str
    #: **A genuine per-word probability, the only one in the system.** Google's `confidence`
    #: is per-word too but was measured in S2; OpenAI and Groq return nothing at word level
    #: and their segment `avg_logprob` is not a substitute. The QA surface that underlines
    #: uncertain words is real for this provider and explicitly absent for the others.
    probability: float


class TranscribeSegment(BaseModel):
    start_ms: int
    end_ms: int
    text: str
    #: Segment-level, log scale. The engine maps `exp(avg_logprob)` and clamps; it is kept
    #: raw here because the clamping rule belongs in one place and that place is TypeScript.
    avg_logprob: Optional[float] = None
    no_speech_prob: Optional[float] = None
    words: list[TranscribeWord] = Field(default_factory=list)


class TranscribeResult(BaseModel):
    kind: Literal["transcribe"] = "transcribe"
    segments: list[TranscribeSegment]
    #: What the model actually used, which is not always what was asked for: `language=None`
    #: means autodetect, and this is the only place the answer appears.
    language: str
    language_probability: Optional[float] = None
    model: str
    params: dict[str, object]
    audio_duration_ms: int
    compute_ms: int
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
    #: 0-1 from pyannote's ProgressHook, **within `step` rather than overall**. Absent is
    #: not zero — without it an operator watches nothing happen for an hour and concludes
    #: the job has hung. pyannote restarts the count at each stage, so there is no honest
    #: overall figure to report; `step` is what tells a watcher it is still moving.
    progress: Optional[float] = None
    #: The pyannote stage currently running.
    step: Optional[str] = None
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    #: Discriminated on `kind`, not inferred from which fields are present. One endpoint now
    #: returns two result shapes and the tag is what keeps a client from guessing.
    result: Optional[Union[DiarizeResult, TranscribeResult]] = Field(
        default=None, discriminator="kind"
    )
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
    #: Which faster-whisper model is resident, or `None` if none has been asked for. One at
    #: a time by design — see `asr.get_model`.
    asr_model: Optional[str] = None
    device: str
    torch: str
    pyannote: str
    slots: Slots
    #: **Diarization only.** Seeded from S6's measured ~0.6x and replaced by this instance's
    #: own rolling median once it has run anything. The number gets more honest on its own.
    #: Phase 4b deliberately did *not* widen this field's meaning: an ASR factor is an order
    #: of magnitude away, and blending the two would produce an estimate that describes
    #: neither workload while still looking like a measurement.
    realtime_factor_estimate: float
    #: Every workload's own median, keyed `diarize` and `asr:<model>`. This is what the model
    #: picker reads, because `large-v3` and `large-v3-turbo` differ by 2-3x on one box.
    realtime_factors: dict[str, float] = Field(default_factory=dict)
    #: Present when a model is unavailable: the exact URL a human has to open to accept the
    #: gate. This is the most common first-run failure for a self-hosting newsroom, and
    #: "model_unavailable" without the link is a support ticket.
    detail: Optional[str] = None
