#!/usr/bin/env python3
"""Increment a temporary, per-key counter once and emit one canvas record."""

import argparse
import hashlib
import os
import re
import secrets
import stat
import sys
import tempfile

if os.name == "nt":
    import msvcrt
else:
    import fcntl


MAX_COUNT = (1 << 64) - 1
MAX_IDENTITY_BYTES = 4096
STATE_PATTERN = re.compile(rb"(0|[1-9][0-9]{0,19})\n")
ERROR_MESSAGE = "Counter failed.\n"


class QuietParser(argparse.ArgumentParser):
    def error(self, message):
        # Argparse's default diagnostic can expose argument values.
        raise ValueError("Invalid arguments")


def parse_arguments():
    parser = QuietParser(
        prog="counter.py",
        allow_abbrev=False,
        description="Increment a per-key counter and emit text; starts at 1.",
        epilog="Automatic identity is session-scoped. Temporary-file cleanup resets the count.",
    )
    parser.add_argument(
        "--state-key",
        metavar="KEY",
        help="named counter instead of launch metadata; reuse shares temporary state (1–4096 bytes, nonblank, no controls)",
    )
    return parser.parse_args()


def identity_bytes(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Missing identity")
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise ValueError("Invalid identity")
    encoded = value.encode("utf-8")
    if len(encoded) > MAX_IDENTITY_BYTES:
        raise ValueError("Oversized identity")
    return encoded


def counter_digest(state_key, environment):
    if state_key is not None:
        parts = (b"manual-v1", identity_bytes(state_key))
    else:
        parts = (
            b"automatic-v1",
            identity_bytes(environment.get("ELGATO_DEVICE_ID")),
            identity_bytes(environment.get("ELGATO_ACTION_UUID")),
            identity_bytes(environment.get("ELGATO_ACTION_CONTEXT")),
        )
    digest = hashlib.sha256()
    for part in parts:
        # Length framing prevents ambiguous concatenated identities.
        digest.update(len(part).to_bytes(4, "big"))
        digest.update(part)
    return digest.hexdigest()


def inspect_state_file(path):
    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        return
    if not stat.S_ISREG(metadata.st_mode) or (
        os.name == "nt"
        and metadata.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT
    ):
        raise ValueError("Unsafe storage")


def open_state_directory():
    if os.name == "nt":
        return open_windows_state_directory()
    path = os.path.join(
        tempfile.gettempdir(), "stream-canvas-counter-" + str(os.getuid())
    )
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(descriptor)
        if metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
            raise ValueError("Unsafe storage")
        # Pin later relative accesses even if the original pathname is replaced.
        os.fchdir(descriptor)
    finally:
        os.close(descriptor)
    return "."


def open_windows_state_directory():
    # Python 3.13+ applies a private current-user/administrators ACL for 0700.
    if sys.version_info < (3, 13):
        raise ValueError("Unsupported Python")
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    if re.match(r"^[A-Za-z]:[\\/]", local_app_data) is None:
        raise ValueError("Invalid storage root")
    path = os.path.join(local_app_data, "Temp", "stream-canvas-counter")
    # The normal private user-profile parents are trusted, not ACL-inspected.
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    metadata = os.lstat(path)
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT
    ):
        raise ValueError("Unsafe storage")
    os.chdir(path)
    return "."


def read_count(directory, state_name):
    path = os.path.join(directory, state_name)
    inspect_state_file(path)
    try:
        with open(path, "rb") as source:
            # A valid state is at most 20 decimal digits plus LF.
            payload = source.read(22)
    except FileNotFoundError:
        return 0
    if STATE_PATTERN.fullmatch(payload) is None:
        raise ValueError("Invalid state")
    count = int(payload)
    if count >= MAX_COUNT:
        raise ValueError("Counter exhausted")
    return count


def save_count(directory, state_name, count):
    temporary = os.path.join(directory, state_name + "." + secrets.token_hex(16) + ".tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if os.name == "nt":
        flags |= os.O_BINARY
    descriptor = os.open(temporary, flags, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as destination:
            destination.write((str(count) + "\n").encode("ascii"))
        state_path = os.path.join(directory, state_name)
        inspect_state_file(state_path)
        os.replace(temporary, state_path)
    finally:
        # Remove only this invocation's uncommitted staging file.
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def increment_and_emit(directory, digest):
    lock_path = os.path.join(directory, digest + ".lock")
    inspect_state_file(lock_path)
    flags = os.O_RDWR | os.O_CREAT
    if os.name == "nt":
        flags |= os.O_BINARY
    else:
        flags |= os.O_NOFOLLOW | os.O_NONBLOCK
    descriptor = os.open(lock_path, flags, 0o600)
    with os.fdopen(descriptor, "rb") as lock:
        # Keep the stable lock file separate from atomically replaced state.
        if os.name == "nt":
            os.lseek(lock.fileno(), 0, os.SEEK_SET)
            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        else:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            state_name = digest + ".state"
            count = read_count(directory, state_name) + 1
            save_count(directory, state_name, count)
            record = (
                "text:" + str(count)
                + "|font:mono;weight:bold;font-size:auto"
                ";background:#090D18"
                ";border:3\n"
            )
            sys.stdout.buffer.write(record.encode("utf-8"))
            sys.stdout.buffer.flush()
        finally:
            if os.name == "nt":
                os.lseek(lock.fileno(), 0, os.SEEK_SET)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


def main():
    arguments = parse_arguments()
    digest = counter_digest(arguments.state_key, os.environ)
    directory = open_state_directory()
    increment_and_emit(directory, digest)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, UnicodeError):
        # Exit directly to avoid a second stdout-flush traceback on broken pipes.
        try:
            sys.stderr.buffer.write(ERROR_MESSAGE.encode("utf-8"))
            sys.stderr.buffer.flush()
        finally:
            os._exit(1)
