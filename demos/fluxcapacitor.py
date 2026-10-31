#!/usr/bin/env python3
"""Original, synthetic vector tribute to a film-inspired flux capacitor prop.

Usage: ./demos/fluxcapacitor.py [--loop | --once]
Loops by default; --once emits one three-second cycle at 12 FPS.
Writes flushed, single-line UTF-8 SVG records to stdout for DeckForge Commander;
stdin is unused. No movie assets, live data, files, or network access are used.
"""

import argparse
import math
import sys
import time


FPS = 12
FRAME_COUNT = 36


class FluxArgumentParser(argparse.ArgumentParser):
    """Keep supplied argument values out of diagnostics."""

    def error(self, message):
        self.exit(2, "Invalid flux capacitor options; use --help for usage.\n")


def parse_arguments(argv=None):
    parser = FluxArgumentParser(
        prog="fluxcapacitor.py",
        allow_abbrev=False,
        description="Synthetic flux capacitor: 36 SVG frames, 12 FPS, three seconds per cycle.",
        epilog="Writes DeckForge Commander records to stdout; stdin is unused. Ctrl-C stops playback.",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--loop", dest="loop", action="store_true",
                      help="repeat cycles until stopped (default)")
    mode.add_argument("--once", dest="loop", action="store_false",
                      help="emit one three-second cycle")
    parser.set_defaults(loop=True)
    return parser.parse_args(argv)


def enclosure_svg():
    """Beveled industrial enclosure with raised hardware and contrasting cables."""
    screws = "".join(
        f'<circle cx="{x}" cy="{y + 1}" r="5.5" fill="#050708"/>'
        f'<circle cx="{x}" cy="{y}" r="4.8" fill="url(#metal)" stroke="#93968b" stroke-width="0.7"/>'
        f'<circle cx="{x}" cy="{y}" r="3.2" fill="#72786f"/>'
        f'<path d="M{x - 2} {y + 2}l4 -4" stroke="#171c1b" stroke-width="1.5"/>'
        for x, y in ((17, 17), (127, 17), (17, 127), (127, 127))
    )
    ribs = "".join(
        f'<path d="M{x} 56v38" stroke="#030607" stroke-width="3"/>'
        f'<path d="M{x + 1} 56v38" stroke="#454c47" stroke-width="0.8"/>'
        for x in (20, 25, 119, 124)
    )
    return (
        '<rect width="144" height="144" fill="#07090a"/>'
        '<rect x="5" y="5" width="134" height="134" rx="12" fill="url(#metal)" stroke="#84877c" stroke-width="1.5"/>'
        '<path d="M12 130V18Q12 12 18 12H126" fill="none" stroke="#b0afa0" stroke-width="1" opacity="0.65"/>'
        '<path d="M132 14V126Q132 132 126 132H14" fill="none" stroke="#090e10" stroke-width="3"/>'
        '<rect x="27" y="22" width="90" height="106" rx="10" fill="#050808" stroke="#73786a" stroke-width="1.5"/>'
        '<rect x="30" y="25" width="84" height="100" rx="8" fill="url(#recess)" stroke="#010303" stroke-width="3"/>'
        '<path d="M34 121V34Q34 29 39 29H106" fill="none" stroke="#39453d" stroke-width="1"/>'
        '<path d="M37 43C17 38 22 106 43 100L58 96M107 43C128 38 122 106 102 100L87 96" fill="none" stroke="#030505" stroke-width="7"/>'
        '<path d="M37 43C17 38 22 106 43 100L58 96" fill="none" stroke="#a8542c" stroke-width="3.5"/>'
        '<path d="M107 43C128 38 122 106 102 100L87 96" fill="none" stroke="#547d7a" stroke-width="3.5"/>'
        '<path d="M36 43C19 41 25 101 42 99M108 43C125 41 120 101 103 99" fill="none" stroke="#e8b76a" stroke-width="0.8" opacity="0.65"/>'
        '<path d="M65 123H49V107H60M79 123H95V107H84" fill="none" stroke="#151c1b" stroke-width="5"/>'
        '<path d="M65 123H49V107H60M79 123H95V107H84" fill="none" stroke="#9b8c50" stroke-width="1.5"/>'
        '<rect x="53" y="12" width="38" height="7" rx="1.5" fill="#131a19" stroke="#8b8d7e"/>'
        '<path d="M58 15H86M58 17H86" stroke="#a4a28b" stroke-width="0.7"/>'
        + ribs + screws
    )


def packet_svg(progress, brightness):
    """A bright leading packet with a dim outer-side trail; fade at both ends."""
    pieces = []
    for lag, strength in ((0.19, 0.16), (0.12, 0.32), (0.06, 0.58), (0, 1)):
        position = progress - lag
        if not 0 < position < 1:
            continue
        fade = min(1, position / 0.12, (1 - position) / 0.12)
        opacity = fade * strength * brightness
        y = -48 + 42 * position
        pieces.append(
            f'<ellipse cx="0" cy="{y:.3f}" rx="12" ry="10" fill="url(#core)" opacity="{opacity * 0.65:.4f}"/>'
            f'<ellipse cx="0" cy="{y:.3f}" rx="5.2" ry="4" fill="#ffba44" opacity="{opacity * 0.6:.4f}"/>'
            f'<ellipse cx="0" cy="{y:.3f}" rx="3.7" ry="2.6" fill="#ffe3a0" opacity="{opacity:.4f}"/>'
            f'<ellipse cx="0" cy="{y:.3f}" rx="2.3" ry="1.7" fill="#fffbed" opacity="{opacity:.4f}"/>'
        )
    return "".join(pieces)


def tube_svg(angle, phase, brightness):
    """One glass tube in local coordinates, with metal collars at each end."""
    packets = "".join(
        packet_svg((phase + offset) % 1, brightness)
        for offset in (0, 0.5)
    )
    return (
        f'<g transform="translate(72 76) rotate({angle})">'
        '<rect x="-11" y="-54" width="22" height="53" rx="6" fill="#050908" stroke="#555e51" stroke-width="1.2"/>'
        '<rect x="-9" y="-51" width="18" height="48" rx="6" fill="url(#metal)"/>'
        '<rect x="-7" y="-49" width="14" height="43" rx="6" fill="url(#glass)" stroke="#c9c6a2" stroke-width="0.8"/>'
        '<path d="M0 -46V-9" stroke="#ffb444" stroke-width="5" opacity="0.15"/>'
        '<path d="M-1 -46l2 3 -2 3 2 3 -2 3 2 3 -2 3 2 3 -2 3 2 3 -2 3 2 3" fill="none" stroke="#c1964e" stroke-width="1.1"/>'
        + packets
        + '<path d="M-3 -46Q-5 -44 -5 -40V-15Q-5 -11 -3 -9" fill="none" stroke="#f1f4d7" stroke-width="1.3" opacity="0.8"/>'
        '<path d="M4 -43Q6 -32 4 -12" fill="none" stroke="#c9ddcb" stroke-width="0.8" opacity="0.55"/>'
        '<rect x="-10" y="-54" width="20" height="8" rx="2" fill="url(#metal)" stroke="#a39e83" stroke-width="0.8"/>'
        '<rect x="-10" y="-9" width="20" height="8" rx="2" fill="url(#metal)" stroke="#a39e83" stroke-width="0.8"/>'
        '<path d="M-8 -51H8M-8 -48H8M-8 -6H8M-8 -3H8" stroke="#d0c7a1" stroke-width="0.8"/>'
        '<circle cy="-57" r="4.5" fill="#0b100f" stroke="#6f7867" stroke-width="1.5"/>'
        '<circle cy="-57" r="2" fill="#bc9a59"/>'
        '<path d="M-10 -32H-7M7 -32H10" stroke="#c6b984" stroke-width="3"/>'
        '</g>'
    )


def arc_strokes(points, intensity):
    """Layered amber corona and warm-white wire, without renderer filters."""
    return "".join(
        f'<polyline points="{points}" fill="none" stroke="{color}" stroke-width="{width}" '
        f'opacity="{intensity * strength:.4f}" stroke-linejoin="round" stroke-linecap="round"/>'
        for color, width, strength in (
            ("#ffad32", 7, 0.10), ("#ffd06c", 3.5, 0.35), ("#fff4d5", 1.1, 1),
        )
    )


def electric_arcs_svg(phase):
    """Moving jagged filaments and branching hub arcs brighten on packet arrival."""
    branches = []
    for angle, offset in ((-45, 0), (45, 0.08), (180, 0.16)):
        local_phase = (phase + offset) % 1
        arrival = sum(
            math.exp(-(((local_phase + shift) % 1 - 0.84) / 0.14) ** 2)
            for shift in (0, 0.5)
        )
        wave = 2 * math.pi * local_phase
        filament = " ".join(
            f'{2.5 * math.sin(wave + step * 2.4):.3f},{-44 + step * 4.5:.3f}'
            for step in range(9)
        )
        bend = 2.4 * math.sin(wave)
        hub = f'0,-17 {3 + bend:.3f},-13 -2,-10 {2 - bend:.3f},-7 0,-2'
        fork = f'{3 + bend:.3f},-13 7,-14 {8 + bend:.3f},-10 12,-8'
        branches.append(
            f'<g transform="translate(72 76) rotate({angle})">'
            + arc_strokes(filament, 0.25 + 0.32 * arrival)
            + arc_strokes(hub, 0.4 + 0.5 * arrival)
            + arc_strokes(fork, 0.22 + 0.5 * arrival)
            + '</g>'
        )
    return '<g id="electric-arcs">' + "".join(branches) + '</g>'


def energy_glow_svg(phase):
    """Broad local light pools leave the dark enclosure stable, never flashing."""
    pools = "".join(
        f'<g transform="translate(72 76) rotate({angle})">'
        f'<ellipse cy="-26" rx="19" ry="35" fill="url(#core)" opacity="{0.5 + 0.08 * math.sin(2 * math.pi * (phase + offset)):.4f}"/>'
        '</g>'
        for angle, offset in ((-45, 0), (45, 0.08), (180, 0.16))
    )
    return (
        '<g id="energy-glow">' + pools
        + '<circle cx="72" cy="76" r="29" fill="url(#core)" opacity="0.8"/>'
        '</g>'
    )


def definitions_svg():
    return (
        '<defs><linearGradient id="metal" x1="0" y1="0" x2="1" y2="1">'
        '<stop stop-color="#a4a696"/><stop offset="0.23" stop-color="#646d63"/>'
        '<stop offset="0.5" stop-color="#343f39"/><stop offset="0.78" stop-color="#697063"/>'
        '<stop offset="1" stop-color="#242d2a"/></linearGradient>'
        '<linearGradient id="glass">'
        '<stop stop-color="#879783"/><stop offset="0.2" stop-color="#425548"/>'
        '<stop offset="0.45" stop-color="#182720"/><stop offset="0.7" stop-color="#4f4829"/>'
        '<stop offset="1" stop-color="#92a08a"/></linearGradient>'
        '<radialGradient id="recess"><stop stop-color="#253328"/>'
        '<stop offset="1" stop-color="#0a100e"/></radialGradient>'
        '<radialGradient id="core"><stop stop-color="#fff0b8" stop-opacity="0.9"/>'
        '<stop offset="0.22" stop-color="#ffd579" stop-opacity="0.7"/>'
        '<stop offset="0.55" stop-color="#ffa92f" stop-opacity="0.3"/>'
        '<stop offset="1" stop-color="#ffa92f" stop-opacity="0"/></radialGradient></defs>'
    )


def hub_svg(brightness):
    return (
        '<circle cx="72" cy="76" r="10" fill="url(#metal)" stroke="#d3c18c" stroke-width="1"/>'
        '<circle cx="72" cy="76" r="7.5" fill="#192019" stroke="#7b825f"/>'
        '<path d="M65 70L72 77L79 70M72 77V85" fill="none" stroke="#eab85c" stroke-width="3" stroke-linecap="round"/>'
        '<circle cx="72" cy="76" r="18" fill="url(#core)" opacity="0.8"/>'
        f'<circle cx="72" cy="76" r="5" fill="#ffd16b" opacity="{brightness:.4f}"/>'
        '<circle cx="72" cy="76" r="2.8" fill="#fffbe5"/>'
        '<circle cx="65" cy="82" r="1" fill="#d7cca4"/>'
        '<circle cx="79" cy="82" r="1" fill="#d7cca4"/>'
    )


def svg_frame(index):
    """Return a deterministic one-line SVG; indices wrap every 36 states."""
    phase = (index % FRAME_COUNT) / FRAME_COUNT
    brightness = 0.92 + 0.06 * math.sin(2 * math.pi * phase)
    tubes = "".join(
        tube_svg(angle, (phase + offset) % 1, brightness)
        for angle, offset in ((-45, 0), (45, 0.08), (180, 0.16))
    )
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">'
        + definitions_svg()
        + enclosure_svg()
        + energy_glow_svg(phase)
        + tubes
        + electric_arcs_svg(phase)
        + hub_svg(brightness)
        + '</svg>'
    )


def cycle_frames():
    """Yield exactly 36 SVG strings lazily, without a repeated endpoint."""
    for index in range(FRAME_COUNT):
        yield svg_frame(index)


def run_animation(arguments):
    frames = iter(cycle_frames())
    current = next(frames, None)
    while current is not None:
        print(current, flush=True)
        started = time.monotonic()
        # Retain only current/next. Overruns stretch playback rather than skipping
        # states or issuing catch-up bursts; the last frame gets its full dwell.
        following = next(frames, None)
        if following is None and arguments.loop:
            frames = iter(cycle_frames())
            following = next(frames, None)
        remaining = 1 / FPS - (time.monotonic() - started)
        if remaining > 0:
            time.sleep(remaining)
        current = following
    return 0


def main():
    try:
        arguments = parse_arguments()
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8", errors="strict", newline="\n")
        return run_animation(arguments)
    except KeyboardInterrupt:
        return 130
    except BrokenPipeError:
        # Avoid another failed flush at shutdown; do not open a file sink.
        try:
            sys.stdout.close()
        except BrokenPipeError:
            pass
        sys.stdout = None
        return 0
    except (OSError, ValueError):
        sys.stderr.write("Flux capacitor failed.\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
