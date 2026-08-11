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


def temp_children(task_id: str) -> set[Path]:
    """Temp directories belonging to **this** task, not every task on the machine.

    The first version globbed `diarize-*` and compared the whole set before and after, which
    made these assertions sensitive to anything else running. `tasks.py` runs each
    diarization on a background thread, and several API tests deliberately start a task and
    never wait for it — the 429 test wants a task *still holding the slot* — so those threads
    outlive their test and hold a temp directory while this file is snapshotting. Measured as
    a 1-in-5 failure of `test_cleaned_up_when_the_caller_raises` across five full runs.

    Scoping to the task id is both the fix and the better assertion: these tests are about
    one contextmanager cleaning up after itself, not about the state of `/tmp`.
    """
    return {p for p in Path(tempfile.gettempdir()).glob(f"diarize-{task_id[:8]}-*")}


def test_cleaned_up_after_success(audio_server: str) -> None:
    before = temp_children("t1")
    with fetched_audio(
        f"{audio_server}/twelve.wav", expected_duration_ms=12_000, tolerance_ms=1000, task_id="t1"
    ) as path:
        assert path.exists()
        inside = path.parent
    assert not inside.exists()
    assert temp_children("t1") == before


def test_cleaned_up_when_the_caller_raises(audio_server: str) -> None:
    before = temp_children("t2")
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
    assert temp_children("t2") == before


def test_cleaned_up_when_the_duration_check_fails(audio_server: str) -> None:
    # The failure happens *before* the yield, so a naive try/finally around only the body
    # would miss this one entirely.
    before = temp_children("t3")
    with pytest.raises(AudioError) as raised:
        with fetched_audio(
            f"{audio_server}/four.wav",
            expected_duration_ms=12_000,
            tolerance_ms=1000,
            task_id="t3",
        ):
            pass
    assert raised.value.code == "bad_audio"
    assert temp_children("t3") == before


def test_cleaned_up_when_the_object_is_empty(audio_server: str) -> None:
    before = temp_children("t4")
    with pytest.raises(AudioError):
        with fetched_audio(
            f"{audio_server}/empty.wav",
            expected_duration_ms=12_000,
            tolerance_ms=1000,
            task_id="t4",
        ):
            pass
    assert temp_children("t4") == before


def test_cleaned_up_when_the_url_is_unreachable(audio_server: str) -> None:
    # Nothing was ever written here, but the directory was created before the request.
    before = temp_children("t5")
    with pytest.raises(AudioError) as raised:
        with fetched_audio(
            f"{audio_server}/missing.wav",
            expected_duration_ms=12_000,
            tolerance_ms=1000,
            task_id="t5",
        ):
            pass
    assert raised.value.code == "audio_unreachable"
    assert temp_children("t5") == before
