import { describe, expect, it } from 'vitest';
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';

/**
 * The two bundled locales are written by hand, so the failure this guards
 * against is a real one: a key added to English and forgotten in Chinese, which
 * surfaces as a raw key in the UI with no error anywhere. Same for a
 * placeholder (`{{device}}`) that only one of the two interpolates — the other
 * renders a value the user never sees.
 */

type Leaf = string;
type Tree = { [key: string]: Leaf | Tree };

/** `processList.title` -> "Apps", for every leaf. */
function flatten(tree: Tree, prefix = ''): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'string') flat[path] = value;
    else Object.assign(flat, flatten(value, path));
  }
  return flat;
}

/** `{{name}}` placeholders, in the order they appear. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1] as string);
}

const flatEn = flatten(en as unknown as Tree);
const flatZh = flatten(zhCN as unknown as Tree);

describe('locale files', () => {
  it('define exactly the same keys', () => {
    expect(Object.keys(flatEn).sort()).toEqual(Object.keys(flatZh).sort());
  });

  it('miss no keys in either direction', () => {
    const onlyEn = Object.keys(flatEn).filter((key) => !(key in flatZh));
    const onlyZh = Object.keys(flatZh).filter((key) => !(key in flatEn));
    expect(onlyEn).toEqual([]);
    expect(onlyZh).toEqual([]);
  });

  it('never leave a key empty', () => {
    const empty = Object.entries(flatEn)
      .filter(([, value]) => value.trim() === '')
      .map(([key]) => key);
    const emptyZh = Object.entries(flatZh)
      .filter(([, value]) => value.trim() === '')
      .map(([key]) => key);
    expect(empty).toEqual([]);
    expect(emptyZh).toEqual([]);
  });

  it('interpolate the same placeholders for every key', () => {
    const mismatched: string[] = [];
    for (const key of Object.keys(flatEn)) {
      // Compared as sets: i18next interpolates by name, so a translation that
      // needs the sentence the other way round may name them in another order.
      const a = [...placeholders(flatEn[key] ?? '')].sort().join(',');
      const b = [...placeholders(flatZh[key] ?? '')].sort().join(',');
      if (a !== b) mismatched.push(key);
    }
    expect(mismatched).toEqual([]);
  });

  it('use the singular/plural variants i18next needs only where they are defined', () => {
    // A `_one` / `_other` pair with a missing half renders the raw base key.
    const orphaned = Object.keys(flatEn).filter((key) => {
      if (!key.endsWith('_one') && !key.endsWith('_other')) return false;
      const base = key.replace(/_(one|other)$/, '');
      return flatEn[`${base}_one`] === undefined || flatEn[`${base}_other`] === undefined;
    });
    expect(orphaned).toEqual([]);
  });
});
