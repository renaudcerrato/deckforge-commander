import type { OutputTextUpdate, OutputProgressUpdate, OutputCardUpdate } from './output-update.mjs';

/**
 * Pure, bounded artwork on a logical 144-unit opaque canvas (default black), not hardware pixels.
 * Accepts complete plain primitive DTOs from parseOutputUpdate; never renders images.
 * Returns an encoded SVG data URI, or undefined for invalid data/impossible geometry.
 * Text uses deterministic conservative font estimates, grapheme-safe wrapping/ellipsis,
 * and independent horizontal/vertical padding and clipping. Auto wrapping prefers the fewest
 * complete lines, then the largest size. Line work is bounded by the grapheme budget, not sizes.
 * Decoded LF hard breaks preserve empty lines and soft-wrap each hard line independently,
 * within one shared 512-grapheme budget; height overflow ellipsizes the last visible line.
 * Captioned headlines and overflow:ellipsis flatten hard breaks to spaces and stay single-line.
 * Positive borders (up to 16) derive corner-safe padding locally on each axis (at least requested),
 * enclosing the text box inside the frame's inward stroke edge plus a 2-unit gap.
 * Main text fonts are auto (48 down to 16) or any fixed finite positive size. Nonblank labels
 * select a single-line headline and independently weighted/aligned caption above or below it
 * (default below). The finite nonnegative label-gap defaults to 8 and applies only to a pair.
 * Caption-only placement does not depend on order; label-align anchors to the padded edges.
 * Auto caption size is half the fitted headline clamped to 14..18 (18 for caption-only);
 * explicit caption sizes are finite and positive. Valign places the complete visible block.
 * Fixed text blocks exceeding height drop only the caption and gap; neither font shrinks.
 * Blank/omitted labels retain ordinary wrapping. Both captioned lines may ellipsize.
 * Nonpositive drawable width/height skips even a clear; unrepresentable geometry also skips.
 * Cards keep literal content, with single-line main by default (overflow:ellipsis).
 * Header/footer stay single-line at padded top/bottom edges; header-gap/footer-gap default
 * to 8, accept finite nonnegative values, and reserve nothing for a blank side.
 * Main centers its whole visible block between the side reservations. Overflow:wrap soft-wraps
 * only main content with 1.2 line spacing; wire backslash-n stays literal in every field.
 * Auto wrap prefers the fewest complete lines, then the largest size from 48 down to 16;
 * height overflow ellipsizes the last available line. If no line fits, retain one clipped line.
 * Each line has independent horizontal alignment. Side font, weight, and color inherit main;
 * auto side sizes are half the fitted main clamped to 14..18, or 18 without main content.
 * Auto main tries 48 down to 16, retaining 16 if none fit. Fixed sizes never shrink;
 * oversized lines overlap or clip rather than being dropped. Horizontal ellipsis is used
 * when possible; otherwise bounded content remains behind the padded clip.
 * Fixed font sizes never shrink. Progress annotation sizes are independently finite and positive;
 * default percentages round to the nearest tenth without trailing .0 and never truncate.
 * Explicit literal display and labels may ellipsize; empty display hides the value.
 * Fill uses the full percentage, independent of annotations; impossible layouts skip entirely.
 * Rings with a visible centered value and label center their whole block at 72,
 * using the selected font heights and label-gap (default 2); solo/hidden values ignore the gap.
 * Label weight is independent, inheriting effective main/value weight when omitted.
 * Same-side stacks keep their value anchor and order with the exact requested internal gap.
 * Separately positioned labels move only outward when their existing gap is insufficient;
 * value anchors and track clearances remain fixed outside the paired centered-ring case.
 * With a positive border, progress scale scales the frame's full interior span minus
 * a 2-unit gap per side (124 - border); ring diameter includes stroke. Without a
 * border, ring/bar reference spans remain 144/112. Scale and thickness are finite and positive,
 * limited by actual canvas/protected-frame containment, not policy ranges. Rings require a
 * positive usable interior; rounded bars bound their radius by both track dimensions.
 * Centered bar annotations cap at 108. Unrepresentable positive geometry skips atomically.
 * Bordered annotations also respect the protected rounded frame across their full
 * logical font-height slots; these guards do not establish actual glyph metrics.
 */
export declare function createPrimitiveArtwork(update: OutputTextUpdate | OutputProgressUpdate | OutputCardUpdate): string | undefined;
