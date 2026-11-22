"""Bounded POSIX pipe transport for an already-approved external signer zipapp.

The caller pins package bytes and validates the response envelope/identity.
This helper provides neither a network/filesystem sandbox nor hardware support.
It never signs, broadcasts, parses an application response or returns stderr.
"""
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import tempfile
import time

MAX_PACKAGE_BYTES = 8 * 1024 * 1024
MAX_PAYLOAD_BYTES = 64 * 1024
MAX_STDOUT_BYTES = 128 * 1024
MAX_STDERR_BYTES = 8 * 1024
CHUNK_BYTES = 16 * 1024
CLEANUP_SECONDS = 2


class TransportError(RuntimeError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def _reject(condition, code, message):
    if not condition:
        raise TransportError(code, message)


def _close_stream(stream):
    if stream is not None:
        try:
            stream.close()
        except OSError:
            pass


def _stop_and_reap(process):
    """Terminate the created process group and reap our direct child.

    Descendants in that group are killed even if their parent has exited.
    This is not containment of descendants that deliberately create a new session.
    """
    group_error = False
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except OSError:
        group_error = True
    try:
        process.wait(timeout=CLEANUP_SECONDS)
    except subprocess.TimeoutExpired:
        try:
            process.kill()
        except ProcessLookupError:
            pass
        raise TransportError('CLEANUP_FAILED', 'external signer cleanup did not complete') from None
    finally:
        for stream in (process.stdin, process.stdout, process.stderr):
            _close_stream(stream)
    _reject(not group_error, 'CLEANUP_FAILED', 'external signer process group could not be terminated')


def _pump(process, payload, deadline):
    output = bytearray()
    sent = 0
    error_bytes = 0
    with selectors.DefaultSelector() as ready:
        for stream, label in ((process.stdout, 'stdout'), (process.stderr, 'stderr')):
            os.set_blocking(stream.fileno(), False)
            ready.register(stream, selectors.EVENT_READ, label)
        if payload:
            os.set_blocking(process.stdin.fileno(), False)
            ready.register(process.stdin, selectors.EVENT_WRITE, 'stdin')
        else:
            process.stdin.close()
        while ready.get_map() or process.poll() is None:
            remaining = deadline - time.monotonic()
            _reject(remaining > 0, 'TIMEOUT', 'external signer timed out')
            for event, _ in ready.select(min(remaining, 0.05)):
                stream, label = event.fileobj, event.data
                try:
                    if label == 'stdin':
                        count = os.write(stream.fileno(), memoryview(payload)[sent:sent + CHUNK_BYTES])
                        _reject(count > 0, 'INPUT_CLOSED', 'external signer closed request input')
                        sent += count
                        if sent == len(payload):
                            ready.unregister(stream)
                            stream.close()
                        continue
                    limit = MAX_STDOUT_BYTES if label == 'stdout' else MAX_STDERR_BYTES
                    total = len(output) if label == 'stdout' else error_bytes
                    block = os.read(stream.fileno(), min(CHUNK_BYTES, limit - total + 1))
                    if not block:
                        ready.unregister(stream)
                        stream.close()
                        continue
                    _reject(total + len(block) <= limit,
                            'STDOUT_LIMIT' if label == 'stdout' else 'STDERR_LIMIT',
                            'external signer exceeded ' + label + ' limit')
                    if label == 'stdout':
                        output.extend(block)
                    else:
                        error_bytes += len(block)  # Never retain or re-emit stderr.
                except (BlockingIOError, InterruptedError):
                    continue
                except BrokenPipeError:
                    raise TransportError('INPUT_CLOSED', 'external signer closed request input') from None
        _reject(sent == len(payload), 'INPUT_CLOSED', 'external signer did not receive the complete request')
        _reject(process.returncode == 0, 'CHILD_EXIT', 'external signer exited unsuccessfully')
        _reject(bool(output), 'EMPTY_RESPONSE', 'external signer returned an empty response')
    return bytes(output)


def exchange(package: bytes, payload: bytes, *, timeout_seconds: int = 15) -> bytes:
    """Execute pinned zipapp bytes through bounded POSIX stdin/stdout pipes.

    A complete response may contain arbitrary bytes: JSON framing, truncation,
    request pairing, replay protection and cryptographic checks belong to the
    caller. Timeout cleanup has an additional bounded two-second reap grace.
    """
    _reject(os.name == 'posix', 'UNSUPPORTED_OS', 'external signer pipe transport requires POSIX')
    _reject(type(package) is bytes and 0 < len(package) <= MAX_PACKAGE_BYTES,
            'PACKAGE_SIZE', 'external signer package exceeds bounds or has an invalid type')
    _reject(type(payload) is bytes and len(payload) <= MAX_PAYLOAD_BYTES,
            'PAYLOAD_SIZE', 'external signer request exceeds bounds or has an invalid type')
    _reject(type(timeout_seconds) is int and 1 <= timeout_seconds <= 120,
            'TIMEOUT_RANGE', 'external signer timeout must be an integer between 1 and 120')
    try:
        with tempfile.TemporaryDirectory(prefix='doge-external-signer-') as directory:
            root = Path(directory)
            path = root / 'adapter.pyz'
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                with os.fdopen(fd, 'wb', closefd=False) as handle:
                    handle.write(package)
            finally:
                os.close(fd)
            path.chmod(0o400)
            working = root / 'work'
            working.mkdir(mode=0o700)
            process = subprocess.Popen([sys.executable, '-I', '-S', str(path)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                cwd=working, env={'PATH':'/usr/bin:/bin', 'LANG':'C.UTF-8'},
                shell=False, close_fds=True, start_new_session=True)
            try:
                return _pump(process, payload, time.monotonic() + timeout_seconds)
            finally:
                _stop_and_reap(process)
    except TransportError:
        raise
    except (OSError, ValueError, subprocess.SubprocessError):
        raise TransportError('IO_FAILURE', 'external signer transport failed') from None
