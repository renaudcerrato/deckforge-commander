# Preview assets

Illustrative previews, not hardware captures.

Run these asset-generation commands on macOS, from the repository root, with Node.js 24 and dependencies installed with `npm ci`. GIFs require Python 3 (showcase/flux capacitor) or compatible FFmpeg (video).

## Regenerate

```sh
npm run assets           # Changed asset groups, then checks
npm run assets -- --force # Force regeneration
npm run assets:images    # Protocol SVGs and key PNGs
npm run assets:gifs      # Demo stdout → GIFs
npm run assets:check     # Protocol/key preview freshness
npm run assets:hero      # Separate animated Mini hero
```

Groups with unchanged inputs and existing outputs are skipped.

## Animated Mini hero

```sh
npm run assets:hero -- --force
```

Creates `assets/hero.gif` at 520×376 and 25 FPS: showcase (one play), video (four), the original `demos/sample.gif` (nine), and flux capacitor (ten), followed by native Loop `status` and Run `deploy` ready cards. Video and GIF show matching Stream ready cards for two seconds between plays; completed animations also show their ready cards. The showcase, video, and flux capacitor captures use display-only rendering; the original sample GIF is processed directly with a centered cover crop. The other inputs retain their full artwork. Existing demo previews, shared key SVGs, and `hero.png` are not changed. This task is separate from `assets`, `assets:gifs`, and freshness checks.

Requires Python 3 and compatible FFmpeg. Fresh intermediates use a unique `deckforge-hero-*` directory under the system temporary directory; set `HERO_TMP_ROOT` to choose an existing parent directory. Successful generation removes only that run's directory; failures retain it at the printed path.

For custom compositions, the generic renderer accepts files or direct protocol records without launching programs:

```sh
node assets/generate-hero.mjs --output hero.gif \
  --input animation.gif --loops 3 --loop-delay 2000 --fit cover --after 'text:Ready' \
  --input 'progress:42/100|label:Build' --input assets/key-run.svg
node assets/generate-hero.mjs --help
```

- Repeat `--input` for one to six keys, left to right, top to bottom; omitted keys stay unlit. Inputs may be static PNG/JPEG/SVG/WebP, static or animated GIF, or `text:`, `card:`, `progress:`, and `data:image/` records. Only GIF animation is supported. Prefix ambiguous filenames with `./`; commas are literal.
- `--loops` is the total play count, default one; `--after` selects a static image/record after completion. Both apply only to animated GIFs. Without `--after`, a completed source holds its last frame. Embedded GIF loop counts are ignored.
- `--loop-delay` adds a pause between plays in milliseconds (default zero; nonnegative safe integer divisible by 10). It applies only to animated GIFs, and positive values require `--after`, which is shown during every pause. There are exactly one fewer pauses than plays; no pause is added after the final play.
- `--fit contain` (default) black-pads non-square inputs; `--fit cover` center-crops without stretching. This per-key choice applies to both main and after imagery.
- `--processed` skips display effects on the current main input, not its after-image. Use it for previews captured with `--no-bezel`; ordinary beveled previews include borders that cannot be removed automatically.
- Globals may appear anywhere: `--width` (1–1112, default 520), `--pixels` (72/96/144, default 96), `--grid` (0–1, default 0.04), and `--glow` (0–1, default 0.08). Key modifiers belong to the most recent `--input`.
- Source change boundaries and positive stored GIF delays determine playback by default. The hero ends at the longest requested playback and loops forever; static-only output is one 100-ms frame. Optional `--fps` (1–100) samples without changing playback speed or natural end. Timing uses 10-ms units; browsers may clamp very short delays.

Limits: 64 MiB per file (including after-images), 262,144 bytes per protocol record, 512 pages per GIF, 512 MiB planned decoded sources, 4,096 planned encoding frames, and 1 GiB planned output RGBA. Processing has a shared 120-second deadline. These are planning limits, not native peak-memory guarantees; overflow fails rather than reducing quality automatically.

Use trusted inputs. An existing regular output GIF is replaced only after complete encoding; input/template aliases, symlinks, and nonregular destinations are rejected. Failed publication staging files are retained beside the output.

## Protocol SVGs

```sh
node assets/generate-protocol-examples.mjs --write # Generate 14 fixed previews
node assets/generate-protocol-examples.mjs --check # Check SVGs and image records
```

Uses the production parser/renderer; keep recipes paired with [README previews](../README.md#protocol). Checks are read-only. Raster fixtures and their `.txt` records are maintained manually.

## Device illustrations

Place trusted static PNG/SVG artwork on the supplied Mini or MK.2 template:

```sh
node assets/compose-device.mjs --device mini --output assets/device-mini-sample.png \
  assets/protocol-text-styled.svg assets/protocol-progress-ring.svg assets/protocol-image.png \
  assets/protocol-progress-bar.svg assets/protocol-text-multiline.svg assets/protocol-text-mono.svg
node assets/compose-device.mjs --device mk2 --output device.png assets/protocol-image.png - assets/protocol-progress-ring.svg
node assets/compose-device.mjs --help
```

Keys fill left to right, top to bottom (Mini: 6; MK.2: 15). `-` skips a key; omitted keys stay unchanged. Non-square artwork is black-padded without cropping or stretching. Inputs are limited to 262,144 bytes each. Use self-contained artwork in a trusted checkout.

Output keeps the template's native dimensions and transparency. An existing regular output PNG is replaced only after successful rendering; inputs, templates, symlinks, and nonregular output paths are rejected as destinations. These display simulations are illustrations, not hardware captures. Separate from `assets:images`/`assets:check`.

## Advertising slides

```sh
node assets/generate-slides.mjs --write
```

Generates three 1920×960 illustrations: [Phosphor](slide-01-phosphor.png), [Output canvas](slide-02-output-canvas.png), and [Command desk](slide-03-command-desk.png). All 27 keys show distinct content using text, progress, graphs, images, and native action cards. These are illustrative outputs, not built-in integrations or hardware captures. The camera-view image is an AI-assisted fictional still, not a live feed.

The command retains intermediates and half-size review images in a fresh `assets/.slide-preview-*` directory. Separate from `assets:images`/`assets:check`.

## Demo GIFs

```sh
TASK_TEMP_DIR=.task ./node_modules/.bin/task --taskfile Taskfile.yml demo-gif
TASK_TEMP_DIR=.task ./node_modules/.bin/task --taskfile Taskfile.yml video-gif
TASK_TEMP_DIR=.task ./node_modules/.bin/task --taskfile Taskfile.yml fluxcapacitor-gif
```

`demo-gif`: `demos/showcase.py` → `assets/demo-preview.gif` (~28 seconds, live timing). `video-gif`: `demos/video.sh` + `demos/sample.mp4` → `assets/video-preview.gif` (five seconds, 10 FPS).

`fluxcapacitor-gif`: `demos/fluxcapacitor.py --once` → `assets/fluxcapacitor-preview.gif` (three seconds, 12 FPS). All three tasks are included in `npm run assets` and `npm run assets:gifs`.

Outputs are replaced only after successful generation. Forced termination may leave temporary files or processes behind. Run these commands only in a trusted checkout.

## Custom GIF

```sh
./demos/showcase.py | node assets/generate-preview.mjs --fps 10 --duration 120 > preview.gif
node assets/generate-preview.mjs --help # Appearance controls and limits
```

- `--fps`: retain every accepted record at a fixed rate (integer `1`–`100`); omit for live timing, which may merge simultaneous updates.
- `--duration`: capture limit in seconds (default: 60), not playback duration.
- `--no-bezel`: emit only the square simulated display at `144 × scale`, retaining pixel/grid/glow effects without the synthetic bezel, margin, or rounded mask.

Use a new output file: redirection truncates existing files before validation.

## Plugin icon

Edit `assets/plugin-icon.svg`:

```sh
node assets/generate-plugin-icon.mjs --output-dir git.renaudcerrato.deckforge.sdPlugin/imgs/plugin # Generate 256/512 PNGs
node assets/generate-plugin-icon.mjs --check --output-dir git.renaudcerrato.deckforge.sdPlugin/imgs/plugin # Compare decoded pixels; no writes
```

Separate from `assets:images`/`assets:check`. Action-list and category icons are unchanged.
