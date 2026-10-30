import { describe, expect, it } from 'vitest';
import { PHOTO_MAX_BYTES, PHOTO_UNREADABLE, rebuildJpeg } from '@/server/security/jpeg';
import { UnprocessableError } from '@/server/services/errors';

// Fixtures built byte by byte. CLEAN is a real 8x8 grey JPEG: one quantization
// table, one-code Huffman tables (DC category 0, AC end of block), so its
// whole scan is a single byte.

const bytes = (...parts: (number[] | Uint8Array | string)[]) =>
  Uint8Array.from(
    parts.flatMap((p) => (typeof p === 'string' ? [...Buffer.from(p, 'latin1')] : [...p])),
  );

/** A segment: marker, then a length that counts itself, then the body. */
function segment(marker: number, body: number[] | Uint8Array | string): Uint8Array {
  const payload = bytes(body);
  const length = payload.length + 2;
  return bytes([0xff, marker, length >> 8, length & 0xff], payload);
}

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];
const DQT = segment(0xdb, [0x00, ...new Array(64).fill(1)]);
const DHT_DC = segment(0xc4, [0x00, 1, ...new Array(15).fill(0), 0x00]);
const DHT_AC = segment(0xc4, [0x10, 1, ...new Array(15).fill(0), 0x00]);
/** SOFn header: precision, height, width, then each component (id, sampling 1x1, table 0). */
function sof(marker = 0xc0, opts: { precision?: number; width?: number; height?: number; components?: number } = {}) {
  const { precision = 8, width = 8, height = 8, components = 1 } = opts;
  const comps = Array.from({ length: components }, (_, i) => [i + 1, 0x11, 0x00]).flat();
  return segment(marker, [precision, height >> 8, height & 0xff, width >> 8, width & 0xff, components, ...comps]);
}
const SOS = segment(0xda, [0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
const SCAN = [0x3f];

const CLEAN = bytes(SOI, DQT, sof(), DHT_DC, DHT_AC, SOS, SCAN, EOI);

/** Whether [needle] appears anywhere in [haystack]. */
function contains(haystack: Uint8Array, needle: Uint8Array | string): boolean {
  const n = typeof needle === 'string' ? Buffer.from(needle, 'latin1') : needle;
  return Buffer.from(haystack).indexOf(Buffer.from(n)) !== -1;
}

function refused(input: Uint8Array) {
  let caught: unknown;
  try {
    rebuildJpeg(input);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UnprocessableError);
  expect(caught).toMatchObject({ message: PHOTO_UNREADABLE, field: 'photo' });
}

describe('rebuildJpeg', () => {
  it('gives a clean JPEG back byte for byte, with its size', () => {
    const out = rebuildJpeg(CLEAN);
    expect(Buffer.from(out.jpeg).equals(Buffer.from(CLEAN))).toBe(true);
    expect(out).toMatchObject({ width: 8, height: 8 });
  });

  it('keeps stuffed bytes, restarts and every scan of a progressive photo', () => {
    const scan1 = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56];
    const scan2 = [0x78, 0xff, 0x00, 0x9a];
    const dri = segment(0xdd, [0x00, 0x04]);
    const input = bytes(SOI, DQT, sof(0xc2, { width: 640, height: 480, components: 3 }), DHT_DC, dri,
      segment(0xda, [0x03, 1, 0x00, 2, 0x11, 3, 0x11, 0x00, 0x00, 0x00]), scan1,
      DHT_AC, segment(0xda, [0x01, 0x01, 0x00, 0x01, 0x3f, 0x00]), scan2, EOI);
    const out = rebuildJpeg(input);
    expect(Buffer.from(out.jpeg).equals(Buffer.from(input))).toBe(true);
    expect(out).toMatchObject({ width: 640, height: 480 });
    // Baseline extended (SOF1) is fine too.
    expect(rebuildJpeg(bytes(SOI, DQT, sof(0xc1), DHT_DC, DHT_AC, SOS, SCAN, EOI)).width).toBe(8);
  });

  it('drops EXIF with GPS (APP1), and none of its bytes survive', () => {
    const gps = 'GPS 41.8781N 87.6298W';
    const exif = segment(0xe1, `Exif\0\0MM\0*\0\0\0\x08\0\x01\x88\x25\0\x04\0\0\0\x01\0\0\0\x1a${gps}`);
    const out = rebuildJpeg(bytes(SOI, exif, DQT, sof(), DHT_DC, DHT_AC, SOS, SCAN, EOI));
    expect(Buffer.from(out.jpeg).equals(Buffer.from(CLEAN))).toBe(true);
    expect(contains(out.jpeg, 'Exif')).toBe(false);
    expect(contains(out.jpeg, gps)).toBe(false);
  });

  it('drops a JFIF header with its thumbnail (APP0), and its pixels', () => {
    const thumbnail = [0xa1, 0xb2, 0xc3, 0xa4, 0xb5, 0xc6]; // 2x1 RGB
    const jfif = segment(0xe0, bytes('JFIF\0', [1, 2, 0, 0, 72, 0, 72, 2, 1], thumbnail));
    const out = rebuildJpeg(bytes(SOI, jfif, DQT, sof(), DHT_DC, DHT_AC, SOS, SCAN, EOI));
    expect(Buffer.from(out.jpeg).equals(Buffer.from(CLEAN))).toBe(true);
    expect(contains(out.jpeg, 'JFIF')).toBe(false);
    expect(contains(out.jpeg, Uint8Array.from(thumbnail))).toBe(false);
  });

  it('drops an MPF second image after the first EOI, its APP2 index, and comments', () => {
    const mpf = segment(0xe2, 'MPF\0MM\0*\0\0\0\x08');
    const comment = segment(0xfe, 'Shot on a phone at home');
    const second = bytes(SOI, segment(0xe1, 'Exif\0\0second'), DQT, sof(0xc0, { width: 16, height: 16 }), DHT_DC, DHT_AC, SOS, [0x5a, 0x5b], EOI);
    const out = rebuildJpeg(bytes(SOI, mpf, DQT, comment, sof(), DHT_DC, DHT_AC, SOS, SCAN, EOI, second));
    expect(Buffer.from(out.jpeg).equals(Buffer.from(CLEAN))).toBe(true);
    for (const gone of ['MPF', 'Shot on a phone', 'second']) expect(contains(out.jpeg, gone)).toBe(false);
    expect(contains(out.jpeg, Uint8Array.from([0x5a, 0x5b]))).toBe(false);
    // Exactly one image: one SOI, one EOI.
    expect(out.jpeg.length).toBe(CLEAN.length);
  });

  it('drops every APPn between scans too', () => {
    const icc = segment(0xe2, 'ICC_PROFILE\0secret');
    const out = rebuildJpeg(bytes(SOI, DQT, sof(), DHT_DC, DHT_AC, SOS, SCAN, icc, EOI));
    expect(contains(out.jpeg, 'ICC_PROFILE')).toBe(false);
  });

  it('refuses a 12-bit frame', () => {
    refused(bytes(SOI, DQT, sof(0xc1, { precision: 12 }), DHT_DC, DHT_AC, SOS, SCAN, EOI));
  });

  it('refuses lossless, arithmetic and other frames', () => {
    for (const marker of [0xc3, 0xc5, 0xc9, 0xca, 0xcf]) {
      refused(bytes(SOI, DQT, sof(marker), DHT_DC, DHT_AC, SOS, SCAN, EOI));
    }
  });

  it('refuses a segment length that runs past the end, or is too short', () => {
    const lying = bytes([0xff, 0xe1, 0x40, 0x00], 'Exif\0\0');
    refused(bytes(SOI, lying));
    refused(bytes(SOI, DQT, sof(), [0xff, 0xc4, 0x00, 0x01], SOS, SCAN, EOI));
    refused(bytes(SOI, DQT, [0xff, 0xc0, 0x00]));
    // A frame header whose length doesn't match its component count.
    refused(bytes(SOI, DQT, segment(0xc0, [8, 0, 8, 0, 8, 3, 1, 0x11, 0]), DHT_DC, DHT_AC, SOS, SCAN, EOI));
  });

  it('refuses two frames, or a scan before the frame', () => {
    refused(bytes(SOI, DQT, sof(), sof(), DHT_DC, DHT_AC, SOS, SCAN, EOI));
    refused(bytes(SOI, DQT, sof(), DHT_DC, DHT_AC, SOS, SCAN, sof(), SOS, SCAN, EOI));
    refused(bytes(SOI, DQT, DHT_DC, DHT_AC, SOS, SCAN, sof(), EOI));
  });

  it('refuses a side over 2048 or of 0, and other component counts', () => {
    refused(bytes(SOI, DQT, sof(0xc0, { width: 2049 }), DHT_DC, DHT_AC, SOS, SCAN, EOI));
    refused(bytes(SOI, DQT, sof(0xc0, { height: 4000 }), DHT_DC, DHT_AC, SOS, SCAN, EOI));
    refused(bytes(SOI, DQT, sof(0xc0, { height: 0 }), DHT_DC, DHT_AC, SOS, SCAN, EOI));
    refused(bytes(SOI, DQT, sof(0xc0, { components: 4 }), DHT_DC, DHT_AC, SOS, SCAN, EOI));
    expect(rebuildJpeg(bytes(SOI, DQT, sof(0xc0, { width: 2048, height: 2048 }), DHT_DC, DHT_AC, SOS, SCAN, EOI)).width).toBe(2048);
  });

  it('refuses what is not a JPEG', () => {
    refused(bytes([0x89], 'PNG\r\n\x1a\n', [0, 0, 0, 13], 'IHDR'));
    refused(bytes('GIF89a'));
    refused(new Uint8Array(0));
    refused(bytes(SOI));
  });

  it('refuses a photo cut short: no scan, scan data running off the end, or no EOI', () => {
    refused(bytes(SOI, DQT, sof(), DHT_DC, DHT_AC, EOI));
    refused(bytes(SOI, DQT, sof(), DHT_DC, DHT_AC, SOS, SCAN));
    refused(bytes(SOI, DQT, sof(), DHT_DC, DHT_AC, SOS, SCAN, [0xff]));
    refused(bytes(SOI, DQT, sof()));
  });

  it('refuses markers a camera never writes, and stray bytes between segments', () => {
    refused(bytes(SOI, DQT, segment(0xcc, [0x00, 0x00]), sof(), DHT_DC, DHT_AC, SOS, SCAN, EOI)); // DAC
    refused(bytes(SOI, DQT, [0xff, 0xd0], sof(), DHT_DC, DHT_AC, SOS, SCAN, EOI)); // a restart outside a scan
    refused(bytes(SOI, [0x00], DQT, sof(), DHT_DC, DHT_AC, SOS, SCAN, EOI));
    refused(bytes(SOI, SOI, DQT, sof(), DHT_DC, DHT_AC, SOS, SCAN, EOI));
  });

  it('refuses a photo over 1.5 MB', () => {
    const padding = segment(0xfe, new Uint8Array(60_000));
    const parts: Uint8Array[] = [Uint8Array.from(SOI)];
    while (parts.reduce((n, p) => n + p.length, 0) <= PHOTO_MAX_BYTES) parts.push(padding);
    refused(bytes(...parts, DQT, sof(), DHT_DC, DHT_AC, SOS, SCAN, EOI));
  });
});
