"""ASR half of the sidecar — Phase 4b, not built.

This file exists so the shape of the service is visible and so `/health` can report
`asr: not_loaded` honestly rather than omitting the field. `buildProvider` on the
TypeScript side already refuses `--provider faster-whisper` with a message saying why, so
nothing can reach this route by accident.

Phase 4a shipped the two HTTP Whisper providers (OpenAI and Groq) and deliberately left
this one, because faster-whisper needs the image this service introduces. **No provider in
the system currently returns genuine per-word confidence except Google**, whose S2
measurement stands; every `wordConfidence: true` claim in Phase 4's plan is waiting on this
file.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

router = APIRouter()


@router.post("/v1/transcribe", status_code=501)
def transcribe() -> None:
    raise HTTPException(
        status_code=501,
        detail=(
            "faster-whisper is Phase 4b and is not built. Use --provider openai or "
            "--provider groq, which run over HTTP and need no sidecar."
        ),
    )
