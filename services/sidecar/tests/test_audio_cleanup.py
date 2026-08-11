"""The temp file must be gone on **every** path.

Its own file because the assertion is the same in each case and the cases are the point:
success, a validation failure before the yield, an exception raised by the caller inside
the `with`, and cancellation. A sidecar that leaks a 400 MB temp file per run fills its
disk in a day, and the symptom is an unrelated failure somewhere else entirely.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from app.audio import fetched_audio
from app.tasks import AudioError


def temp_children() -> set[Path]:
    return {p for p in Path(tempfile.gettempdir()).glob("diarize-*")}


def test_cleaned_up_after_success(audio_server: str) -> None:
    before = temp_children()
    with fetched_audio(
        f"{audio_server}/twelve.wav", expected_duration_ms=12_000, tolerance_ms=1000, task_id="t1"
    ) as path:
        assert path.exists()
        inside = path.parent
    assert not inside.exists()
    assert temp_children() == before


def test_cleaned_up_when_the_caller_raises(audio_server: str) -> None:
    before = temp_children()
    inside: Path | None = None
    with pytest.raises(ValueError):
        with fetched_audio(
            f"{audio_server}/twelve.wav",
            expected_duration_ms=12_000,
            tolerance_ms=1000,
            task_id="t2",
        ) as path:
            inside = path.parent
            raise ValueError("pyannote fell over")
    assert inside is not None and not inside.exists()
    assert temp_children() == before


def test_cleaned_up_when_the_duration_check_fails(audio_server: str) -> None:
    # The failure happens *before* the yield, so a naive try/finally around only the body
    # would miss this one entirely.
    before = temp_children()
    with pytest.raises(AudioError) as raised:
        with fetched_audio(
            f"{audio_server}/four.wav",
            expected_duration_ms=12_000,
            tolerance_ms=1000,
            task_id="t3",
        ):
            pass
    assert raised.value.code == "bad_audio"
    assert temp_children() == before


def test_cleaned_up_when_the_object_is_empty(audio_server: str) -> None:
    before = temp_children()
    with pytest.raises(AudioError):
        with fetched_audio(
            f"{audio_server}/empty.wav",
            expected_duration_ms=12_000,
            tolerance_ms=1000,
            task_id="t4",
        ):
            pass
    assert temp_children() == before


def test_cleaned_up_when_the_url_is_unreachable(audio_server: str) -> None:
    # Nothing was ever written here, but the directory was created before the request.
    before = temp_children()
    with pytest.raises(AudioError) as raised:
        with fetched_audio(
            f"{audio_server}/missing.wav",
            expected_duration_ms=12_000,
            tolerance_ms=1000,
            task_id="t5",
        ):
            pass
    assert raised.value.code == "audio_unreachable"
    assert temp_children() == before
