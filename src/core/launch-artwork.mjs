import { DEFAULT_THEME_COLOR, resolveThemeColor } from './theme.mjs';
import { createKeyLayout, DEFAULT_LAUNCH_CAPTION } from './key-layout.mjs';
export { formatLaunchCaption, getReadyTitle, getExecutableExtension } from './key-layout.mjs';

function launchSvg(presentation, caption, color, readyFooter, extension) {
  const footer = presentation === 'waiting' ? 'loading...'
    : readyFooter === 'exited' || readyFooter === 'setup required' ? readyFooter : 'ready';
  return createKeyLayout(caption, color, undefined, footer, extension);
}

export const READY_SVG = launchSvg('ready', DEFAULT_LAUNCH_CAPTION, DEFAULT_THEME_COLOR);
export const SETUP_SVG = launchSvg('ready', DEFAULT_LAUNCH_CAPTION, DEFAULT_THEME_COLOR, 'setup required');

/** Compact fixed geometry, escaped caption, strict/fallback theme; never a producer-image overlay. */
export function createLaunchArtwork(presentation, caption = DEFAULT_LAUNCH_CAPTION, themeColor = DEFAULT_THEME_COLOR, readyFooter, extension) {
  if (presentation !== 'ready' && presentation !== 'waiting') throw new TypeError('Invalid launch presentation.');
  return `data:image/svg+xml,${encodeURIComponent(launchSvg(presentation, caption, resolveThemeColor(themeColor), readyFooter, extension))}`;
}
