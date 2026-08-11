"""The contract, asserted from outside.

Every test here is a claim the engine relies on and cannot verify for itself: that a
re-POST never starts a second run, that a different key gets a 429 rather than a queue
place, that a restart yields `lost` rather than 404, and that the temp file is gone on
every path including the ones that raise.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app import main
from app.config import Settings
from app.tasks import TaskRegistry, task_id_for

from .conftest import CannedPipeline, CannedTranscriber


@pytest.fixture
def make_client(tmp_path: Path):
    """Build a client over a fresh registry, with a pipeline the test chooses."""

    def build(pipeline: Any = None, *, data_dir: Path | None = None, **overrides: Any) -> TestClient:
        settings = Settings(
            device="cpu",
            data_dir=str(data_dir or tmp_path / "tasks"),
            hf_token=None,
            **overrides,
        )
        main.state.settings = settings
        main.state.registry = TaskRegistry(
            data_dir=settings.data_dir,
            ttl_s=settings.task_ttl_s,
            max_slots=settings.max_concurrent_tasks,
        )
        main.state.registry.load_journal()
        main.state.pipeline = pipeline if pipeline is not None else CannedPipeline()
        main.state.model_error = None if pipeline is not False else "gate not accepted"
        if pipeline is False:
            main.state.pipeline = None
        # `app` has a lifespan that would load the real model; the state is assembled above
        # instead, so the client must not run it.
        return TestClient(main.app, raise_server_exceptions=False)

    return build


def body(url: str, name: str = "twelve.wav", **overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "idempotency_key": "step-1",
        "audio_url": f"{url}/{name}",
        "expected_duration_ms": 12_000,
        "deadline_s": 60,
    }
    payload.update(overrides)
    return payload


def wait_for(client: TestClient, task_id: str, state: str, timeout: float = 10.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    last: dict[str, Any] = {}
    while time.monotonic() < deadline:
        last = client.get(f"/v1/tasks/{task_id}").json()
        if last["state"] == state:
            return last
        time.sleep(0.02)
    raise AssertionError(f"task never reached {state!r}; last was {last}")


class TestHealth:
    def test_reports_ok_and_the_seeded_estimate(self, make_client: Any) -> None:
        client = make_client()
        health = client.get("/health").json()
        assert health["status"] == "ok"
        # `unavailable` rather than `not_loaded`: this suite deliberately runs without
        # faster-whisper installed, and reporting it as merely unloaded would be a lie.
        assert health["models"] == {"diarization": "loaded", "asr": "unavailable"}
        assert health["slots"] == {"max": 1, "busy": 0}
        # S6's pessimistic end, until this instance has measured its own.
        assert health["realtime_factor_estimate"] == pytest.approx(0.56)

    def test_names_every_gate_when_the_model_is_unavailable(self, make_client: Any) -> None:
        # Three separate gates, and the error only ever names whichever failed first.
        # Under pyannote 4.x that is `speaker-diarization-community-1`, a repo whose name
        # appears nowhere in the model id the operator configured — so an operator who
        # accepts the two obvious ones gets a 403 about a model they have never heard of.
        # Measured against the built image on 2026-08-11.
        client = make_client(False)
        health = client.get("/health").json()
        assert health["status"] == "degraded"
        assert health["models"]["diarization"] == "unavailable"
        assert "speaker-diarization-3.1" in health["detail"]
        assert "segmentation-3.0" in health["detail"]
        assert "speaker-diarization-community-1" in health["detail"]

    def test_replaces_the_estimate_with_what_this_machine_measured(
        self, make_client: Any, audio_server: str
    ) -> None:
        client = make_client()
        submitted = client.post("/v1/diarize", json=body(audio_server))
        wait_for(client, submitted.json()["task_id"], "succeeded")
        assert client.get("/health").json()["realtime_factor_estimate"] != pytest.approx(0.56)


class TestIdempotency:
    def test_a_repeat_key_returns_200_and_never_starts_a_second_run(
        self, make_client: Any, audio_server: str
    ) -> None:
        pipeline = CannedPipeline(delay_s=0.05)
        client = make_client(pipeline)

        first = client.post("/v1/diarize", json=body(audio_server))
        assert first.status_code == 202

        second = client.post("/v1/diarize", json=body(audio_server))
        assert second.status_code == 200
        assert second.json()["task_id"] == first.json()["task_id"]

        wait_for(client, first.json()["task_id"], "succeeded")

        # And again after completion: the cached result, not an hour of recomputation.
        third = client.post("/v1/diarize", json=body(audio_server))
        assert third.status_code == 200
        assert pipeline.calls == 1

    def test_the_task_id_is_reconstructible_from_the_key_alone(
        self, make_client: Any, audio_server: str
    ) -> None:
        # This is what makes a lost 202 recoverable by GET. The engine computes the same
        # uuid5 from the run_step_id it already has.
        client = make_client()
        submitted = client.post("/v1/diarize", json=body(audio_server, idempotency_key="step-xyz"))
        assert submitted.json()["task_id"] == task_id_for("step-xyz")
        assert client.get("/v1/tasks/by-key/step-xyz").json()["task_id"] == task_id_for("step-xyz")


class TestSingleSlot:
    def test_a_different_key_gets_429_with_retry_after(
        self, make_client: Any, audio_server: str
    ) -> None:
        client = make_client(CannedPipeline(delay_s=0.2, steps=10))
        first = client.post("/v1/diarize", json=body(audio_server, idempotency_key="a"))
        assert first.status_code == 202

        busy = client.post("/v1/diarize", json=body(audio_server, idempotency_key="b"))
        assert busy.status_code == 429
        assert busy.json()["error"] == "busy"
        assert busy.headers["retry-after"] == "60"

        # Nothing was started for key b, so its id must still be unknown — the engine reads
        # a 404 as "safe to submit", and it is.
        assert client.get(f"/v1/tasks/{task_id_for('b')}").status_code == 404

    def test_the_slot_is_released_when_the_task_finishes(
        self, make_client: Any, audio_server: str
    ) -> None:
        client = make_client()
        first = client.post("/v1/diarize", json=body(audio_server, idempotency_key="a"))
        wait_for(client, first.json()["task_id"], "succeeded")
        assert client.get("/health").json()["slots"]["busy"] == 0
        assert client.post("/v1/diarize", json=body(audio_server, idempotency_key="b")).status_code == 202

    def test_the_slot_is_released_when_the_task_fails(
        self, make_client: Any, audio_server: str
    ) -> None:
        # The failure mode this guards: one bad audio file wedges the sidecar until restart.
        client = make_client()
        first = client.post(
            "/v1/diarize", json=body(audio_server, "empty.wav", idempotency_key="a")
        )
        wait_for(client, first.json()["task_id"], "failed")
        assert client.get("/health").json()["slots"]["busy"] == 0
        assert client.post("/v1/diarize", json=body(audio_server, idempotency_key="b")).status_code == 202


class TestCancellation:
    def test_cancel_stops_a_running_task_and_frees_the_slot(
        self, make_client: Any, audio_server: str
    ) -> None:
        client = make_client(CannedPipeline(delay_s=0.1, steps=50))
        submitted = client.post("/v1/diarize", json=body(audio_server))
        task_id = submitted.json()["task_id"]
        wait_for(client, task_id, "running")

        assert client.delete(f"/v1/tasks/{task_id}").status_code == 204
        cancelled = wait_for(client, task_id, "cancelled")
        # Terminal, and not an error: the caller asked for this.
        assert cancelled["error"] is None
        assert client.get("/health").json()["slots"]["busy"] == 0

    def test_cancel_is_idempotent_and_204s_on_anything(
        self, make_client: Any, audio_server: str
    ) -> None:
        client = make_client()
        submitted = client.post("/v1/diarize", json=body(audio_server))
        task_id = submitted.json()["task_id"]
        wait_for(client, task_id, "succeeded")

        assert client.delete(f"/v1/tasks/{task_id}").status_code == 204
        assert client.delete(f"/v1/tasks/{task_id}").status_code == 204
        assert client.delete("/v1/tasks/00000000-0000-0000-0000-000000000000").status_code == 204
        # A cancel arriving after success must not rewrite the result.
        assert client.get(f"/v1/tasks/{task_id}").json()["state"] == "succeeded"


class TestRestart:
    def test_a_known_id_reports_lost_rather_than_404(
        self, make_client: Any, audio_server: str, tmp_path: Path
    ) -> None:
        # The distinction the engine cannot recover from if it is wrong: 404 is "safe to
        # submit", `lost` is "this ran and was killed", which counts as an attempt.
        data_dir = tmp_path / "journal"
        client = make_client(CannedPipeline(delay_s=0.2, steps=20), data_dir=data_dir)
        submitted = client.post("/v1/diarize", json=body(audio_server))
        task_id = submitted.json()["task_id"]
        wait_for(client, task_id, "running")

        restarted = make_client(data_dir=data_dir)  # a fresh registry over the same journal
        status = restarted.get(f"/v1/tasks/{task_id}").json()
        assert status["state"] == "lost"
        assert status["error"]["retryable"] is True

    def test_a_lost_task_can_be_resubmitted_under_the_same_key(
        self, make_client: Any, audio_server: str, tmp_path: Path
    ) -> None:
        data_dir = tmp_path / "journal"
        client = make_client(CannedPipeline(delay_s=0.2, steps=20), data_dir=data_dir)
        client.post("/v1/diarize", json=body(audio_server))
        task_id = task_id_for("step-1")
        wait_for(client, task_id, "running")

        restarted = make_client(data_dir=data_dir)
        again = restarted.post("/v1/diarize", json=body(audio_server))
        assert again.status_code == 202  # a new run, not the cached lost one
        wait_for(restarted, task_id, "succeeded")

    def test_a_completed_task_survives_a_restart_as_completed(
        self, make_client: Any, audio_server: str, tmp_path: Path
    ) -> None:
        data_dir = tmp_path / "journal"
        client = make_client(data_dir=data_dir)
        submitted = client.post("/v1/diarize", json=body(audio_server))
        wait_for(client, submitted.json()["task_id"], "succeeded")

        restarted = make_client(data_dir=data_dir)
        status = restarted.get(f"/v1/tasks/{submitted.json()['task_id']}").json()
        assert status["state"] == "succeeded"
        # The result is deliberately not journalled — see Task.to_journal.
        assert status["result"] is None


class TestAudio:
    def test_a_zero_byte_object_is_bad_audio(self, make_client: Any, audio_server: str) -> None:
        client = make_client()
        submitted = client.post("/v1/diarize", json=body(audio_server, "empty.wav"))
        failed = wait_for(client, submitted.json()["task_id"], "failed")
        assert failed["error"]["code"] == "bad_audio"
        assert failed["error"]["retryable"] is False

    def test_undecodable_bytes_are_bad_audio(self, make_client: Any, audio_server: str) -> None:
        client = make_client()
        submitted = client.post("/v1/diarize", json=body(audio_server, "garbage.wav"))
        failed = wait_for(client, submitted.json()["task_id"], "failed")
        assert failed["error"]["code"] == "bad_audio"

    def test_a_duration_mismatch_is_refused_rather_than_half_diarized(
        self, make_client: Any, audio_server: str
    ) -> None:
        # 4 s of audio where 12 s was promised. pyannote would diarize it happily and
        # report success on a third of an interview.
        client = make_client()
        submitted = client.post("/v1/diarize", json=body(audio_server, "four.wav"))
        failed = wait_for(client, submitted.json()["task_id"], "failed")
        assert failed["error"]["code"] == "bad_audio"
        assert "8000 ms apart" in failed["error"]["message"]

    def test_a_mismatch_inside_the_tolerance_is_accepted(
        self, make_client: Any, audio_server: str
    ) -> None:
        client = make_client()
        submitted = client.post(
            "/v1/diarize", json=body(audio_server, expected_duration_ms=12_600)
        )
        wait_for(client, submitted.json()["task_id"], "succeeded")

    def test_an_unreachable_url_is_retryable(self, make_client: Any, audio_server: str) -> None:
        client = make_client()
        submitted = client.post("/v1/diarize", json=body(audio_server, "missing.wav"))
        failed = wait_for(client, submitted.json()["task_id"], "failed")
        assert failed["error"]["code"] == "audio_unreachable"
        assert failed["error"]["retryable"] is True


class TestResult:
    def test_turns_come_back_sorted_and_in_integer_milliseconds(
        self, make_client: Any, audio_server: str
    ) -> None:
        client = make_client(
            CannedPipeline([(4.5, 11.5, "SPEAKER_01"), (0.0, 4.0, "SPEAKER_00")])
        )
        submitted = client.post("/v1/diarize", json=body(audio_server))
        result = wait_for(client, submitted.json()["task_id"], "succeeded")["result"]
        assert result["turns"] == [
            {"start_ms": 0, "end_ms": 4000, "speaker": "SPEAKER_00"},
            {"start_ms": 4500, "end_ms": 11_500, "speaker": "SPEAKER_01"},
        ]
        assert result["num_speakers"] == 2
        assert result["device"] == "cpu"
        assert result["realtime_factor"] > 0

    def test_overlapping_turns_survive_untouched(self, make_client: Any, audio_server: str) -> None:
        # pyannote 3.1 emits overlapping speech, including two turns from one speaker.
        # Anything here that merged or dropped them would silently change the reconciler's
        # input — and reconcile is built to accumulate same-speaker overlap on purpose.
        client = make_client(
            CannedPipeline(
                [(0.8, 1.6, "SPEAKER_00"), (1.0, 1.75, "SPEAKER_01"), (1.5, 1.9, "SPEAKER_00")]
            )
        )
        submitted = client.post("/v1/diarize", json=body(audio_server))
        turns = wait_for(client, submitted.json()["task_id"], "succeeded")["result"]["turns"]
        assert len(turns) == 3
        assert [t["speaker"] for t in turns] == ["SPEAKER_00", "SPEAKER_01", "SPEAKER_00"]

    def test_reads_speaker_diarization_and_not_the_overlap_free_view(
        self, make_client: Any, audio_server: str
    ) -> None:
        # pyannote 4.x hands back both. `exclusive_speaker_diarization` has overlapping
        # speech removed, and taking it would silently discard what reconcile is built
        # around. The fixture puts a sentinel speaker in the wrong field.
        client = make_client(CannedPipeline([(0.0, 4.0, "SPEAKER_00")]))
        submitted = client.post("/v1/diarize", json=body(audio_server))
        turns = wait_for(client, submitted.json()["task_id"], "succeeded")["result"]["turns"]
        assert [t["speaker"] for t in turns] == ["SPEAKER_00"]

    def test_accepts_the_bare_annotation_that_pyannote_3_returns(
        self, make_client: Any, audio_server: str
    ) -> None:
        client = make_client(CannedPipeline([(0.0, 4.0, "SPEAKER_00")], wrap_output=False))
        submitted = client.post("/v1/diarize", json=body(audio_server))
        turns = wait_for(client, submitted.json()["task_id"], "succeeded")["result"]["turns"]
        assert [t["speaker"] for t in turns] == ["SPEAKER_00"]

    def test_progress_is_reported_while_running(self, make_client: Any, audio_server: str) -> None:
        # Without this an operator watches nothing happen for an hour and forty minutes.
        client = make_client(CannedPipeline(delay_s=0.05, steps=20))
        submitted = client.post("/v1/diarize", json=body(audio_server))
        task_id = submitted.json()["task_id"]
        wait_for(client, task_id, "running")

        seen: list[float] = []
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            status = client.get(f"/v1/tasks/{task_id}").json()
            if status["progress"] is not None:
                seen.append(status["progress"])
            if status["state"] == "succeeded":
                break
            time.sleep(0.02)
        assert seen, "no progress was ever reported"
        assert max(seen) > 0


class TestValidation:
    def test_num_speakers_is_exclusive_with_a_range(self, make_client: Any, audio_server: str) -> None:
        client = make_client()
        response = client.post(
            "/v1/diarize", json=body(audio_server, num_speakers=3, min_speakers=2)
        )
        assert response.status_code == 422

    def test_an_inverted_speaker_range_is_rejected(self, make_client: Any, audio_server: str) -> None:
        client = make_client()
        response = client.post(
            "/v1/diarize", json=body(audio_server, min_speakers=4, max_speakers=2)
        )
        assert response.status_code == 422

    def test_diarize_is_503_with_the_gate_urls_when_the_model_is_missing(
        self, make_client: Any, audio_server: str
    ) -> None:
        client = make_client(False)
        response = client.post("/v1/diarize", json=body(audio_server))
        assert response.status_code == 503
        error = response.json()["error"]
        assert error["code"] == "model_unavailable"
        assert error["retryable"] is True
        assert len(error["gates"]) == 3


def asr_body(url: str, name: str = "twelve.wav", **overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "idempotency_key": "asr-step-1",
        "audio_url": f"{url}/{name}",
        "expected_duration_ms": 12_000,
        "model": "tiny",
        "deadline_s": 60,
    }
    payload.update(overrides)
    return payload


class TestTranscribe:
    """Phase 4b. The lifecycle is Phase 3's and is not re-asserted here — what is asserted
    is what is new: the parameters that reach faster-whisper, the per-word probability
    surviving the wire, the allowlist, and the slot being genuinely *shared* between the two
    workloads rather than merely documented as shared."""

    def test_returns_segments_and_per_word_probabilities_intact(
        self, make_client: Any, audio_server: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        transcriber = CannedTranscriber()
        monkeypatch.setattr(main, "get_model", lambda *_a, **_k: transcriber)
        client = make_client()

        accepted = client.post("/v1/transcribe", json=asr_body(audio_server))
        assert accepted.status_code == 202
        status = wait_for(client, accepted.json()["task_id"], "succeeded")

        result = status["result"]
        # The discriminator, without which a client polling one endpoint has to guess which
        # result shape it got by looking for fields.
        assert result["kind"] == "transcribe"
        assert result["language"] == "en"
        assert [s["text"] for s in result["segments"]] == [" Hello.", " Goodbye."]
        # Four decimal places, unrounded. This provider exists for this number.
        assert [w["probability"] for w in result["segments"][0]["words"]] == [0.9137, 0.4062]
        assert result["segments"][0]["avg_logprob"] == pytest.approx(-0.2481)
        assert result["audio_duration_ms"] == pytest.approx(12_000, abs=100)

    def test_passes_the_parameters_that_matter_and_pins_the_one_that_is_not_a_knob(
        self, make_client: Any, audio_server: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        transcriber = CannedTranscriber()
        monkeypatch.setattr(main, "get_model", lambda *_a, **_k: transcriber)
        client = make_client()

        accepted = client.post(
            "/v1/transcribe",
            json=asr_body(audio_server, language="my", vad_min_silence_ms=700, beam_size=3),
        )
        wait_for(client, accepted.json()["task_id"], "succeeded")

        assert transcriber.kwargs["language"] == "my"
        assert transcriber.kwargs["beam_size"] == 3
        assert transcriber.kwargs["word_timestamps"] is True
        assert transcriber.kwargs["vad_filter"] is True
        assert transcriber.kwargs["vad_parameters"] == {"min_silence_duration_ms": 700}
        # **False, and not from the request.** The default True is the classic
        # repetition-loop trigger on long low-resource audio, which is the entire use case,
        # so a request asking for True must not get it.
        assert transcriber.kwargs["condition_on_previous_text"] is False

    def test_condition_on_previous_text_cannot_be_turned_on_from_the_wire(
        self, make_client: Any, audio_server: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        transcriber = CannedTranscriber()
        monkeypatch.setattr(main, "get_model", lambda *_a, **_k: transcriber)
        client = make_client()
        accepted = client.post(
            "/v1/transcribe", json=asr_body(audio_server, condition_on_previous_text=True)
        )
        status = wait_for(client, accepted.json()["task_id"], "succeeded")
        assert transcriber.kwargs["condition_on_previous_text"] is False
        assert status["result"]["params"]["condition_on_previous_text"] is False

    def test_words_are_absent_rather_than_an_error_when_timestamps_are_off(
        self, make_client: Any, audio_server: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # faster-whisper sets `words` to None, not [], which is where an AttributeError
        # would come from if the code trusted the type.
        transcriber = CannedTranscriber(words=False)
        monkeypatch.setattr(main, "get_model", lambda *_a, **_k: transcriber)
        client = make_client()
        accepted = client.post(
            "/v1/transcribe", json=asr_body(audio_server, word_timestamps=False)
        )
        status = wait_for(client, accepted.json()["task_id"], "succeeded")
        assert status["result"]["segments"][0]["words"] == []

    def test_refuses_a_model_outside_the_allowlist(
        self, make_client: Any, audio_server: str
    ) -> None:
        # `model` reaches `WhisperModel(name)`, which downloads and runs whatever it is
        # handed. The sidecar is unauthenticated by design, so this is the one place that
        # can be closed.
        client = make_client()
        response = client.post(
            "/v1/transcribe", json=asr_body(audio_server, model="attacker/whatever")
        )
        assert response.status_code == 400
        assert "allowlist" in response.json()["error"]["message"]

    def test_shares_the_single_slot_with_diarization(
        self, make_client: Any, audio_server: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The claim Phase 4 §5 makes and Phase 3 could not test: **one slot, both
        workloads**. A `--diarize --provider faster-whisper` run takes the sum of the two
        stages rather than their max, and the reason it is safe to say so is this 429."""
        monkeypatch.setattr(main, "get_model", lambda *_a, **_k: CannedTranscriber())
        client = make_client(CannedPipeline(delay_s=0.2, steps=20))

        diarize = client.post("/v1/diarize", json=body(audio_server))
        assert diarize.status_code == 202
        busy = client.post("/v1/transcribe", json=asr_body(audio_server))
        assert busy.status_code == 429
        assert busy.headers["retry-after"] == "60"

    def test_cancels_mid_run(
        self, make_client: Any, audio_server: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The generator is the yield point, and it yields per segment rather than per stage
        # — a finer cancellation grain than pyannote's hook offers.
        monkeypatch.setattr(
            main,
            "get_model",
            lambda *_a, **_k: CannedTranscriber(
                segments=[(float(i), float(i) + 1, f" {i}") for i in range(40)], delay_s=0.05
            ),
        )
        client = make_client()
        accepted = client.post("/v1/transcribe", json=asr_body(audio_server))
        task_id = accepted.json()["task_id"]
        wait_for(client, task_id, "running", timeout=2.0)
        assert client.delete(f"/v1/tasks/{task_id}").status_code == 204
        wait_for(client, task_id, "cancelled")

    def test_progress_is_a_real_fraction_and_never_goes_backwards(
        self, make_client: Any, audio_server: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Unlike pyannote's, whose per-stage count restarts and *does* go backwards
        # (overview amendment 44). Here `segment.end / duration` is monotone by
        # construction, and an operator can read it as "how far through the file".
        monkeypatch.setattr(
            main,
            "get_model",
            lambda *_a, **_k: CannedTranscriber(
                segments=[(float(i), float(i) + 1, f" {i}") for i in range(12)], delay_s=0.04
            ),
        )
        client = make_client()
        accepted = client.post("/v1/transcribe", json=asr_body(audio_server))
        task_id = accepted.json()["task_id"]

        seen: list[float] = []
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            status = client.get(f"/v1/tasks/{task_id}").json()
            if status["progress"] is not None:
                seen.append(status["progress"])
            if status["state"] == "succeeded":
                break
            time.sleep(0.01)

        assert seen, "no progress was ever reported"
        assert seen == sorted(seen)
        assert max(seen) == 1.0

    def test_the_realtime_factor_windows_do_not_blend(
        self, make_client: Any, audio_server: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The bug this would otherwise be: `/health.realtime_factor_estimate` is what the
        engine shows a user *before a diarization*, and a shared window would let a fast ASR
        run drag it upward. The failure would be a number nobody could explain rather than
        an exception, which is why it is asserted rather than reasoned about."""
        monkeypatch.setattr(main, "get_model", lambda *_a, **_k: CannedTranscriber())
        client = make_client()

        d = client.post("/v1/diarize", json=body(audio_server))
        wait_for(client, d.json()["task_id"], "succeeded")
        a = client.post("/v1/transcribe", json=asr_body(audio_server))
        wait_for(client, a.json()["task_id"], "succeeded")

        health = client.get("/health").json()
        factors = health["realtime_factors"]
        assert set(factors) == {"diarize", "asr:tiny"}
        # The headline field still means diarization, and nothing else.
        assert health["realtime_factor_estimate"] == factors["diarize"]
        assert factors["diarize"] != factors["asr:tiny"]

    def test_health_reports_asr_honestly(
        self, make_client: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        client = make_client()
        # This suite runs without faster-whisper installed — deliberately, because the whole
        # point of the Transcriber protocol is that the contract is testable without
        # CTranslate2. `unavailable` is therefore the honest answer here.
        assert client.get("/health").json()["models"]["asr"] == "unavailable"

        monkeypatch.setattr(main, "asr_available", lambda: True)
        assert client.get("/health").json()["models"]["asr"] == "not_loaded"

        monkeypatch.setattr(main, "loaded_model_name", lambda: "large-v3")
        health = client.get("/health").json()
        assert health["models"]["asr"] == "loaded"
        assert health["asr_model"] == "large-v3"
