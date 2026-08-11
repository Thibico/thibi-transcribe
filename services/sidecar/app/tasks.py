"""Task registry: idempotency, the single slot, cancellation, and the journal.

Three decisions here carry most of the operational weight.

**`task_id = uuid5(NAMESPACE_URL, idempotency_key)`.** Deterministic, so the engine can
reconstruct the id from the `run_step_id` it already has. A lost 202 response is then
recoverable by GET alone, and a re-POST with the same key never starts a second run.
Diarization costs an hour of CPU per audio-hour; starting a duplicate because a response
packet went missing is the expensive mistake this prevents.

**A known id after a restart is `lost`, not 404.** The distinction is load-bearing: 404
means "never seen, safe to submit", while `lost` means "this ran and was killed", which the
engine must count as an attempt. Without the journal the two are indistinguishable and a
crash-looping container becomes an infinite retry loop.

**One slot, enforced by a non-blocking semaphore.** A second *different* key gets 429 with
`Retry-After` and, critically, the engine does not count that as an attempt. `worker-heavy`
at concurrency 1 is the redundant outer guard; the two are deliberately belt-and-braces
because the failure mode being guarded against is an OOM kill, not an error message.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from .schemas import DiarizeResult, TaskError, TaskState

log = logging.getLogger(__name__)

#: Same namespace on both sides of the contract. Changing it silently breaks idempotency
#: for every in-flight task, so it is a constant rather than configuration.
NAMESPACE = uuid.NAMESPACE_URL


def task_id_for(idempotency_key: str) -> str:
    return str(uuid.uuid5(NAMESPACE, idempotency_key))


class Cancelled(Exception):
    """Raised inside a worker when the client cancelled or the deadline fired."""


@dataclass
class Task:
    task_id: str
    idempotency_key: str
    state: TaskState = "queued"
    #: Fraction through `step`, not through the whole run. See `diarize.run_diarization`.
    progress: Optional[float] = None
    #: The pyannote stage currently running — 'segmentation', 'embeddings', 'clustering'.
    step: Optional[str] = None
    accepted_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    expires_at: float = 0.0
    result: Optional[DiarizeResult] = None
    error: Optional[TaskError] = None
    #: Cooperative cancellation. Checked inside pyannote's progress hook, which is the only
    #: place the pipeline yields — there is no way to interrupt it between hook calls.
    cancel: threading.Event = field(default_factory=threading.Event)

    @property
    def terminal(self) -> bool:
        return self.state in ("succeeded", "failed", "cancelled", "lost")

    def to_journal(self) -> dict[str, object]:
        """What survives a restart.

        The result is *not* journalled. It can be tens of thousands of turns, it is only
        useful to a caller that is still polling, and a task recovered from disk reports
        `lost` regardless — so writing it would be bytes spent on a state that can never be
        served.
        """
        return {
            "task_id": self.task_id,
            "idempotency_key": self.idempotency_key,
            "state": self.state,
            "accepted_at": self.accepted_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "expires_at": self.expires_at,
        }


class Busy(Exception):
    """The single slot is held by a different task."""

    def __init__(self, retry_after_s: int) -> None:
        super().__init__("busy")
        self.retry_after_s = retry_after_s


class TaskRegistry:
    """In-memory registry plus an on-disk journal.

    Not a queue. There is exactly one slot and no waiting line: a second key is rejected
    with 429 rather than enqueued, because the caller has a scheduler and this service does
    not need a second one.
    """

    def __init__(self, *, data_dir: str, ttl_s: int, max_slots: int = 1) -> None:
        self._data_dir = Path(data_dir)
        self._ttl_s = ttl_s
        self._max_slots = max_slots
        self._lock = threading.RLock()
        self._tasks: dict[str, Task] = {}
        self._slot = threading.BoundedSemaphore(max_slots)
        self._busy = 0
        self._recent_factors: list[float] = []

    # ---------------------------------------------------------------- journal

    def _journal_path(self, task_id: str) -> Path:
        return self._data_dir / f"{task_id}.json"

    def _write_journal(self, task: Task) -> None:
        try:
            self._data_dir.mkdir(parents=True, exist_ok=True)
            path = self._journal_path(task.task_id)
            # Write-then-rename: a torn journal file would deserialise as garbage and the
            # id would read as 404 — the one answer that is actively wrong after a crash.
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(task.to_journal()), encoding="utf8")
            os.replace(tmp, path)
        except OSError:
            # A journal we cannot write is a degraded restart, not a failed diarization.
            log.warning("could not journal task %s", task.task_id, exc_info=True)

    def load_journal(self) -> int:
        """Recover known ids after a restart, all as `lost`.

        Everything non-terminal at the time of the kill *was* killed — nothing survives a
        process exit — so recovering it as anything but `lost` would tell the engine to keep
        waiting for a task that no longer exists.
        """
        if not self._data_dir.exists():
            return 0
        recovered = 0
        now = time.time()
        for path in self._data_dir.glob("*.json"):
            try:
                raw = json.loads(path.read_text(encoding="utf8"))
            except (OSError, json.JSONDecodeError):
                log.warning("discarding unreadable journal entry %s", path)
                continue
            expires_at = float(raw.get("expires_at") or 0)
            if expires_at and expires_at < now:
                path.unlink(missing_ok=True)
                continue
            state: TaskState = raw.get("state", "lost")
            task = Task(
                task_id=raw["task_id"],
                idempotency_key=raw.get("idempotency_key", ""),
                state=state if state in ("succeeded", "failed", "cancelled") else "lost",
                accepted_at=float(raw.get("accepted_at") or now),
                started_at=raw.get("started_at"),
                finished_at=raw.get("finished_at"),
                expires_at=expires_at or now + self._ttl_s,
            )
            if task.state == "lost":
                task.error = TaskError(
                    code="internal",
                    message="the sidecar restarted while this task was running",
                    retryable=True,
                )
            self._tasks[task.task_id] = task
            recovered += 1
        return recovered

    # ---------------------------------------------------------------- lookup

    def get(self, task_id: str) -> Optional[Task]:
        with self._lock:
            self._evict_expired()
            return self._tasks.get(task_id)

    def slots(self) -> tuple[int, int]:
        with self._lock:
            return self._max_slots, self._busy

    def _evict_expired(self) -> None:
        now = time.time()
        for task_id, task in list(self._tasks.items()):
            if task.terminal and task.expires_at and task.expires_at < now:
                del self._tasks[task_id]
                self._journal_path(task_id).unlink(missing_ok=True)

    # ---------------------------------------------------------------- submit

    def submit(
        self,
        idempotency_key: str,
        run: Callable[[Task], DiarizeResult],
        *,
        retry_after_s: int = 60,
    ) -> tuple[Task, bool]:
        """Start a task, or return the existing one for this key.

        Returns `(task, created)`. `created` is False when the key was already known, which
        is what makes a re-POST a 200 rather than a 202.

        Raises `Busy` when a *different* key holds the slot.
        """
        task_id = task_id_for(idempotency_key)
        with self._lock:
            self._evict_expired()
            existing = self._tasks.get(task_id)
            if existing is not None and existing.state != "lost":
                # In flight or complete: hand back what we have. Never start a second run.
                return existing, False

            if not self._slot.acquire(blocking=False):
                raise Busy(retry_after_s)
            self._busy += 1

            task = Task(
                task_id=task_id,
                idempotency_key=idempotency_key,
                expires_at=time.time() + self._ttl_s,
            )
            self._tasks[task_id] = task
            self._write_journal(task)

        thread = threading.Thread(
            target=self._run, args=(task, run), name=f"diarize-{task_id[:8]}", daemon=True
        )
        thread.start()
        return task, True

    def _run(self, task: Task, run: Callable[[Task], DiarizeResult]) -> None:
        with self._lock:
            task.state = "running"
            task.started_at = time.time()
            self._write_journal(task)
        try:
            result = run(task)
        except Cancelled:
            self._finish(task, state="cancelled")
        except Exception as err:  # noqa: BLE001 — every failure must map to the taxonomy
            self._finish(task, state="failed", error=to_task_error(err))
        else:
            self._finish(task, state="succeeded", result=result)

    def _finish(
        self,
        task: Task,
        *,
        state: TaskState,
        result: Optional[DiarizeResult] = None,
        error: Optional[TaskError] = None,
    ) -> None:
        with self._lock:
            task.state = state
            task.result = result
            task.error = error
            task.finished_at = time.time()
            task.expires_at = task.finished_at + self._ttl_s
            if result is not None:
                # Keep a short rolling window so /health reports what this machine actually
                # does rather than a constant from somebody else's laptop.
                self._recent_factors.append(result.realtime_factor)
                del self._recent_factors[:-5]
            self._write_journal(task)
            self._busy -= 1
        self._slot.release()

    def measured_realtime_factor(self) -> Optional[float]:
        """Median of the last five successful runs, or None until there are any."""
        with self._lock:
            if not self._recent_factors:
                return None
            ordered = sorted(self._recent_factors)
            return ordered[len(ordered) // 2]

    # ---------------------------------------------------------------- cancel

    def cancel(self, task_id: str) -> Optional[Task]:
        """Cooperative cancel. Idempotent, and a no-op on an already-terminal task."""
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                return None
            if task.terminal:
                return task
            task.cancel.set()
            if task.state == "queued":
                # Never started, so no worker will observe the event.
                task.state = "cancelled"
                task.finished_at = time.time()
                self._write_journal(task)
            return task


class AudioError(Exception):
    """Something about the audio, with a taxonomy code attached."""

    def __init__(self, code: str, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def to_task_error(err: BaseException) -> TaskError:
    """Map any exception onto the failure taxonomy.

    The taxonomy is the contract: every failure the engine sees has a code with a
    documented retryability, so nothing arrives as an opaque 500 that the queue then has to
    guess about.
    """
    if isinstance(err, AudioError):
        return TaskError(code=err.code, message=str(err), retryable=err.retryable)  # type: ignore[arg-type]
    if isinstance(err, MemoryError):
        return TaskError(
            code="oom",
            message="out of memory; increase the sidecar's memory limit (16 GB handles a "
            "three-hour file) or use a hosted diarization source",
            retryable=False,
        )
    # torch raises a plain RuntimeError for CUDA OOM, and a SIGKILL 137 never gets here at
    # all — that one surfaces to the engine as `lost` after the container comes back.
    if isinstance(err, RuntimeError) and "out of memory" in str(err).lower():
        return TaskError(code="oom", message=str(err), retryable=False)
    log.exception("unhandled task failure")
    return TaskError(code="internal", message=str(err) or err.__class__.__name__, retryable=True)
