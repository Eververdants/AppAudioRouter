import { describe, expect, it } from 'vitest';
import { decodeBase64, rgbaToDataUrl } from './icons';

describe('decodeBase64', () => {
  it('decodes the pixel bytes behind the payload', () => {
    expect(Array.from(decodeBase64(''))).toEqual([]);
    expect(Array.from(decodeBase64('Zm9vYmFy'))).toEqual([102, 111, 111, 98, 97, 114]);
  });
});

describe('rgbaToDataUrl', () => {
  it('degrades to null instead of throwing', () => {
    // A payload that does not fill its own width × height makes ImageData
    // refuse; a canvas-less environment (this one) makes the context null.
    // Both are "no icon", never an error the list has to survive.
    expect(rgbaToDataUrl({ width: 2, height: 2, rgba: 'AAAA' })).toBeNull();
  });
});
