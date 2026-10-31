import { DEFAULT_THEME_COLOR } from './theme.mjs';
import { createOnceKeyLayout, DEFAULT_LAUNCH_CAPTION } from './key-layout.mjs';

function onceSvg(presentation, caption, color, readyFooter, extension) {
  const footer = presentation === 'loading' ? 'loading...'
    : readyFooter === 'success' || readyFooter === 'setup required' ? readyFooter : 'ready';
  return createOnceKeyLayout(caption, color, footer, extension);
}

export const ONCE_READY_SVG = onceSvg('ready', DEFAULT_LAUNCH_CAPTION, DEFAULT_THEME_COLOR);
export const ONCE_SETUP_SVG = onceSvg('ready', DEFAULT_LAUNCH_CAPTION, DEFAULT_THEME_COLOR, 'setup required');

/** Built-in presentation only; producer images are never tinted or overlaid. */
export function createOnceArtwork(presentation, caption = DEFAULT_LAUNCH_CAPTION, themeColor = DEFAULT_THEME_COLOR, readyFooter, extension) {
  if (presentation !== 'ready' && presentation !== 'loading') throw new TypeError('Invalid Run presentation.');
  return `data:image/svg+xml,${encodeURIComponent(onceSvg(presentation, caption, themeColor, readyFooter, extension))}`;
}
