import { UnprocessableError } from '@/server/services/errors';

// A photo sent with a task check (Task Photo Proof) is rebuilt from its parts
// before it is stored, so only the picture itself is kept. A phone's JPEG can
// carry far more than the picture: where it was taken (EXIF GPS), a thumbnail
// of the uncropped shot, a second image after the first (MPF), comments. No
// decoding and no dependency: walk the segments from the start, with every
// length checked against what's there, keep only what drawing the picture
// needs (quantization and Huffman tables, the restart interval, the frame
// header, the scans), and drop everything else. Anything unexpected is
// refused rather than guessed at.
//
// The phone turns the picture upright itself before sending (EXIF
// orientation is dropped here with the rest).

/** The largest photo accepted, in bytes (after base64 is decoded). */
export const PHOTO_MAX_BYTES = 1.5 * 1024 * 1024;
/** The longest side accepted, in pixels. */
export const PHOTO_MAX_SIDE = 2048;
/** Shown for every photo that isn't accepted. */
export const PHOTO_UNREADABLE = 'That photo couldn’t be read. Take it again.';

export interface RebuiltJpeg {
  jpeg: Uint8Array;
  width: number;
  height: number;
}

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const DQT = 0xdb;
const DHT = 0xc4;
const DRI = 0xdd;
const COM = 0xfe;
/** Baseline, extended and progressive Huffman-coded frames: what cameras and browsers write. */
const ACCEPTED_SOF = new Set([0xc0, 0xc1, 0xc2]);
/** Every other kind of frame (lossless, hierarchical, arithmetic coded). */
const OTHER_SOF = new Set([0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

const isApp = (marker: number) => marker >= 0xe0 && marker <= 0xef;
const isRestart = (marker: number) => marker >= 0xd0 && marker <= 0xd7;

function unreadable(): never {
  throw new UnprocessableError(PHOTO_UNREADABLE, 'photo');
}

/**
 * The photo rebuilt with SOI, DQT, DHT, DRI, the one SOF, each SOS with its
 * scan data, and EOI, in their order; every APPn (APP0 included) and COM
 * segment dropped, and everything after the first EOI. Only 8-bit SOF0/1/2
 * frames with 1 or 3 components, each side 1 to PHOTO_MAX_SIDE, at most
 * PHOTO_MAX_BYTES. Throws an UnprocessableError (422, PHOTO_UNREADABLE)
 * otherwise.
 */
export function rebuildJpeg(input: Uint8Array): RebuiltJpeg {
  if (input.length < 4 || input.length > PHOTO_MAX_BYTES) unreadable();
  if (input[0] !== 0xff || input[1] !== SOI) unreadable();

  const out: Uint8Array[] = [Uint8Array.of(0xff, SOI)];
  let frame: { width: number; height: number; components: number } | null = null;
  let scans = 0;
  let pos = 2;
  for (;;) {
    // A marker: 0xFF, any fill bytes (more 0xFF), then its code.
    if (pos >= input.length || input[pos] !== 0xff) unreadable();
    while (pos < input.length && input[pos] === 0xff) pos += 1;
    if (pos >= input.length) unreadable();
    const marker = input[pos];
    pos += 1;

    if (marker === EOI) {
      if (!frame || scans === 0) unreadable();
      out.push(Uint8Array.of(0xff, EOI));
      // Anything after it (an MPF second image, trailing data) is dropped.
      return { jpeg: Buffer.concat(out), width: frame.width, height: frame.height };
    }
    // Markers without a length don't belong here (a restart only appears
    // inside scan data, which is read below).
    if (marker === SOI || marker === 0x00 || marker === 0x01 || isRestart(marker)) unreadable();

    if (pos + 2 > input.length) unreadable();
    const length = (input[pos] << 8) | input[pos + 1];
    // The length counts its own two bytes and must fit in what's left.
    if (length < 2 || pos + length > input.length) unreadable();
    const segment = input.subarray(pos - 2, pos + length);
    const body = input.subarray(pos + 2, pos + length);
    pos += length;

    if (isApp(marker) || marker === COM) continue; // metadata: dropped
    if (OTHER_SOF.has(marker)) unreadable();
    if (ACCEPTED_SOF.has(marker)) {
      // Exactly one frame, before the first scan.
      if (frame || scans > 0) unreadable();
      frame = readFrame(body);
      out.push(segment);
      continue;
    }
    if (marker === DQT || marker === DHT || marker === DRI) {
      out.push(segment);
      continue;
    }
    if (marker === SOS) {
      if (!frame) unreadable();
      checkScanHeader(body, frame.components);
      out.push(segment);
      const end = scanEnd(input, pos);
      out.push(input.subarray(pos, end));
      pos = end;
      scans += 1;
      continue;
    }
    // Anything else (DNL, DAC, JPGn, reserved codes) isn't from a camera or
    // a browser: refused rather than kept or dropped blindly.
    unreadable();
  }
}

/** The frame header (SOFn body): 8-bit, 1 or 3 components, sides within the limit. */
function readFrame(body: Uint8Array): { width: number; height: number; components: number } {
  if (body.length < 6) unreadable();
  const precision = body[0];
  const height = (body[1] << 8) | body[2];
  const width = (body[3] << 8) | body[4];
  const components = body[5];
  if (precision !== 8) unreadable();
  if (components !== 1 && components !== 3) unreadable();
  if (body.length !== 6 + 3 * components) unreadable();
  // A height of 0 means "given later" (DNL), which isn't accepted.
  if (width < 1 || height < 1 || width > PHOTO_MAX_SIDE || height > PHOTO_MAX_SIDE) unreadable();
  for (let c = 0; c < components; c += 1) {
    const sampling = body[7 + 3 * c];
    const table = body[8 + 3 * c];
    const h = sampling >> 4;
    const v = sampling & 0x0f;
    if (h < 1 || h > 4 || v < 1 || v > 4 || table > 3) unreadable();
  }
  return { width, height, components };
}

/** A scan header (SOS body): 1 to the frame's components, its length matching. */
function checkScanHeader(body: Uint8Array, frameComponents: number): void {
  if (body.length < 1) unreadable();
  const count = body[0];
  if (count < 1 || count > frameComponents) unreadable();
  if (body.length !== 1 + 2 * count + 3) unreadable();
}

/**
 * Where the scan data starting at [start] ends: at the first marker that is
 * neither a stuffed zero (0xFF 0x00) nor a restart (0xFF 0xD0-0xD7). Refused
 * when the file ends first.
 */
function scanEnd(input: Uint8Array, start: number): number {
  let i = start;
  while (i < input.length) {
    if (input[i] !== 0xff) {
      i += 1;
      continue;
    }
    let next = i + 1;
    while (next < input.length && input[next] === 0xff) next += 1; // fill bytes
    if (next >= input.length) unreadable();
    const code = input[next];
    if (code === 0x00 || isRestart(code)) {
      i = next + 1;
      continue;
    }
    return i;
  }
  return unreadable();
}
