// Task Photo Proof, in the browser: the photo a child sends with a check.
// The server drops EXIF (so the phone's "rotate this" tag would be lost) and
// accepts only a JPEG, so the picture is turned upright, scaled down and
// encoded here: createImageBitmap(..., { imageOrientation: 'from-image' })
// bakes the rotation into the pixels, a canvas scales it to at most
// PHOTO_MAX_EDGE on its long edge, and it is encoded as a JPEG at
// PHOTO_QUALITY. The base64 goes in the complete call's `photo`.

/** Longest edge of a sent photo, in pixels (the server allows up to 2048). */
export const PHOTO_MAX_EDGE = 1600;
/** JPEG quality of a sent photo. */
export const PHOTO_QUALITY = 0.8;
/** Most base64 characters the server takes (validation/task.ts PHOTO_BASE64_MAX, 1.5 MiB decoded). */
const PHOTO_BASE64_LIMIT = 2_097_152;

export interface EncodedPhoto {
  /** Base64 JPEG, no data: prefix (what `photo` carries). */
  base64: string;
  /** The same JPEG as a data: URL, for the preview. */
  dataUrl: string;
  width: number;
  height: number;
}

/** [width] x [height] scaled down (never up) so the long edge is at most [maxEdge]. */
export function fitWithin(width: number, height: number, maxEdge: number = PHOTO_MAX_EDGE): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= maxEdge || long === 0) return { width, height };
  const scale = maxEdge / long;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** The base64 part of a data: URL. */
export function base64Of(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

/**
 * The picked or taken photo, upright, scaled and encoded as a JPEG. Rejects
 * when the browser can't read it (an unsupported format, a broken file).
 */
export async function encodeTaskPhoto(file: Blob): Promise<EncodedPhoto> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No canvas');
    ctx.drawImage(bitmap, 0, 0, width, height);
    // Very busy pictures can still come out large: step the quality down until it fits.
    let quality = PHOTO_QUALITY;
    let dataUrl = canvas.toDataURL('image/jpeg', quality);
    while (base64Of(dataUrl).length > PHOTO_BASE64_LIMIT && quality > 0.35) {
      quality -= 0.15;
      dataUrl = canvas.toDataURL('image/jpeg', quality);
    }
    if (!dataUrl.startsWith('data:image/jpeg')) throw new Error('Not a JPEG');
    return { base64: base64Of(dataUrl), dataUrl, width, height };
  } finally {
    bitmap.close();
  }
}
