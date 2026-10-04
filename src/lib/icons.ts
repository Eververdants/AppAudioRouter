/**
 * The backend reports a process's icon as raw RGBA, base64-packed; the UI
 * wants an `<img>`. The bridge between the two is a one-time canvas round trip
 * per executable — decode, `putImageData`, re-encode as a data URL.
 */

/** What `get_process_icon` returns: top-down RGBA rows, 4 bytes per pixel. */
export interface ProcessIcon {
  width: number;
  height: number;
  rgba: string;
}

/** Base64 → clamped bytes, ready for an `ImageData`. */
export function decodeBase64(base64: string): Uint8ClampedArray<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8ClampedArray(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Turn one `ProcessIcon` into a data URL the tile's `<img>` can wear.
 *
 * Returns null rather than throwing: an icon is decoration, and a canvas that
 * refuses to draw must not take the process list down with it.
 */
export function rgbaToDataUrl(icon: ProcessIcon): string | null {
  try {
    const bytes = decodeBase64(icon.rgba);
    const canvas = document.createElement('canvas');
    canvas.width = icon.width;
    canvas.height = icon.height;
    const context = canvas.getContext('2d');
    if (context === null) return null;
    context.putImageData(new ImageData(bytes, icon.width, icon.height), 0, 0);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}
