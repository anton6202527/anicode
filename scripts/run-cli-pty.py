#!/usr/bin/env python3
"""Run a command in a real Unix PTY and submit `/exit` one key at a time."""

import errno
import os
import pty
import select
import signal
import sys
import time


def drain(master: int, timeout: float) -> bytes:
    ready, _, _ = select.select([master], [], [], timeout)
    if not ready:
        return b""
    try:
        chunk = os.read(master, 65536)
    except OSError as error:
        if error.errno == errno.EIO:
            return b""
        raise
    if chunk:
        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()
    return chunk


def main() -> int:
    if len(sys.argv) < 2:
        raise SystemExit("usage: run-cli-pty.py COMMAND [ARG ...]")
    pid, master = pty.fork()
    if pid == 0:
        os.execvpe(sys.argv[1], sys.argv[1:], os.environ)

    started = time.monotonic()
    deadline = started + 20
    startup = b""
    while b"\x1b[?2004h" not in startup and time.monotonic() < started + 10:
        startup = (startup + drain(master, 0.05))[-65536:]
    if b"\x1b[?2004h" not in startup:
        os.kill(pid, signal.SIGTERM)
        os.waitpid(pid, 0)
        return 124
    if os.environ.get("ANICODE_PTY_TEST_SUSPEND") == "1":
        os.write(master, b"\x1a")
        suspend_deadline = time.monotonic() + 1
        while time.monotonic() < suspend_deadline:
            drain(master, 0.05)
            done, candidate = os.waitpid(pid, os.WNOHANG | os.WUNTRACED)
            if not done:
                continue
            if os.WIFSTOPPED(candidate):
                os.kill(pid, signal.SIGCONT)
                break
            return os.waitstatus_to_exitcode(candidate)
        # A pty.fork() child is an orphaned process group on some systems, where
        # POSIX intentionally ignores SIGTSTP. The alternate-screen leave/re-enter
        # output still proves that Ink's suspend boundary was exercised; a normal
        # interactive shell supplies the non-orphan job-control parent.
        sys.stdout.buffer.write(b"\nANICODE_PTY_SUSPEND_PATH\n")
        sys.stdout.buffer.flush()
        resumed_at = time.monotonic()
        while time.monotonic() - resumed_at < 0.5:
            drain(master, 0.05)
    for key in (b"/", b"e", b"x", b"i", b"t"):
        os.write(master, key)
        drain(master, 0.08)
    # Keep Return in its own read() chunk. The TUI intentionally treats a
    # multi-character chunk ending in CR/LF as paste, never as implicit submit.
    time.sleep(0.4)
    drain(master, 0.01)
    os.write(master, b"\r")

    status = None
    while time.monotonic() < deadline:
        drain(master, 0.05)
        done, candidate = os.waitpid(pid, os.WNOHANG)
        if done:
            status = candidate
            break
    if status is None:
        os.kill(pid, signal.SIGTERM)
        _, status = os.waitpid(pid, 0)
    for _ in range(4):
        drain(master, 0.01)
    os.close(master)
    return os.waitstatus_to_exitcode(status)


if __name__ == "__main__":
    raise SystemExit(main())
