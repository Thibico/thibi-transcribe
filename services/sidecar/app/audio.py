"""Fetching and sanity-checking the audio.

The sidecar receives an internally-presigned MinIO URL and nothing else — no credentials,
no bucket name it could enumerate, no database. It streams the object to a temp file,
checks that the file it got is the file it was promised, and deletes it on every path
including cancellation and exception.

The duration check is the part worth defending. A truncated or wrong object still decodes,
and pyannote will happily diarize forty seconds of an hour-long interview and report
success. Comparing ffprobe's duration against the engine's `expected_duration_ms` turns
that silent wrong answer into a `bad_audio` failure the engine can act on.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .tasks import AudioError

log = logging.getLogger(__name__)

#: Streamed in chunks so a three-hour file never lands in memory alongside the model.
_CHUNK = 1 << 20


def probe_duration_ms(path: Path) -> int:
    try:
        out = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "csv=p=0",
                str(path),
            ],
            capture_output=True,
            check=True,
            timeout=60,
        )
    except FileNotFoundError as err:
        raise AudioError("internal", "ffprobe is not on PATH", retryable=False) from err
    except subprocess.TimeoutExpired as err:
        raise AudioError("bad_audio", "ffprobe timed out", retryable=False) from err
    except subprocess.CalledProcessError as err:
        raise AudioError(
            "bad_audio",
            f"ffprobe could not read the audio: {err.stderr.decode('utf8', 'replace')[:200]}",
            retryable=False,
        ) from err

    text = out.stdout.decode("utf8").strip()
    try:
        seconds = float(text)
    except ValueError as err:
        raise AudioError("bad_audio", f"ffprobe reported no duration ({text!r})", retryable=False) from err
    if seconds <= 0:
        raise AudioError("bad_audio", "audio has zero duration", retryable=False)
    return round(seconds * 1000)


@contextmanager
def fetched_audio(
    url: str, *, expected_duration_ms: int, tolerance_ms: int, task_id: str
) -> Iterator[Path]:
    """Download, verify, yield, and always clean up.

    The `finally` is asserted by a test on every path — success, cancel and exception —
    because a sidecar that leaks a 400 MB temp file per run fills its disk in a day and the
    symptom is an unrelated failure somewhere else.
    """
    tmpdir = Path(tempfile.mkdtemp(prefix=f"diarize-{task_id[:8]}-"))
    path = tmpdir / "audio"
    try:
        try:
            with urllib.request.urlopen(url, timeout=60) as response:  # noqa: S310 — presigned internal URL
                with path.open("wb") as fh:
                    shutil.copyfileobj(response, fh, _CHUNK)
        except urllib.error.HTTPError as err:
            # 403 is the expected shape of an expired presigned URL. Retryable: the engine
            # re-mints and tries again rather than failing the step.
            raise AudioError(
                "audio_unreachable",
                f"fetching the audio returned HTTP {err.code}",
                retryable=True,
            ) from err
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            raise AudioError(
                "audio_unreachable", f"could not fetch the audio: {err}", retryable=True
            ) from err

        size = path.stat().st_size
        if size == 0:
            # Distinct from "unreachable": a 200 with no body is a storage problem the
            # engine cannot fix by retrying the same key.
            raise AudioError("bad_audio", "the audio object is empty", retryable=False)

        actual_ms = probe_duration_ms(path)
        drift = abs(actual_ms - expected_duration_ms)
        if drift > tolerance_ms:
            raise AudioError(
                "bad_audio",
                f"audio is {actual_ms} ms but the request expected {expected_duration_ms} ms "
                f"({drift} ms apart, tolerance {tolerance_ms} ms) — refusing rather than "
                "diarizing part of a file",
                retryable=False,
            )

        yield path
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
