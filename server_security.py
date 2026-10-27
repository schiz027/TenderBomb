"""Small server-side controls shared by request handling and process startup."""

from collections import deque
from contextlib import contextmanager
import os
from pathlib import Path
import threading
import time


class RequestRejected(Exception):
    def __init__(self, status, error):
        super().__init__(error)
        self.status = status
        self.error = error


class RecordStoreBusy(RuntimeError):
    pass


class RequestLimiter:
    def __init__(self):
        self.lock = threading.Lock()
        self.events = {}

    def clear(self):
        with self.lock:
            self.events.clear()

    def allow(self, owner, scope="api"):
        current = time.monotonic()
        window, limit = (2, 12) if scope == "casino" else (2, 120)
        with self.lock:
            if len(self.events) >= 2048:
                self.events = {key: queue for key, queue in self.events.items() if queue and current - queue[-1] < 10}
                if len(self.events) >= 2048 and (owner, scope) not in self.events:
                    return False
            queue = self.events.setdefault((owner, scope), deque())
            while queue and current - queue[0] >= window:
                queue.popleft()
            if len(queue) >= limit:
                return False
            queue.append(current)
            return True


@contextmanager
def record_store_lock(records_path):
    lock_path = Path(records_path).with_name(Path(records_path).name + ".lock")
    handle = lock_path.open("a+b")
    acquired = False
    try:
        if lock_path.stat().st_size == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            acquired = True
        except OSError as exc:
            raise RecordStoreBusy("The record store is already in use by another server.") from exc
        yield
    finally:
        if acquired:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()
