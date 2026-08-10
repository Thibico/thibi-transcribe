"""
S6 — How slow is pyannote diarization on a CPU, actually?

Phase 3's plan carries a table it never measured:

    CPU, 8 cores   0.15-0.4x realtime   1-hour file: 2.5-7 h    3-hour file: 7.5-20 h
    One 12 GB GPU  8-20x    realtime    1-hour file: 3-8 min    3-hour file: 9-25 min

Every product decision in that phase hangs off it — diarization defaults to off, the UI shows
an estimate before the run rather than after, `deadline_at` is 12x duration, and the
deployment guide is supposed to say plainly that the GPU tier is the difference between
"overnight" and "coffee". If the real factor is at the top of that range the feature is
usable on a self-hosted box; at the bottom it is an overnight job and the honest answer for
the small tier is to not offer it. That is a scope decision, so it is worth an hour before
it is worth two sessions.

The range is also inherited rather than measured: nothing in this repo has ever run pyannote.
Phase 0 measured its Google premises before Phase 1 and Phase 2 measured S4/S5 before writing
a line, and this is the same move one phase earlier than usual.

WHAT IS MEASURED

  realtime_factor = audio_seconds / wall_seconds

Consistent with the rest of the repo: S3 reported batchRecognize at 5.9x meaning 5.9x faster
than realtime, and the Phase 3 table's 0.15-0.4x means 2.5-7x slower. Above 1 is faster than
the audio plays.

Model load is timed separately and excluded from the factor. It is a real cost, but it is
paid once per worker process rather than once per file, and folding a fixed ~20 s into a
106 s clip would report a number that no 3-hour file would ever reproduce. Both are printed;
only inference feeds the factor.

The input is converted to 16 kHz mono first, which is what `norm_16k_mono_flac` produces and
therefore what the sidecar would actually be handed. Feeding a 192 kHz file — which is what
that derivative silently was until 2026-08-10 — would measure decode cost that production
does not pay.

WHY THIS MACHINE'S NUMBER TRANSFERS

An Intel i9-8950HK is x86 CPU-only, so there is no Apple-Silicon MPS path quietly making the
result unreproducible on a Linux VPS. `--threads` exists because the plan's row says "8
cores" and this box has 12: constraining torch is the closest available analogue of a
smaller server, and the difference between the two is itself worth knowing.

    HF_TOKEN=hf_... uv run --with "pyannote.audio==3.3.2" --with "numpy<2" --python 3.11 \
        spikes/s6-diarization.py AUDIO [AUDIO...] [--threads N] [--device cpu]

pyannote/speaker-diarization-3.1 and pyannote/segmentation-3.0 are both gated: accept the
terms on each model page, then supply a read token.

Both pins are load-bearing rather than cautious. `numpy<2` because torch 2.2.2 is built
against the NumPy 1.x C API and resolving NumPy 2.x gives "Failed to initialize NumPy:
_ARRAY_API not found" — a UserWarning at import that becomes a failure at the first
tensor-to-array conversion, which is to say in the middle of a measurement rather than at the
start of one. And torch is 2.2.2 because it is the last release with x86 macOS wheels, which
is what this machine is; a Linux sidecar will resolve something newer and should re-check the
pairing rather than inherit this line.
"""

import argparse
import inspect
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

RAW = Path(__file__).parent / "raw"
MODEL = "pyannote/speaker-diarization-3.1"


def patch_hf_auth_kwarg() -> bool:
    """Translate pyannote's `use_auth_token=` into huggingface_hub's `token=`.

    pyannote.audio 3.3.2 calls `hf_hub_download(..., use_auth_token=use_auth_token)`
    unconditionally (core/pipeline.py:102), and huggingface_hub renamed that parameter to
    `token` and dropped the alias — it is already gone by 0.36.2, and 1.4.1 is what resolves
    today. No value of the argument avoids it, so this is a hard failure at pipeline load.

    The alternative was pinning a hub old enough to still accept the alias. That is rejected
    deliberately: the Phase 3 sidecar runs Linux with pyannote 4.x, which requires torch
    >= 2.8 and calls `token=` natively. Pinning here would make the spike reproducible only
    on a dead branch of the dependency graph, and would teach the sidecar the wrong lesson.

    This machine is stuck on pyannote 3.3.2 for an unrelated reason worth writing down: it is
    x86 macOS, and PyTorch published no wheels after 2.2.2 for that platform, while pyannote
    4.x demands torch >= 2.8. So the version skew is a property of the measuring instrument,
    not of the thing being measured — the realtime factor is pyannote's, not the shim's.

    Returns whether the patch was needed, so the run records which path it took.
    """
    import huggingface_hub

    if "use_auth_token" in inspect.signature(huggingface_hub.hf_hub_download).parameters:
        return False

    original = huggingface_hub.hf_hub_download

    def shim(*args, use_auth_token=None, **kwargs):
        if use_auth_token is not None and "token" not in kwargs:
            kwargs["token"] = use_auth_token
        return original(*args, **kwargs)

    # Rebind everywhere, not just on the hub module: pyannote imports the symbol by name at
    # module load, so patching only `huggingface_hub` would leave those references untouched.
    huggingface_hub.hf_hub_download = shim
    for name, module in list(sys.modules.items()):
        if name.startswith("pyannote") and getattr(module, "hf_hub_download", None) is original:
            module.hf_hub_download = shim
    return True


def probe_duration(path: str) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
        capture_output=True,
        text=True,
        check=True,
    )
    return float(out.stdout.strip())


def to_16k_mono(src: str, dst: str) -> None:
    """The shape norm_16k_mono_flac produces. wav rather than flac: pyannote decodes either,
    and this keeps ffmpeg's cost out of a measurement that is about the model."""
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", src, "-ac", "1", "-ar", "16000", dst],
        check=True,
    )


def human(seconds: float) -> str:
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    return f"{h}h {m:02d}m" if h else f"{m}m {s:02d}s"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio", nargs="+")
    ap.add_argument("--threads", type=int, default=None, help="torch intra-op threads")
    ap.add_argument("--device", default="cpu", choices=["cpu", "cuda", "mps"])
    args = ap.parse_args()

    token = os.environ.get("HF_TOKEN")
    if not token:
        print("HF_TOKEN is not set. pyannote/speaker-diarization-3.1 is a gated repo:", file=sys.stderr)
        print("  1. accept https://huggingface.co/pyannote/speaker-diarization-3.1", file=sys.stderr)
        print("  2. accept https://huggingface.co/pyannote/segmentation-3.0", file=sys.stderr)
        print("  3. read token from https://huggingface.co/settings/tokens", file=sys.stderr)
        return 2

    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        print("ffmpeg and ffprobe must be on PATH.", file=sys.stderr)
        return 2

    import torch
    from pyannote.audio import Pipeline

    patched = patch_hf_auth_kwarg()

    if args.threads:
        torch.set_num_threads(args.threads)

    env = {
        "measured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model": MODEL,
        "device": args.device,
        "torch": torch.__version__,
        "torch_threads": torch.get_num_threads(),
        "python": sys.version.split()[0],
        "platform": sys.platform,
        "pyannote": __import__("pyannote.audio", fromlist=["__version__"]).__version__,
        "huggingface_hub": __import__("huggingface_hub").__version__,
        "hf_auth_kwarg_patched": patched,
        "cpu": subprocess.run(
            ["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True
        ).stdout.strip()
        or "unknown",
    }

    # Timed on its own: paid once per worker process, not once per file. A cold run also pays
    # the weight download here, which is why the number is reported rather than folded in.
    t0 = time.perf_counter()
    pipeline = Pipeline.from_pretrained(MODEL, use_auth_token=token)
    pipeline.to(torch.device(args.device))
    load_s = time.perf_counter() - t0
    print(f"model load: {load_s:.1f}s  (device={args.device}, threads={env['torch_threads']})\n")

    results = []
    for path in args.audio:
        duration = probe_duration(path)
        with tempfile.TemporaryDirectory() as tmp:
            wav = str(Path(tmp) / "audio.wav")
            to_16k_mono(path, wav)

            t0 = time.perf_counter()
            annotation = pipeline(wav)
            infer_s = time.perf_counter() - t0

        speakers = sorted({label for _, _, label in annotation.itertracks(yield_label=True)})
        turns = sum(1 for _ in annotation.itertracks())
        factor = duration / infer_s

        row = {
            "file": Path(path).name,
            "audio_s": round(duration, 1),
            "infer_s": round(infer_s, 1),
            "realtime_factor": round(factor, 3),
            "speakers": len(speakers),
            "turns": turns,
            "projected_1h": round(3600 / factor),
            "projected_3h": round(10800 / factor),
        }
        results.append(row)

        print(f"{row['file']}")
        print(f"  audio            {human(duration)} ({row['audio_s']}s)")
        print(f"  diarization      {human(infer_s)} ({row['infer_s']}s)")
        # Printed from the rounded row rather than the raw float, so this line and the verdict
        # below cannot disagree in the second decimal about the same measurement.
        print(
            f"  realtime factor  {row['realtime_factor']:.2f}x"
            f"   ({1 / factor:.1f}x slower than realtime)"
        )
        print(f"  speakers         {len(speakers)} over {turns} turns")
        print(f"  projects to      1h file: {human(row['projected_1h'])}   3h file: {human(row['projected_3h'])}")
        print()

    # One file per audio input. The first version keyed only on device and thread count, so a
    # second invocation silently overwrote the first — the 106 s run was destroyed by the
    # 25 min run before either had been written up. A spike that eats its own evidence cannot
    # honour "a disputed number can be re-measured", which is the whole reason raw output is
    # kept, so the audio identity is part of the name.
    RAW.mkdir(exist_ok=True)
    for row in results:
        stem = Path(row["file"]).stem[:40]
        out = RAW / f"s6-{stem}-{args.device}-{env['torch_threads']}t.json"
        out.write_text(
            json.dumps({"env": env, "load_s": round(load_s, 1), "run": row}, indent=2)
        )
        print(f"wrote {out.relative_to(Path(__file__).parent.parent)}")

    # The comparison the phase plan actually needs.
    print("\nagainst the Phase 3 plan's unmeasured table (CPU, 8 cores: 0.15-0.4x):")
    for row in results:
        f = row["realtime_factor"]
        verdict = "within" if 0.15 <= f <= 0.4 else ("faster than" if f > 0.4 else "slower than")
        print(f"  {row['file']}: {f:.2f}x — {verdict} the planned range")
    return 0


if __name__ == "__main__":
    sys.exit(main())
