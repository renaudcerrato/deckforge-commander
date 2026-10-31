#!/usr/bin/env python3
"""An approximately 28-second neon story using only Python's standard library.

Countdown, fictional dashboard/EQ, split-flap-inspired text, typing/build, transfer,
orbit, bloom, then hard lines.
All data and images are synthetic, not live measurements.
Run once by default; use --loop to repeat the same authored pacing.
See --help for usage and README.md for the stdout protocol.
"""

import argparse
import base64
from itertools import count
import math
import struct
import sys
import time
import zlib


CANVAS_SIZE = 144
BG = "#090D18"
CYAN = "#22D3EE"
VIOLET = "#A78BFA"
WARM = "#FFB454"
LIGHT = "#F4F7FF"
TRACK = "#273146"
FRAME_COUNT = 301
TYPEWRITER_TEXT = 'Your code.\nLive output.\nOne key.\nText. Images.\nTake control.'


class DemoArgumentParser(argparse.ArgumentParser):
    """Keep argument values out of errors."""

    def error(self, message):
        self.exit(2, "Invalid demo options; use --help for usage.\n")


def parse_arguments():
    parser = DemoArgumentParser(
        prog="showcase.py",
        description="An approximately 28-second neon showcase with synthetic EQ, split-flap-inspired text, and continuous motion.",
        epilog="Writes DeckForge Commander records to stdout; Ctrl-C stops playback. No pacing options.",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--once", action="store_true", help="one cycle (default)")
    mode.add_argument("--loop", action="store_true", help="repeat cycles until stopped")
    return parser.parse_args()


def escape_value(value, hard_breaks=False):
    """Escape delimiters; encode actual LF only for explicit text main content."""
    escaped = str(value).replace("\\", "\\\\").replace(";", "\\;").replace("|", "\\|")
    return escaped.replace("\n", "\\n") if hard_breaks else escaped


def option_value(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    return escape_value(value)


def command_record(kind, value, options=None):
    record = f"{kind}:{escape_value(value, hard_breaks=kind == 'text')}"
    if options:
        suffix = ";".join(f"{key}:{option_value(item)}" for key, item in options.items())
        record += "|" + suffix
    return record


def motion_border(step):
    """Twelve cycle-continuous native border breaths, with fixed text insets."""
    # Offset symmetric samples so completed text never repeats the same border.
    return round(4 - 2 * math.cos(2 * math.pi * 12 * (step + 0.25) / FRAME_COUNT), 3)


def ease(t):
    return t * t * (3 - 2 * t)


def hero_record(value, accent=CYAN, size=40, motion=0, **options):
    return command_record("text", value, {
        "background": BG, "color": accent, "font-size": size, "weight": "bold",
        "padding": 17, "border": motion_border(motion), "border-color": VIOLET,
        **options,
    })


def ignition_frames(phase):
    """A short countdown zoom leads directly into a readable hard-line beat."""
    for value in ("3", "2", "1", "GO"):
        for step in range(6):
            options = {"valign": ("top", "center", "bottom")[step // 2]} if value == "GO" else {}
            yield hero_record(value, WARM if value == "GO" else CYAN, 34 + step,
                              motion=next(phase), **options), 0.10
    for step in range(6):
        yield hero_record("MAKE\nIT", LIGHT, 32, motion=next(phase),
                          **{"line-height": 1.1}), 0.08


def equalizer_svg_frame(index):
    """Synthetic nine-bar EQ: authored attacks followed by three slower decay states."""
    peaks = (
        (72, 48, 80, 36, 64, 28, 56, 44, 68),
        (32, 76, 44, 80, 40, 68, 24, 72, 52),
        (64, 28, 56, 44, 76, 36, 80, 48, 24),
        (48, 64, 32, 72, 52, 80, 40, 60, 76),
    )
    decay = (1, 0.82, 0.62, 0.44)[index % 4]
    bars, markers = [], []
    for bar, peak in enumerate(peaks[index // 4]):
        height = 6 + (peak - 6) * decay
        x, top = 19 + 12 * bar, 105 - height
        color = CYAN if bar % 2 == 0 else VIOLET
        bars.append(f'<rect x="{x}" y="{top:.2f}" width="8" height="{height:.2f}" rx="2" fill="{color}"/>')
        markers.append(f'<rect x="{x}" y="{top:.2f}" width="8" height="2" fill="{LIGHT}" opacity="0.55"/>')
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">'
        f'<rect width="144" height="144" fill="{BG}"/>'
        f'<g id="equalizer-bars">{"".join(bars)}</g>'
        f'<g id="equalizer-peaks">{"".join(markers)}</g>'
        f'<text x="72" y="125" text-anchor="middle" font-family="sans-serif" font-size="14" fill="{LIGHT}">SVG SUPPORT</text>'
        '</svg>'
    )


def dashboard_frames(phase):
    """Fictional metric plateaus keep moving through contrasting native borders."""
    for step in range(17):
        value = round(96 + 32 * min(step, 13) / 13)
        record = hero_record(value, CYAN, 42, motion=next(phase), label="Unread", **{
            "label-color": LIGHT, "border-color": VIOLET,
        })
        yield record, 0.1
    for step in range(13):
        record = hero_record(135 + min(step, 9), VIOLET, 42, motion=next(phase), label="FPS", **{
            "label-position": "above", "label-size": 16, "label-color": LIGHT,
            "border-color": CYAN,
        })
        yield record, 0.1
    for step in range(13):
        next(phase)  # The synthetic EQ is an opaque image, not a live audio measurement.
        yield equalizer_svg_frame(step), 0.1


def split_flap_frames(phase):
    """Fixed uppercase text cells resolve row by row; no native hinged-glyph feature."""
    for step in range(18):
        rows = []
        for row, target in enumerate(("DREAM", "BUILD", "LAUNCH")):
            if step >= 5 * (row + 1):
                rows.append(target)
            else:
                rows.append(''.join(
                    chr(65 + (ord(letter) - 65 + 1 + (step * 3 + cell * 5 + row * 7) % 25) % 26)
                    for cell, letter in enumerate(target)
                ))
        yield hero_record('\n'.join(rows), LIGHT, 24, motion=next(phase), **{
            "font": "mono", "align": "center", "valign": "center", "line-height": 1.2,
            "border-color": CYAN,
        }), 0.1


def typewriter_frames(phase):
    """Reveal stable hard lines with weighted punctuation beats, never scrolling."""
    options = {
        "background": BG, "color": LIGHT, "font-size": 16, "weight": "normal",
        "align": "left", "valign": "top", "overflow": "wrap", "padding": 17,
        "line-height": 1.2, "border-color": WARM,
    }
    unit_dwell = 3.6 / sum(2 if character in '.,' else 1 for character in TYPEWRITER_TEXT)
    for length in range(1, len(TYPEWRITER_TEXT) + 1):
        record = command_record("text", TYPEWRITER_TEXT[:length], {
            **options, "border": motion_border(next(phase)),
        })
        yield record, unit_dwell * (2 if TYPEWRITER_TEXT[length - 1] in '.,' else 1)
    for step in range(9):
        yield command_record("text", TYPEWRITER_TEXT, {
            **options, "border": motion_border(next(phase)),
        }), 0.06


def build_record(completed, label, growth):
    return command_record("progress", f"{completed}/64", {
        "background": BG, "color": VIOLET, "track-color": TRACK,
        "type": "ring", "scale": round(82 + 18 * growth, 3),
        "thickness": round(4 + 4 * growth, 3), "border": round(1 + 2 * growth, 3),
        "border-color": CYAN, "label": label,
        "value-size": 20, "label-size": 16, "label-color": "accent",
        "value-color": LIGHT,
    })


def build_frames(phase):
    """The typed console hands off to a shorter ring build without a transition pause."""
    yield from typewriter_frames(phase)
    next(phase)  # Ring records advance the common phase without overriding coupled geometry.
    yield build_record(0, "Prep", 0), 0.1
    for step in range(25):
        next(phase)
        yield build_record(round(64 * step / 24), "Build", ease(step / 24)), 0.08
    for growth in (1, 0.92, 0.84, 0.92):
        next(phase)
        yield build_record(64, "Done", growth), 0.09


def transfer_record(completed, motion):
    return command_record("progress", f"{completed}/512", {
        "background": BG, "color": CYAN, "track-color": TRACK,
        "type": "bar", "scale": 100, "thickness": 12,
        "display": f"{completed} MB", "value-position": "above", "value-size": 20,
        "label": "Sent" if completed == 512 else "Send", "label-size": 16,
        "label-position": "below", "value-color": LIGHT, "label-color": "accent",
        "border": motion_border(motion), "border-color": VIOLET,
    })


def transfer_frames(phase):
    """An accelerating transfer keeps its native frame moving through completion."""
    for step in range(35):
        yield transfer_record(round(512 * (min(step, 30) / 30) ** 1.6), next(phase)), 0.08


def orbital_point(phase):
    return 72 + 44 * math.cos(phase), 64 + 24 * math.sin(phase)


def wormhole_point(depth, angle, phase):
    """Project depth onto a gently twisting tunnel around a fixed vanishing point."""
    radius = 6 + 84 * depth * depth
    twist = 0.24 * math.sin(phase) + 0.6 * depth
    x, y = radius * math.cos(angle), 0.72 * radius * math.sin(angle)
    return (72 + x * math.cos(twist) - y * math.sin(twist),
            60 + x * math.sin(twist) + y * math.cos(twist))


def wormhole_fade(depth):
    """Fade both ends of the depth wrap instead of popping rings or particles."""
    return max(0, min(1, depth * 8, (1 - depth) * 5))


def wormhole_rings(phase):
    rings = []
    for layer in range(7):
        depth = (phase / (2 * math.pi) + layer / 7) % 1
        radius = 6 + 84 * depth * depth
        rotation = math.degrees(0.24 * math.sin(phase) + 0.6 * depth)
        color = CYAN if layer % 2 == 0 else VIOLET
        ellipse = (f'<ellipse cx="72" cy="60" rx="{radius:.3f}" ry="{0.72 * radius:.3f}" '
                   f'transform="rotate({rotation:.3f} 72 60)" fill="none" stroke="{color}"')
        rings.append(
            f'<g opacity="{wormhole_fade(depth):.3f}">'
            f'{ellipse} stroke-width="{8 + 4 * depth:.3f}" opacity="0.08"/>'
            f'{ellipse} stroke-width="{3 + 2 * depth:.3f}" opacity="0.28"/>'
            f'{ellipse} stroke-width="{0.9 + 1.5 * depth:.3f}" opacity="0.95"/></g>'
        )
    return '<g id="wormhole-rings">' + ''.join(rings) + '</g>'


def wormhole_spokes(phase):
    spokes = []
    for spoke in range(8):
        points = []
        for sample in range(13):
            depth = sample / 12
            angle = spoke * math.pi / 4 + 0.3 * depth + 0.12 * math.sin(phase + depth * 3)
            points.append(wormhole_point(depth, angle, phase))
        path = f'M{points[0][0]:.3f},{points[0][1]:.3f}'
        for control, following in zip(points[1:-1], points[2:]):
            path += (f' Q{control[0]:.3f},{control[1]:.3f}'
                     f' {(control[0] + following[0]) / 2:.3f},{(control[1] + following[1]) / 2:.3f}')
        path += f' L{points[-1][0]:.3f},{points[-1][1]:.3f}'
        color = VIOLET if spoke % 2 else CYAN
        spokes.append(
            f'<path d="{path}" fill="none" stroke="{color}" stroke-width="4" opacity="0.12"/>'
            f'<path d="{path}" fill="none" stroke="{color}" stroke-width="0.8" opacity="0.55"/>'
        )
    return '<g id="wormhole-spokes">' + ''.join(spokes) + '</g>'


def wormhole_particles(phase):
    particles = []
    for particle in range(12):
        depth = (phase / (2 * math.pi) + particle / 12) % 1
        angle = particle * math.pi / 6 + 0.18 * math.sin(phase)
        x, y = wormhole_point(depth, angle, phase)
        tail_x, tail_y = wormhole_point(max(0, depth - 0.09), angle, phase)
        radius = 0.8 + 1.5 * depth
        color = WARM if particle % 5 == 0 else CYAN
        particles.append(
            f'<g opacity="{wormhole_fade(depth):.3f}">'
            f'<circle cx="{x:.3f}" cy="{y:.3f}" r="{radius * 3:.3f}" fill="{color}" opacity="0.12"/>'
            f'<path d="M{tail_x:.3f},{tail_y:.3f} L{x:.3f},{y:.3f}" stroke="{color}" stroke-width="{radius:.3f}" stroke-linecap="round" opacity="0.7"/>'
            f'<circle cx="{x:.3f}" cy="{y:.3f}" r="{radius:.3f}" fill="{color}"/></g>'
        )
    return '<g id="wormhole-particles">' + ''.join(particles) + '</g>'


def svg_record(phase):
    """Emit a self-contained neon wormhole state; glow is authored, not animated SVG."""
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">'
        '<defs><clipPath id="wormhole-clip"><rect width="144" height="144"/></clipPath>'
        '<radialGradient id="wormhole-haze">'
        f'<stop stop-color="{BG}"/><stop offset="0.55" stop-color="{VIOLET}" stop-opacity="0.18"/>'
        f'<stop offset="1" stop-color="{BG}" stop-opacity="0"/>'
        '</radialGradient></defs>'
        f'<rect width="144" height="144" fill="{BG}"/>'
        '<g clip-path="url(#wormhole-clip)">'
        '<ellipse cx="72" cy="60" rx="78" ry="57" fill="url(#wormhole-haze)"/>'
        f'{wormhole_spokes(phase)}{wormhole_rings(phase)}{wormhole_particles(phase)}'
        f'<circle cx="72" cy="60" r="4" fill="{BG}" stroke="{CYAN}" stroke-width="0.7" opacity="0.8"/>'
        '</g>'
        f'<rect x="8" y="8" width="128" height="128" rx="16" fill="none" stroke="{TRACK}" stroke-width="3"/>'
        '</svg>'
    )


def orbit_frames(phase):
    """Forty emitted SVG states maintain motion through the scene boundary."""
    for step in range(40):
        next(phase)  # Opaque producer images advance the phase but are never restyled.
        yield svg_record(2 * math.pi * step / 40), 0.09


def png_chunk(kind, payload):
    checksum = zlib.crc32(kind + payload) & 0xFFFFFFFF
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", checksum)


def png_record(phase):
    """Generate one bounded RGB bloom, continuing the synthetic orbit's motion."""
    point = orbital_point(phase)
    opposite = orbital_point(phase + math.pi)
    radius = 38 + 4 * math.sin(phase)
    grid_offset = round(6 * math.sin(phase))
    rows = bytearray()
    for y in range(CANVAS_SIZE):
        rows.append(0)  # PNG filter type: none.
        for x in range(CANVAS_SIZE):
            rows.extend(glow_pixel(x, y, point, opposite, radius, grid_offset))
    header = struct.pack(">IIBBBBB", CANVAS_SIZE, CANVAS_SIZE, 8, 2, 0, 0, 0)
    image = (
        b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", header)
        + png_chunk(b"IDAT", zlib.compress(bytes(rows))) + png_chunk(b"IEND", b"")
    )
    return "data:image/png;base64," + base64.b64encode(image).decode("ascii")


def glow_pixel(x, y, point, opposite, radius, grid_offset):
    cyan_glow = math.exp(-((x - point[0]) ** 2 + (y - point[1]) ** 2) / 650)
    violet_glow = math.exp(-((x - opposite[0]) ** 2 + (y - opposite[1]) ** 2) / 900)
    distance = math.hypot(x - 72, y - 64)
    orbit = max(0, 1 - abs(distance - radius) / 2)
    grid = 0.08 if (x + grid_offset) % 18 == 0 or (y - grid_offset) % 18 == 0 else 0
    # Synthetic color contributions are clamped to keep every RGB channel byte-sized.
    background = (9, 13, 24)
    cyan = (34, 211, 238)
    violet = (167, 139, 250)
    warm = (255, 180, 84)
    return tuple(
        max(0, min(255, round(
            background[channel] + 0.55 * cyan_glow * (cyan[channel] - background[channel])
            + 0.45 * violet_glow * (violet[channel] - background[channel])
            + orbit * (warm[channel] - background[channel]) + grid * 100
        )))
        for channel in range(3)
    )


def bloom_frames(phase):
    """Eighteen raster states continue the orbit as a moving glow/grid, without a freeze."""
    for step in range(18):
        next(phase)
        orbit_phase = 2 * math.pi * (39 / 40 + step / 30)
        yield png_record(orbit_phase), 0.12


def your_move_frames(phase):
    """Hard and blank lines stand apart from the wrapped console, with no captions."""
    options = {"line-height": 1.1, "border-color": VIOLET}
    for value, accent, size in (
        ("WRITE\n\nRUN", LIGHT, 28),
        ("WRITE\nRUN\nREPEAT", WARM, 24),
        ("YOUR\nMOVE", CYAN, 32),
    ):
        for step in range(6):
            fitted_size = round(24 + 8 * ease(step / 5), 3) if value == "YOUR\nMOVE" else size
            yield hero_record(value, accent, fitted_size, motion=next(phase), **options), 0.1


def showcase_frames():
    """Yield (single physical record, positive dwell seconds): 301 frames, 25.94 seconds nominal.

    Scenes generate lazily, retaining no image history. Each record is self-contained;
    the shared palette is authored here rather than inherited by the plugin.
    """
    phase = count()
    yield from ignition_frames(phase)
    yield from dashboard_frames(phase)
    yield from split_flap_frames(phase)
    yield from build_frames(phase)
    yield from transfer_frames(phase)
    yield from orbit_frames(phase)
    yield from bloom_frames(phase)
    yield from your_move_frames(phase)


def run_showcase(arguments):
    frames = iter(showcase_frames())
    current = next(frames, None)
    while current is not None:
        record, dwell = current
        print(record, flush=True)
        started = time.monotonic()
        # Prepare just one next record while this frame is visible. Slow preparation
        # may overrun its dwell; never skip frames or catch up in a burst.
        following = next(frames, None)
        if following is None and arguments.loop:
            frames = iter(showcase_frames())
            following = next(frames, None)
        remaining = dwell - (time.monotonic() - started)
        if remaining > 0:
            time.sleep(remaining)
        current = following
    return 0


def main():
    arguments = parse_arguments()
    try:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8", errors="strict", newline="\n")
        return run_showcase(arguments)
    except KeyboardInterrupt:
        return 130
    except BrokenPipeError:
        # Prevent a second failed flush during interpreter shutdown; no file sink.
        try:
            sys.stdout.close()
        except BrokenPipeError:
            pass
        sys.stdout = None
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
