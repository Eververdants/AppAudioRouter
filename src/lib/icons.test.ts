import { describe, expect, it } from 'vitest';
import { decodeBase64, isDrawableIcon, rgbaToDataUrl } from './icons';

describe('decodeBase64', () => {
  it('decodes the pixel bytes behind the payload', () => {
    expect(Array.from(decodeBase64(''))).toEqual([]);
    expect(Array.from(decodeBase64('Zm9vYmFy'))).toEqual([102, 111, 111, 98, 97, 114]);
  });
});

describe('isDrawableIcon', () => {
  it('accepts the rectangle a real shell icon describes', () => {
    expect(isDrawableIcon({ width: 32, height: 32, rgba: '' })).toBe(true);
    expect(isDrawableIcon({ width: 256, height: 256, rgba: '' })).toBe(true);
  });

  it('refuses an image of no size, which would encode a broken picture', () => {
    // The one case that used to get through: a canvas of zero width and height
    // encodes a perfectly valid PNG of nothing, and a data URL is final, so the
    // tile would wear a broken image forever instead of its letter.
    expect(isDrawableIcon({ width: 0, height: 0, rgba: '' })).toBe(false);
    expect(isDrawableIcon({ width: 32, height: 0, rgba: '' })).toBe(false);
    expect(isDrawableIcon({ width: 0, height: 32, rgba: '' })).toBe(false);
  });

  it('refuses dimensions that are not whole numbers', () => {
    // The values arrive over IPC, so they are whatever the payload says.
    expect(isDrawableIcon({ width: 32.5, height: 32, rgba: '' })).toBe(false);
    expect(isDrawableIcon({ width: 32, height: Number.NaN, rgba: '' })).toBe(false);
  });

  it('refuses an image large enough to cost the main thread real time', () => {
    expect(isDrawableIcon({ width: 513, height: 513, rgba: '' })).toBe(false);
  });
});

describe('rgbaToDataUrl', () => {
  it('degrades to null instead of throwing', () => {
    // A payload that does not fill its own width × height is turned away
    // before the decode; a canvas-less environment (this one) makes the
    // context null. Both are "no icon", never an error the list has to survive.
    expect(rgbaToDataUrl({ width: 2, height: 2, rgba: 'AAAA' })).toBeNull();
  });

  it('never hands back an image it was told not to draw', () => {
    expect(rgbaToDataUrl({ width: 0, height: 0, rgba: '' })).toBeNull();
    expect(rgbaToDataUrl({ width: 513, height: 513, rgba: '' })).toBeNull();
  });
});
