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

/** Largest image this will decode, in pixels.
 *
 *  A real shell icon is 32×32 or 48×48; even a 256×256 jumbo icon is well
 *  inside this. The bound is here because the payload crosses the IPC
 *  boundary, and the cost of decoding it is paid once per executable on the
 *  thread that also renders the process list.
 */
const MAX_ICON_PIXELS = 512 * 512;

/**
 * Whether `icon` names a rectangle a canvas can be asked to draw.
 *
 * Split out of [`rgbaToDataUrl`] because the rule has to be testable on its
 * own: jsdom cannot draw at all, so through that path every payload degrades
 * to null and a dimension bug would pass for the wrong reason.
 *
 * Zero is the case that matters. A canvas of no width or height encodes a
 * perfectly valid PNG of nothing, and a data URL is final — the store never
 * asks for that executable again — so an empty image would wear a broken
 * `<img>` for the rest of the run where the letter tile should have stayed.
 * The ceiling is the other half: the payload crosses the IPC boundary, and
 * decoding it is paid once per executable on the main thread.
 */
export function isDrawableIcon(icon: ProcessIcon): boolean {
  if (!Number.isInteger(icon.width) || !Number.isInteger(icon.height)) return false;
  if (icon.width <= 0 || icon.height <= 0) return false;
  return icon.width * icon.height <= MAX_ICON_PIXELS;
}

/**
 * Turn one `ProcessIcon` into a data URL the tile's `<img>` can wear.
 *
 * Returns null rather than throwing: an icon is decoration, and a canvas that
 * refuses to draw must not take the process list down with it.
 *
 * A payload whose bytes do not fill the rectangle it names is turned away too
 * — `ImageData` would reject it by throwing, which is a slower route to the
 * same answer and one that only fires after the decode.
 */
export function rgbaToDataUrl(icon: ProcessIcon): string | null {
  if (!isDrawableIcon(icon)) return null;

  try {
    const bytes = decodeBase64(icon.rgba);
    if (bytes.length !== icon.width * icon.height * 4) return null;
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
