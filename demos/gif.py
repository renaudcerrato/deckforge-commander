#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10,<3.15"
# dependencies = ["Pillow==12.3.0"]
# ///
"""Play a local GIF as flushed PNG records for DeckForge Commander.

Loops by default; uses sample.gif beside this script when no path is supplied.
Launch with Python 3.6+ and uv; uv manages Python 3.10–3.14 and Pillow 12.3.0.
"""

import argparse
import base64
import io
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import warnings


CANVAS_SIZE = (144, 144)
MAX_RECORD_BYTES = 262144
REENTRY_MARKER = "_DECKFORGE_GIF_UV_REENTRY"


class GifArgumentParser(argparse.ArgumentParser):
    """Reserve stdout for records and keep supplied values out of errors."""

    def print_help(self, file=None):
        super().print_help(file=sys.stderr if file is None else file)

    def error(self, message):
        self.exit(2, "Invalid GIF options; use --help for usage.\n")


def parse_arguments():
    parser = GifArgumentParser(
        prog="gif.py",
        allow_abbrev=False,
        description="Play a GIF as 144 × 144 PNG records; launch with Python 3.6+ and uv.",
        epilog="uv manages Python 3.10–3.14 and Pillow 12.3.0. Writes image records to stdout. Ctrl-C stops playback; --help uses stderr.",
    )
    parser.add_argument("gif", nargs="?", type=Path,
                        default=Path(__file__).resolve().with_name("sample.gif"),
                        help="local GIF (default: sample.gif beside this script)")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--loop", dest="loop", action="store_true",
                      help="repeat until stopped (default)")
    mode.add_argument("--once", dest="loop", action="store_false",
                      help="play one cycle, including the last frame's delay")
    parser.set_defaults(loop=True)
    parser.add_argument("--uv", type=Path, metavar="ABSOLUTE_PATH",
                        help="uv executable (default: PATH, then standard Homebrew locations)")
    arguments = parser.parse_args()
    if arguments.uv is not None and not arguments.uv.is_absolute():
        parser.error("uv must be absolute")
    return arguments


def uv_unavailable():
    sys.stderr.write("GIF: uv missing or unlaunchable.\n")
    if "ELGATO_PLUGIN_UUID" in os.environ:
        print("text:uv missing", flush=True)
        time.sleep(5)
    return 1


def bootstrap(arguments):
    uv = str(arguments.uv) if arguments.uv is not None else shutil.which("uv")
    if arguments.uv is None and uv is None:
        for candidate in ("/opt/homebrew/bin/uv", "/usr/local/bin/uv"):
            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                uv = candidate
                break
    if uv is None:
        return uv_unavailable()
    environment = os.environ.copy()
    environment[REENTRY_MARKER] = "1"
    command = [
        uv, "run", "--quiet", "--no-project", "--no-config",
        "--script", str(Path(__file__).resolve()), *sys.argv[1:],
    ]
    try:
        # Keep uv and its interpreter in the caller's process group / Windows Job.
        return subprocess.call(command, env=environment)
    except OSError:
        return uv_unavailable()


def png_record(frame, image_module, image_ops):
    rgba = image_ops.fit(frame.convert("RGBA"), CANVAS_SIZE,
                         method=image_module.Resampling.LANCZOS)
    flattened = image_module.new("RGB", CANVAS_SIZE, "black")
    flattened.paste(rgba, mask=rgba.getchannel("A"))
    with io.BytesIO() as buffer:
        flattened.save(buffer, format="PNG")
        record = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
    if len(record) > MAX_RECORD_BYTES:  # The entire record is ASCII.
        raise ValueError("record too large")
    return record


def gif_frames(image, loop, image_module, image_ops, image_sequence):
    while True:
        image.seek(0)
        for frame in image_sequence.Iterator(image):
            duration = frame.info.get("duration", 0)
            delay = duration / 1000 if duration > 0 else 0.1
            yield png_record(frame, image_module, image_ops), delay
        if not loop:
            return


def play_frames(frames):
    current = next(frames, None)
    while current is not None:
        record, delay = current
        print(record, flush=True)
        started = time.monotonic()
        # Decode only the next frame. Overruns stretch playback, never catch up.
        following = next(frames, None)
        remaining = delay - (time.monotonic() - started)
        if remaining > 0:
            time.sleep(remaining)
        current = following
    return 0


def play_gif(arguments):
    try:
        from PIL import Image, ImageOps, ImageSequence
    except ImportError:
        sys.stderr.write("GIF: Pillow unavailable.\n")
        return 1
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(arguments.gif) as image:
                if image.format != "GIF":
                    raise ValueError("not a GIF")
                return play_frames(gif_frames(image, arguments.loop, Image, ImageOps, ImageSequence))
    except BrokenPipeError:
        raise
    except (OSError, ValueError, EOFError, SyntaxError,
            Image.DecompressionBombError, Image.DecompressionBombWarning):
        sys.stderr.write("GIF: invalid or unreadable GIF.\n")
        return 1


def main():
    try:
        arguments = parse_arguments()
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8", errors="strict", newline="\n")
        if sys.version_info[:2] < (3, 6):
            sys.stderr.write("GIF: Python 3.6+ required to launch.\n")
            return 1
        if not arguments.gif.is_file():
            sys.stderr.write("GIF: GIF missing or unreadable.\n")
            return 1
        if os.environ.pop(REENTRY_MARKER, None) != "1":
            return bootstrap(arguments)
        if not (3, 10) <= sys.version_info[:2] < (3, 15):
            sys.stderr.write("GIF: Python 3.10–3.14 required for playback.\n")
            return 1
        return play_gif(arguments)
    except KeyboardInterrupt:
        return 130
    except BrokenPipeError:
        try:
            sys.stdout.close()
        except BrokenPipeError:
            pass
        sys.stdout = None
        return 0
    except OSError:
        sys.stderr.write("GIF: playback failed.\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
