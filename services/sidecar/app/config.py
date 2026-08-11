"""Sidecar configuration.

Read from the environment exactly once, here. The engine packages are forbidden ambient
configuration by an ESLint rule and a CI grep; this service is the Python equivalent of
`apps/cli/src/context.ts` — the one module allowed to look at `os.environ`, with an
exhaustive list of what it may look at.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal, Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SIDECAR_", extra="ignore")

    #: 'cpu' | 'cuda'. S6 measured ~0.6x realtime on six CPU cores; the 8-20x GPU figure in
    #: the plans is inherited and still unmeasured, and must not be quoted until it is.
    device: Literal["cpu", "cuda"] = "cpu"

    #: **One.** pyannote and faster-whisper both saturate every core and both allocate
    #: GB-scale tensors, so two concurrent tasks are *slower* than running them in sequence
    #: and can OOM the container. The 429 this produces is what makes the single slot
    #: visible to the caller instead of turning into a mysterious timeout.
    max_concurrent_tasks: int = 1

    #: A completed task's result stays fetchable this long, so a re-POST after a lost
    #: response returns the cached answer instead of re-running an hour of compute.
    task_ttl_s: int = 86_400

    diarization_model: str = "pyannote/speaker-diarization-3.1"
    hf_token: Optional[str] = None
    hf_home: str = "/cache/hf"

    #: Which faster-whisper models this instance will load, Phase 4b.
    #:
    #: An allowlist rather than a free string, because `model` is a request field and
    #: `WhisperModel(name)` will happily download whatever it is given from the Hugging Face
    #: hub. The sidecar is internal and unauthenticated *by design* — it holds no credentials
    #: precisely so it can be trusted with none — which makes "any request can make it fetch
    #: and execute arbitrary weights" a gap worth closing with six lines.
    #:
    #: `tiny` and `base` are here for tests and for a first run on a laptop, not because
    #: anybody should transcribe with them. `distil-large-v3` is **English only** — a
    #: distillation of English data, which is why the overview's "default to distil-large-v3"
    #: was corrected in Phase 4 risk 1.
    asr_allowed_models: list[str] = [
        "large-v3",
        "large-v3-turbo",
        "distil-large-v3",
        "medium",
        "small",
        "base",
        "tiny",
    ]

    #: CTranslate2 worker threads. 0 means "all cores", which is right when one task runs at
    #: a time — and one task at a time is enforced by `max_concurrent_tasks`.
    asr_cpu_threads: int = 0

    #: Where the task journal lives. Survives a container restart so a known id resolves to
    #: `lost` rather than 404 — see `tasks.py` for why that distinction is load-bearing.
    data_dir: str = "/data/tasks"

    #: Seeds `/health.realtime_factor_estimate` until this instance has measured its own.
    #: S6, 2026-08-10, multi-speaker CPU. Deliberately the pessimistic end of 0.56-0.61.
    default_realtime_factor: float = 0.56

    #: ffprobe duration must agree with the client's `expected_duration_ms` within this.
    duration_tolerance_ms: int = 1000

    #: torch thread count. None leaves torch's own choice, which picked 6 on a 12-thread
    #: box in S6; `--threads 12` was never tried and might help or thrash.
    torch_threads: Optional[int] = None

    @property
    def gate_urls(self) -> list[str]:
        """Every gate a human has to accept, in the order they fail.

        **Three, not two, and the third is measured rather than documented.** S6 found that
        `pyannote/speaker-diarization-3.1` and `pyannote/segmentation-3.0` are gated
        separately, so accepting only the first still fails at pipeline load with an error
        that never names the second. Running the built image on 2026-08-11 found a third:
        pyannote 4.x resolves `speaker-diarization-3.1` through
        **`pyannote/speaker-diarization-community-1`**, a repo with a different name that is
        gated on its own and is not mentioned anywhere in the pipeline id the operator typed.

        The failure is a 403 naming only the community repo. An operator who accepts the two
        obvious gates gets a 403 pointing at a model they have never heard of, so all three
        are printed together whenever anything is unavailable.
        """
        return [
            "https://huggingface.co/pyannote/speaker-diarization-3.1",
            "https://huggingface.co/pyannote/segmentation-3.0",
            "https://huggingface.co/pyannote/speaker-diarization-community-1",
        ]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
