'use strict';

/**
 * webm-duration.js — writes a Duration element into a MediaRecorder WebM blob.
 *
 * Chrome's MediaRecorder muxes WebM as a live stream: the header goes out
 * before it knows how long the recording will be, and it never seeks back to
 * fill in Segment > Info > Duration. Players cope (they derive length from the
 * last cluster's timestamp), so this goes unnoticed until something insists on
 * reading the header — e.g. an STT service rejecting the upload with
 * "error getting audio duration: webm duration parsing requires full EBML
 * parser". The bytes are perfectly valid; the duration just isn't written.
 *
 * This walks the EBML tree as far as Segment > Info, then either overwrites an
 * existing Duration or splices one in and grows Info's size field to match.
 * MediaRecorder writes Segment with "unknown size" (it is still streaming when
 * the header is emitted), so Segment's own size never needs recalculating —
 * and if some future Chrome does write a known size, we bail out rather than
 * leave it inconsistent.
 *
 * Fail-safe by design: any unexpected structure returns the ORIGINAL blob
 * untouched. A recording that uploads with the old error is recoverable; a
 * recording corrupted by an over-eager byte patch is not.
 *
 * EBML/Matroska element IDs per the spec: https://www.matroska.org/technical/elements.html
 */

const ID_SEGMENT        = 0x18538067;
const ID_INFO           = 0x1549a966;
const ID_DURATION       = 0x4489;
const ID_TIMECODE_SCALE = 0x2ad7b1;

// Nanoseconds per timecode tick. WebM's default of 1e6 means 1 tick = 1 ms,
// and Duration is expressed in these ticks rather than in any absolute unit.
const DEFAULT_TIMECODE_SCALE = 1000000;

// Reads an EBML variable-length integer. The leading-zero count of the first
// byte gives the total width: 1xxxxxxx = 1 byte, 01xxxxxx = 2 bytes, and so on.
// Element IDs keep that marker bit as part of their value; sizes strip it, and
// a size whose every value bit is set means "unknown" (a live stream).
function readVint(view, pos, keepMarker) {
  if (pos >= view.byteLength) throw new Error('read past end of buffer');

  const first = view.getUint8(pos);
  if (first === 0) throw new Error('invalid VINT leading byte 0x00');

  let length = 1;
  for (let mask = 0x80; !(first & mask); mask >>= 1) length++;
  if (pos + length > view.byteLength) throw new Error('truncated VINT');

  const valueMask = 0xff >> length;
  let value   = keepMarker ? first : (first & valueMask);
  let allOnes = (first & valueMask) === valueMask;

  for (let i = 1; i < length; i++) {
    const byte = view.getUint8(pos + i);
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }

  return { value, length, unknown: !keepMarker && allOnes };
}

// Encodes a size as an EBML VINT, in the narrowest width that fits. A value of
// exactly 2^(7·width)−1 is skipped because that encoding is reserved for
// "unknown size".
function writeVint(value) {
  let length = 1;
  while (length <= 8 && value >= Math.pow(2, 7 * length) - 1) length++;
  if (length > 8) throw new Error(`size ${value} too large to encode`);

  const bytes = new Uint8Array(length);
  let remaining = value;
  for (let i = length - 1; i >= 0; i--) {
    bytes[i] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  bytes[0] |= 0x80 >> (length - 1); // width marker
  return bytes;
}

async function fixWebmDuration(blob, durationMs) {
  try {
    if (!blob || !(durationMs > 0) || !isFinite(durationMs)) return blob;
    // Only WebM/Matroska is EBML — an ogg fallback has a different container.
    if (!/webm|matroska/i.test(blob.type || '')) return blob;

    const buffer = await blob.arrayBuffer();
    const view   = new DataView(buffer);
    const bytes  = new Uint8Array(buffer);

    // ── Locate Segment (skipping the EBML header element) ──────────
    let segmentStart = -1;
    let segmentEnd   = bytes.length;
    let segmentSizeIsUnknown = false;

    for (let pos = 0; pos < bytes.length; ) {
      const id   = readVint(view, pos, true);
      const size = readVint(view, pos + id.length, false);
      const payloadStart = pos + id.length + size.length;

      if (id.value === ID_SEGMENT) {
        segmentStart = payloadStart;
        segmentSizeIsUnknown = size.unknown;
        segmentEnd = size.unknown
          ? bytes.length
          : Math.min(bytes.length, payloadStart + size.value);
        break;
      }
      if (size.unknown) break; // nothing after an unknown-size element is locatable
      pos = payloadStart + size.value;
    }

    if (segmentStart < 0) throw new Error('Segment element not found');

    // ── Locate Info within Segment ─────────────────────────────────
    let infoSizeStart    = -1;
    let infoPayloadStart = -1;
    let infoPayloadEnd   = -1;

    for (let pos = segmentStart; pos < segmentEnd; ) {
      const id   = readVint(view, pos, true);
      const size = readVint(view, pos + id.length, false);
      const payloadStart = pos + id.length + size.length;
      if (size.unknown) break;

      if (id.value === ID_INFO) {
        infoSizeStart    = pos + id.length;
        infoPayloadStart = payloadStart;
        infoPayloadEnd   = Math.min(segmentEnd, payloadStart + size.value);
        break;
      }
      pos = payloadStart + size.value;
    }

    if (infoPayloadStart < 0) throw new Error('Info element not found');

    // ── Read TimecodeScale, and any Duration already present ───────
    let timecodeScale    = DEFAULT_TIMECODE_SCALE;
    let durPayloadStart  = -1;
    let durPayloadLength = 0;

    for (let pos = infoPayloadStart; pos < infoPayloadEnd; ) {
      const id   = readVint(view, pos, true);
      const size = readVint(view, pos + id.length, false);
      const payloadStart = pos + id.length + size.length;
      if (size.unknown) break;

      if (id.value === ID_TIMECODE_SCALE && size.value > 0 && size.value <= 8) {
        let scale = 0;
        for (let i = 0; i < size.value; i++) scale = scale * 256 + view.getUint8(payloadStart + i);
        if (scale > 0) timecodeScale = scale;
      } else if (id.value === ID_DURATION) {
        durPayloadStart  = payloadStart;
        durPayloadLength = size.value;
      }
      pos = payloadStart + size.value;
    }

    // Duration is measured in timecode ticks, not milliseconds.
    const ticks = (durationMs * 1e6) / timecodeScale;

    // ── Case 1: Duration exists — overwrite the float in place ─────
    if (durPayloadStart >= 0) {
      if (durPayloadLength === 4) {
        view.setFloat32(durPayloadStart, ticks, false); // EBML floats are big-endian
      } else if (durPayloadLength === 8) {
        view.setFloat64(durPayloadStart, ticks, false);
      } else {
        throw new Error(`unexpected Duration payload length ${durPayloadLength}`);
      }
      return new Blob([buffer], { type: blob.type });
    }

    // ── Case 2: splice a Duration element into Info ────────────────
    // Growing Info shifts every byte after it, which would invalidate a known
    // Segment size (and any absolute offsets a SeekHead recorded). MediaRecorder
    // writes neither, but check rather than assume.
    if (!segmentSizeIsUnknown) {
      throw new Error('Segment has a known size — refusing to shift its contents');
    }

    const durationElement = new Uint8Array(11);
    durationElement[0] = 0x44; // Duration ID (0x4489)
    durationElement[1] = 0x89;
    durationElement[2] = 0x88; // size VINT: 8-byte payload
    new DataView(durationElement.buffer).setFloat64(3, ticks, false);

    const newInfoSize = (infoPayloadEnd - infoPayloadStart) + durationElement.length;

    return new Blob([
      bytes.subarray(0, infoSizeStart),                  // everything up to Info's size field
      writeVint(newInfoSize),                            // Info size, grown
      bytes.subarray(infoPayloadStart, infoPayloadEnd),  // original Info payload
      durationElement,                                   // + the Duration we just built
      bytes.subarray(infoPayloadEnd),                    // Tracks, Clusters — untouched
    ], { type: blob.type });

  } catch (err) {
    console.warn(`[webm-duration] Leaving blob unpatched (${err.message}).`);
    return blob;
  }
}

export { fixWebmDuration };
