"""The pyannote half of the sidecar.

Loading the pipeline is separated from running it so `main.py` can load once at startup —
26.4 s cold and 5.7 s warm in S6, the difference being the weight download, which is what
the `hf-cache` volume exists to keep off every cold start.

Progress is not decoration. A one-hour file takes about 1 h 40 m on CPU, and without a
progress signal an operator watches nothing happen for that long and concludes the job has
hung. The same hook is where cancellation and the server-side deadline are checked, because
it is the only point at which the pipeline yields — there is no way to interrupt pyannote
between hook calls.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any, Optional, Protocol

from .schemas import DiarizeRequest, DiarizeResult, Turn
from .tasks import AudioError, Cancelled, Task

log = logging.getLogger(__name__)


class Pipeline(Protocol):
    """The slice of pyannote's `Pipeline` this module uses.

    Structural, so the tests can pass a canned pipeline returning known turns without
    importing torch. That matters more than usual here: the whole suite would otherwise
    need a 2 GB dependency and a gated model download to test a 429.
    """

    def __call__(self, audio: str, **kwargs: Any) -> Any: ...


class ModelUnavailable(AudioError):
    """The weights are not there — gate not accepted, token missing, or no network."""

    def __init__(self, message: str) -> None:
        super().__init__("model_unavailable", message, retryable=True)


def load_pipeline(model: str, *, device: str, hf_token: Optional[str]) -> Pipeline:
    """Load pyannote once, at startup.

    Failure here is `model_unavailable` with the gate URLs attached rather than a stack
    trace. Accepting the terms on Hugging Face is a manual step, it is the most common
    first-run failure for a self-hosting newsroom, and the error pyannote raises does not
    mention that `pyannote/segmentation-3.0` is gated separately from the pipeline itself.
    """
    try:
        import torch
        from pyannote.audio import Pipeline as PyannotePipeline
    except ImportError as err:  # pragma: no cover — exercised by the image build, not tests
        raise ModelUnavailable(f"pyannote.audio is not installed: {err}") from err

    # pyannote renamed the token argument between 3.x (`use_auth_token`) and 4.x (`token`),
    # and this service targets 4.x on Linux while S6 measured 3.3.2 on macOS. Chosen by
    # signature rather than by version string, so neither a backport nor a pin can make
    # this wrong. S6's monkeypatched `use_auth_token` shim exists only because of the x86
    # macOS torch pin and is deliberately not carried over.
    import inspect

    parameters = inspect.signature(PyannotePipeline.from_pretrained).parameters
    token_kwarg = "token" if "token" in parameters else "use_auth_token"

    try:
        pipeline = PyannotePipeline.from_pretrained(model, **{token_kwarg: hf_token})
    except Exception as err:  # noqa: BLE001 — pyannote raises several unrelated types here
        raise ModelUnavailable(f"could not load {model}: {err}") from err
    if pipeline is None:
        # from_pretrained returns None rather than raising when the gate is unaccepted,
        # which is how this becomes a confusing AttributeError three lines later.
        raise ModelUnavailable(
            f"{model} returned no pipeline — the model is gated and the terms have not been "
            "accepted for this token"
        )

    pipeline.to(torch.device(device))
    return pipeline


def _speaker_hints(request: DiarizeRequest) -> dict[str, int]:
    hints: dict[str, int] = {}
    if request.num_speakers is not None:
        hints["num_speakers"] = request.num_speakers
    if request.min_speakers is not None:
        hints["min_speakers"] = request.min_speakers
    if request.max_speakers is not None:
        hints["max_speakers"] = request.max_speakers
    return hints


def run_diarization(
    pipeline: Pipeline,
    audio: Path,
    request: DiarizeRequest,
    task: Task,
    *,
    model: str,
    device: str,
    audio_duration_ms: int,
) -> DiarizeResult:
    started = time.monotonic()
    deadline_at = started + request.deadline_s

    def hook(step_name: str, *_args: Any, **kwargs: Any) -> None:
        """pyannote's ProgressHook signature, used for three things at once.

        Cancellation and the deadline are checked here because this is the only place the
        pipeline yields control. The client always wins the deadline race by construction —
        it sets `deadline_s` to its own deadline plus 120 s — so a breach here means the
        client is gone and this exists only to free the slot without a container restart.

        **`progress` is within the current step, not overall**, and `step` says which one.
        pyannote reports `completed`/`total` per stage and restarts the count at each new
        one, so a naive `completed / total` runs 0 to 100% and then drops back to 0 —
        measured on a real run: 0%, 100%, 0%, 33%, 67%, 100%. An operator watching a
        percentage go backwards concludes the job restarted. There is no honest overall
        figure available here because the stage list and its relative costs are not known in
        advance, so the contract reports what is actually known and names the step, which is
        the signal that says "still moving".
        """
        if task.cancel.is_set():
            raise Cancelled(f"cancelled during {step_name}")
        if time.monotonic() > deadline_at:
            raise AudioError(
                "deadline_exceeded",
                f"server-side deadline of {request.deadline_s:.0f}s fired during {step_name}",
                retryable=False,
            )
        if step_name != task.step:
            task.step = step_name
            task.progress = None
        completed = kwargs.get("completed")
        total = kwargs.get("total")
        if isinstance(completed, int) and isinstance(total, int) and total > 0:
            task.progress = round(min(1.0, completed / total), 4)

    output = pipeline(str(audio), hook=hook, **_speaker_hints(request))

    # pyannote 3.x returns an `Annotation`; 4.x returns a `DiarizeOutput` dataclass holding
    # two of them. Duck-typed rather than version-gated, for the same reason `load_pipeline`
    # inspects the token keyword: neither a backport nor a pin can make this wrong.
    #
    # **`speaker_diarization`, never `exclusive_speaker_diarization`.** The second one is
    # pyannote's own convenience view with overlapping speech removed, and taking it would
    # silently discard the thing `reconcile.ts` is built around — same-speaker overlapping
    # turns accumulate rather than compete, and `overlapAware: true` in the TypeScript
    # capabilities would become a lie. Overlap is information about contested audio; it
    # surfaces downstream as low margin and low purity, which is the honest representation.
    annotation = getattr(output, "speaker_diarization", output)

    turns = [
        Turn(
            start_ms=round(segment.start * 1000),
            end_ms=round(segment.end * 1000),
            speaker=str(label),
        )
        # Sorted by start, then end, then label: pyannote's iteration order is not
        # guaranteed and reconcile's moving cursor is only valid on time-ordered turns.
        for segment, _track, label in sorted(
            annotation.itertracks(yield_label=True),
            key=lambda item: (item[0].start, item[0].end, str(item[2])),
        )
    ]

    elapsed_s = max(time.monotonic() - started, 1e-6)
    task.progress = 1.0
    return DiarizeResult(
        turns=turns,
        num_speakers=len({turn.speaker for turn in turns}),
        model=model,
        params={
            "num_speakers": request.num_speakers,
            "min_speakers": request.min_speakers,
            "max_speakers": request.max_speakers,
        },
        audio_duration_ms=audio_duration_ms,
        compute_ms=round(elapsed_s * 1000),
        # Computed from the unrounded elapsed seconds, not from `compute_ms`. Rounding
        # first makes a sub-millisecond run divide by zero, and the `or 0.0` fallback that
        # papers over it publishes a factor of 0.0 — which then enters /health's rolling
        # median and reports this machine as infinitely slow. Real diarizations are never
        # that fast, but the canned pipeline in the tests is, and a sentinel that only
        # misbehaves where nobody looks is the kind that survives to production.
        #
        # Model load is deliberately outside this window: it is paid once per worker
        # process, not once per file, and folding it into a short clip produces a number no
        # long file could reproduce. Same convention as S3 and S6.
        realtime_factor=round(audio_duration_ms / 1000 / elapsed_s, 4),
        device=device,
    )
