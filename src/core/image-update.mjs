const PROTOCOL_ERROR = 'Image protocol error.';
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DATA_URI = /^data:(image\/(?:png|jpeg|svg\+xml|webp));base64,([A-Za-z0-9+/=]+)$/;
const SVG_ROOT = /^\s*<svg(?:\s|\/?>)/;

function protocolError() {
  return new Error(PROTOCOL_ERROR);
}

function normalizeImage(image) {
  if (typeof image !== 'string') throw protocolError();

  const dataUri = DATA_URI.exec(image);
  if (dataUri) {
    const base64 = dataUri[2];
    if (base64.length === 0 || !BASE64.test(base64)) throw protocolError();
    return image;
  }

  if (SVG_ROOT.test(image)) return `data:image/svg+xml,${encodeURIComponent(image)}`;
  throw protocolError();
}

/** Parse a raw image only; JSON producer envelopes and native titles are not supported. */
export function parseImageUpdate(line) {
  try {
    return Object.freeze({ image: normalizeImage(line) });
  } catch {
    throw protocolError();
  }
}
