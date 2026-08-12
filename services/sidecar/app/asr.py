"""The faster-whisper half of the sidecar — Phase 4b.

Structurally the mirror of `diarize.py`: loading is separated from running, the run function
takes the `Task` so it can report progress and observe cancellation, and everything about
the task lifecycle — the `uuid5` id, the single slot, the 429, the journal, `lost` — is
Phase 3's, unchanged. That reuse is the payoff of building the task API before its second
workload, and it is why this file is short.

**Why this provider exists at all.** `word.probability` is a genuine per-word probability
and the only one in the system besides Google's. Every `wordConfidence: true` claim in Phase
4's plan waited on this file, and so does the low-confidence QA surface: an underline on an
uncertain word is a real signal here and would be a decoration anywhere else.

Two differences from the diarization half are worth reading:

**The model is loaded lazily, not at startup.** pyannote's model is fixed by configuration,
so `main.py` loads it once in the lifespan. The ASR model is a *request parameter* —
`large-v3`, `large-v3-turbo`, `distil-large-v3` — and loading all of them eagerly would cost
several GB on an instance that may only ever diarize. So the first request pays for the
load, and **exactly one model is held at a time**: a second model would double the resident
weights on a box that already runs one task at a time on purpose.

**Progress is honest here, and was not for pyannote.** faster-whisper yields segments as it
decodes, so `segment.end / duration` is a real fraction of the file that never runs
backwards — unlike pyannote's per-stage hook, which does (overview amendment 44). The
generator is also the cancellation point, and a better one than pyannote's: it yields per
segment rather than per stage.
"""

from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from typing import Any, Iterable, Optional, Protocol, Tuple

from .schemas import TranscribeRequest, TranscribeResult, TranscribeSegment, TranscribeWord
from .tasks import AudioError, Cancelled, Task

log = logging.getLogger(__name__)


class Transcriber(Protocol):
    """The slice of faster-whisper's `WhisperModel` this module uses.

    Structural, for the same reason `diarize.Pipeline` is: the pytest suite passes a canned
    transcriber returning known segments, and must not need CTranslate2, 3 GB of weights or
    a network to test a 429.
    """

    def transcribe(self, audio: str, **kwargs: Any) -> Tuple[Iterable[Any], Any]: ...


class ModelUnavailable(AudioError):
    """The weights are not there — never downloaded, or no network to fetch them."""

    def __init__(self, message: str) -> None:
        super().__init__("model_unavailable", message, retryable=True)


_load_lock = threading.Lock()
_loaded: Optional[Tuple[Tuple[str, str, str], Transcriber]] = None
#: The model currently being loaded, if any.
#:
#: **Read without the lock, deliberately.** `get_model` holds `_load_lock` for the whole of a
#: cold load — three gigabytes over the network for `large-v3` — and `/health` is the
#: container's HEALTHCHECK. The first version of this file reported the loaded name from
#: inside the lock, so `/health` blocked for the entire download and Docker marked the
#: container **unhealthy** exactly while it was doing the slow thing an operator most wants
#: to watch. Under Phase 15's restart policy that is worse than cosmetic: the restart kills
#: the download, and the next one starts it again.
#:
#: A module-global read is atomic in CPython, and stale by at most one assignment — which is
#: the right trade for a status field that must never wait on the thing it is reporting.
_loading: Optional[str] = None


def load_model(
    name: str,
    *,
    compute_type: str,
    device: str,
    download_root: str,
    cpu_threads: int = 0,
) -> Transcriber:
    """Load one faster-whisper model, downloading it if the cache does not have it.

    A missing model is `model_unavailable` and **retryable**, matching the diarization half:
    on a fresh instance the first request downloads ~3 GB and looks like a hang, which is
    what `thibi models pull` exists to do deliberately instead.
    """
    try:
        from faster_whisper import WhisperModel
    except ImportError as err:  # pragma: no cover — exercised by the image build, not tests
        raise ModelUnavailable(f"faster-whisper is not installed: {err}") from err

    try:
        return WhisperModel(
            name,
            device=device,
            compute_type=compute_type,
            download_root=download_root,
            cpu_threads=cpu_threads,
        )
    except Exception as err:  # noqa: BLE001 — ctranslate2 and huggingface_hub raise unrelated types
        raise ModelUnavailable(f"could not load {name}: {err}") from err


def get_model(
    name: str,
    *,
    compute_type: str,
    device: str,
    download_root: str,
    cpu_threads: int = 0,
) -> Transcriber:
    """The cached model, loading or swapping as needed.

    **One at a time.** `large-v3` is ~4.5 GB resident and `large-v3-turbo` ~2.5 GB; holding
    both to save a reload on a service that runs one task at a time would trade memory the
    container may not have for latency nobody asked about. The previous model is dropped
    before the next is loaded so the peak is one model, not two.
    """
    global _loaded
    key = (name, compute_type, device)
    with _load_lock:
        if _loaded is not None and _loaded[0] == key:
            return _loaded[1]
        if _loaded is not None:
            log.info("swapping ASR model %s -> %s", _loaded[0][0], name)
            _loaded = None  # drop the reference before allocating the next one
        global _loading
        _loading = name
        try:
            model = load_model(
                name,
                compute_type=compute_type,
                device=device,
                download_root=download_root,
                cpu_threads=cpu_threads,
            )
        finally:
            # Cleared on failure too: a model that could not be loaded is not loading.
            _loading = None
        _loaded = (key, model)
        return model


def loaded_model_name() -> Optional[str]:
    """The resident model, or `None`. **Never takes the lock** — see `_loading`."""
    current = _loaded
    return current[0][0] if current is not None else None


def loading_model_name() -> Optional[str]:
    """The model being loaded right now, or `None`. Never takes the lock either."""
    return _loading


def asr_available() -> bool:
    """Whether the ASR half can run at all, which is a question about the image."""
    try:
        import faster_whisper  # noqa: F401
    except ImportError:
        return False
    return True


def run_transcription(
    model: Transcriber,
    audio: Path,
    request: TranscribeRequest,
    task: Task,
    *,
    device: str,
    audio_duration_ms: int,
) -> TranscribeResult:
    started = time.monotonic()
    deadline_at = started + request.deadline_s
    duration_s = max(audio_duration_ms / 1000, 1e-6)

    segments, info = model.transcribe(
        str(audio),
        language=request.language,
        beam_size=request.beam_size,
        word_timestamps=request.word_timestamps,
        vad_filter=request.vad_filter,
        vad_parameters=dict(min_silence_duration_ms=request.vad_min_silence_ms),
        initial_prompt=request.initial_prompt or None,
        # **Not taken from the request as a knob.** The field exists so the value is visible
        # in `params` and assertable in a test; the default `True` is the classic
        # repetition-loop trigger on long low-resource audio, which is the entire use case.
        condition_on_previous_text=False,
    )

    out: list[TranscribeSegment] = []
    task.step = "transcribe"
    # The generator *is* the work — `transcribe()` above returns before decoding anything.
    # It is therefore also the only place this yields, which makes it the cancellation
    # point, the deadline check and the progress signal, exactly as pyannote's hook is.
    for segment in segments:
        if task.cancel.is_set():
            raise Cancelled(f"cancelled after {len(out)} segments")
        if time.monotonic() > deadline_at:
            raise AudioError(
                "deadline_exceeded",
                f"server-side deadline of {request.deadline_s:.0f}s fired after "
                f"{len(out)} segments",
                retryable=False,
            )
        out.append(
            TranscribeSegment(
                start_ms=round(segment.start * 1000),
                end_ms=round(segment.end * 1000),
                text=segment.text,
                avg_logprob=getattr(segment, "avg_logprob", None),
                no_speech_prob=getattr(segment, "no_speech_prob", None),
                words=[
                    TranscribeWord(
                        start_ms=round(word.start * 1000),
                        end_ms=round(word.end * 1000),
                        word=word.word,
                        probability=word.probability,
                    )
                    # `words` is None rather than empty when word_timestamps is off, and
                    # `or []` is what keeps that from being an AttributeError three lines on.
                    for word in (getattr(segment, "words", None) or [])
                ],
            )
        )
        # A real fraction of the file, and it never goes backwards. Clamped because VAD can
        # place a segment end fractionally past the probed duration.
        task.progress = round(min(1.0, segment.end / duration_s), 4)

    elapsed_s = max(time.monotonic() - started, 1e-6)
    task.progress = 1.0
    return TranscribeResult(
        segments=out,
        # What the model *used*, not what was asked for. With `language=None` this is the
        # only place the autodetected answer appears — and autodetect returning the wrong
        # language at full confidence is the exact failure Phase 4a measured on Groq.
        language=str(getattr(info, "language", request.language or "unknown")),
        language_probability=getattr(info, "language_probability", None),
        model=request.model,
        params={
            "language": request.language,
            "model": request.model,
            "compute_type": request.compute_type,
            "beam_size": request.beam_size,
            "word_timestamps": request.word_timestamps,
            "vad_filter": request.vad_filter,
            "vad_min_silence_ms": request.vad_min_silence_ms,
            "condition_on_previous_text": False,
            "has_initial_prompt": bool(request.initial_prompt),
        },
        audio_duration_ms=audio_duration_ms,
        compute_ms=round(elapsed_s * 1000),
        # Same convention as S3, S6 and the diarization half: audio seconds per wall second,
        # computed from unrounded elapsed time, with model load deliberately outside the
        # window because it is paid once per process rather than once per file.
        realtime_factor=round(audio_duration_ms / 1000 / elapsed_s, 4),
        device=device,
    )
