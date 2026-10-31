import { DEFAULT_THEME_COLOR } from './theme.mjs';
import { createTimerKeyLayout, DEFAULT_LAUNCH_CAPTION } from './key-layout.mjs';

function timerSvg(presentation, caption, color, readyFooter, extension) {
  const footer = presentation === 'waiting' ? 'loading...'
    : readyFooter === 'success' || readyFooter === 'setup required' ? readyFooter : 'ready';
  return createTimerKeyLayout(caption, color, footer, extension);
}

export const TIMER_READY_SVG = timerSvg('ready', DEFAULT_LAUNCH_CAPTION, DEFAULT_THEME_COLOR);
export const TIMER_SETUP_SVG = timerSvg('ready', DEFAULT_LAUNCH_CAPTION, DEFAULT_THEME_COLOR, 'setup required');

/** Compact fixed geometry, escaped caption, strict/fallback theme; never a producer-image overlay. */
export function createTimerArtwork(presentation, caption = DEFAULT_LAUNCH_CAPTION, themeColor = DEFAULT_THEME_COLOR, readyFooter, extension) {
  if (presentation !== 'ready' && presentation !== 'waiting') throw new TypeError('Invalid timer presentation.');
  return `data:image/svg+xml,${encodeURIComponent(timerSvg(presentation, caption, themeColor, readyFooter, extension))}`;
}
