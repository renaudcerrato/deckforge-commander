import { TextDecoder } from 'node:util';

const MAX_LINE_BYTES = 262_144;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const PROTOCOL_ERROR = 'Image protocol error.';
const WHITESPACE_ONLY = /^\p{White_Space}*$/u;

function protocolError() {
  return new Error(PROTOCOL_ERROR);
}

/** Frame bounded UTF-8 newline records without interpreting their contents. */
export function createImageLineFramer({ onLine }) {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const lineBuffer = new Uint8Array(MAX_LINE_BYTES + 1);
  let partialLength = 0;
  let finished = false;
  let failed = false;

  function fail() {
    failed = true;
    lineBuffer.fill(0, 0, partialLength);
    partialLength = 0;
    throw protocolError();
  }

  function decode(bytes, length) {
    try {
      return decoder.decode(bytes.subarray(0, length));
    } catch {
      fail();
    }
  }

  function emitLine(segment) {
    const length = partialLength + segment.length;
    const finalByte = segment.length > 0
      ? segment[segment.length - 1]
      : lineBuffer[partialLength - 1];
    const payloadLength = length - (finalByte === CARRIAGE_RETURN ? 1 : 0);
    if (payloadLength > MAX_LINE_BYTES) fail();

    let line;
    if (partialLength > 0) {
      lineBuffer.set(segment, partialLength);
      partialLength = length;
      line = decode(lineBuffer, payloadLength);
      lineBuffer.fill(0, 0, partialLength);
      partialLength = 0;
    } else {
      line = decode(segment, payloadLength);
    }
    if (!WHITESPACE_ONLY.test(line)) onLine(line);
  }

  function appendPartial(chunk, start, end) {
    const segmentLength = end - start;
    const length = partialLength + segmentLength;
    const finalByte = segmentLength > 0
      ? chunk[end - 1]
      : lineBuffer[partialLength - 1];
    const possibleCrLf = length === MAX_LINE_BYTES + 1 && finalByte === CARRIAGE_RETURN;
    if (length > MAX_LINE_BYTES && !possibleCrLf) fail();

    if (segmentLength === 1) {
      lineBuffer[partialLength] = chunk[start];
    } else if (segmentLength > 1) {
      lineBuffer.set(chunk.subarray(start, end), partialLength);
    }
    partialLength = length;
  }

  function push(chunk) {
    if (failed || finished || !(chunk instanceof Uint8Array)) fail();

    let offset = 0;
    while (offset < chunk.length) {
      const delimiter = chunk.indexOf(LINE_FEED, offset);
      if (delimiter === -1) {
        appendPartial(chunk, offset, chunk.length);
        return;
      }
      emitLine(chunk.subarray(offset, delimiter));
      offset = delimiter + 1;
    }
  }

  function finish() {
    if (failed) throw protocolError();
    if (finished) return;
    finished = true;

    if (partialLength > MAX_LINE_BYTES) fail();
    const length = partialLength;
    const line = decode(lineBuffer, length);
    lineBuffer.fill(0, 0, length);
    partialLength = 0;
    if (!WHITESPACE_ONLY.test(line)) fail();
  }

  return { push, finish };
}
