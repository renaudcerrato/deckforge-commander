import { copyOutputData as copyPlainOutputData } from './output-data.mjs';
import { parseImageUpdate } from './image-update.mjs';
import { createPrimitiveArtwork } from './primitive-artwork.mjs';

function copyOutputData(input) {
  const copy = copyPlainOutputData(input);
  return copy === undefined ? undefined : Object.freeze(copy);
}

/** Snapshot external callbacks as data; rejected test/adapter inputs must not evict valid output. */
export function snapshotOutput(input) {
  try {
    const update = copyOutputData(input);
    if (!update) return undefined;
    if (update.kind === 'image') {
      if (Object.keys(update).length !== 2 || typeof update.image !== 'string'
        || update.image.length > 262_144 * 9 + 128) return undefined;
      const raw = update.image.startsWith('data:image/svg+xml,')
        ? decodeURIComponent(update.image.slice('data:image/svg+xml,'.length)) : update.image;
      if (Buffer.byteLength(raw, 'utf8') > 262_144 || parseImageUpdate(raw).image !== update.image) return undefined;
      return Object.freeze({ kind: 'image', image: update.image });
    }
    if (!['text', 'progress', 'card'].includes(update.kind) || Object.keys(update).length !== 4
      || !Object.hasOwn(update, 'value') || !Object.hasOwn(update, 'options') || !Object.hasOwn(update, 'overrides')) return undefined;
    const options = copyOutputData(update.options);
    const overrides = copyOutputData(update.overrides);
    if (!options || !overrides) return undefined;
    const copy = Object.freeze({ kind: update.kind, value: update.value, options, overrides });
    return createPrimitiveArtwork(copy) === undefined ? undefined : copy;
  } catch { return undefined; }
}
