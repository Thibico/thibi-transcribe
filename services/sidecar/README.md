# thibi sidecar

The Python half of the pipeline: pyannote diarization (Phase 3) and faster-whisper ASR
(Phase 4b, not built). One image, because the two share torch, ffmpeg and about 2 GB of
wheels and never run concurrently — there is exactly one task slot.

**It holds no credentials and never talks to Postgres.** It is a pure function of
`(audio, params) → turns`, which is what makes it safe to run unprivileged and easy to
test. Audio arrives as an internally-presigned MinIO URL minted by the engine.

## Running it

```bash
docker compose -f infra/compose.dev.yml --profile diarize up -d sidecar
curl -s localhost:8081/health | jq
```

It is behind a `diarize` profile because it is a ~4 GB image nobody needs in order to run
the TypeScript test suite.

`pyannote/speaker-diarization-3.1` is **gated on Hugging Face**, and so is
`pyannote/segmentation-3.0`, **separately** — accepting only the first still fails at
pipeline load with an error that never names the second (spike S6). Accept both with the
account that owns `HF_TOKEN`. A sidecar without them still starts and answers `/health`
with `status: degraded` and both URLs in `detail`, rather than exiting with nothing for an
operator to read.

## The tests

```bash
cd services/sidecar
uv run --python 3.11 --with 'fastapi>=0.115' --with 'pydantic-settings>=2.5' \
  --with 'pytest>=8.3' --with 'httpx>=0.27' python -m pytest
```

**No torch, no pyannote, no model download.** The `Pipeline` protocol in `diarize.py` is
structural precisely so the routes, the idempotency, the single slot, the failure taxonomy
and the temp-file cleanup are testable against a canned pipeline. Requiring a 2 GB
dependency and a gated download in order to assert that a second key gets a 429 would mean
nobody ran the suite.

The audio *is* real — ffmpeg-generated tones served over a genuine HTTP server — because
every case being tested is about the fetch, and a monkeypatched `urlopen` would be testing
the monkeypatch.

What the suite therefore does **not** cover, and what does: the image build covers whether
pyannote 4.x installs and which token keyword it takes; a contract test against the running
container covers whether the JSON matches what `packages/engine/src/diarize/pyannote.ts`
expects; and only a real run covers accuracy, which is `thibi diarize score` against an
RTTM reference in Phase 5.

## The contract

Four routes, defined in `app/schemas.py`. Two details carry most of the operational weight:

**`task_id = uuid5(NAMESPACE_URL, idempotency_key)`**, where the key is the engine's
`run_step_id`. Deterministic, so a lost 202 is recoverable by GET alone and a re-POST never
starts a second run. Diarization costs about an audio-hour of CPU per audio-hour; starting
a duplicate because a response packet went missing is the expensive mistake.

**A known id after a restart is `lost`, not 404.** 404 means "never seen, safe to submit";
`lost` means "this ran and was killed", which the engine counts as an attempt. Without the
on-disk journal the two are indistinguishable and a crash-looping container becomes an
infinite retry loop.
