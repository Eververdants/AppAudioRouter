import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  DELAY_MAX_MS,
  LATENCY_TARGET_MS,
  PRIMARY_VOLUME_MAX,
  PRIMARY_VOLUME_MIN,
  SOURCE_LEVEL_MAX,
} from './types';

/**
 * The paired literals of `lib/types.ts`, checked against the Rust side.
 *
 * Each of these five numbers exists twice — once here, once in `src-tauri` —
 * with nothing binding the two halves: no import, no code generation, no shared
 * header. `tsc` never reads Rust and `cargo check` never reads TypeScript, so a
 * drift is invisible to both and shows up late as a value the backend refuses,
 * or a range the UI offers that the engine's buffers are not sized for. AGENTS.md
 * lists them as a red line for exactly that reason.
 *
 * So this file does the binding: it pins each literal to its exact value, and
 * then reads the Rust source text and requires the twin to say the same. Either
 * half changing alone fails here, which is the point — a human no longer has to
 * remember to open two languages and compare.
 */

/** Read one `pub const NAME: TYPE = 400;` (or a private `const`) out of Rust. */
function rustConst(file: string, name: string): number {
  const path = `${REPO}/src-tauri/src/${file}`;
  const source = readFileSync(path, 'utf8');
  const found = source.match(new RegExp(`(?:pub\\s+)?const\\s+${name}\\s*:[^=]+=\\s*([0-9_]+)`));
  if (found === null || found[1] === undefined) {
    throw new Error(
      `src-tauri/src/${file} no longer declares ${name}: the TypeScript twin in ` +
        `src/lib/types.ts lost its counterpart, and the pair has to be re-established.`,
    );
  }
  return Number(found[1].replace(/_/g, ''));
}

describe('paired TS↔Rust literals', () => {
  it('are the values the contract says they are', () => {
    expect(SOURCE_LEVEL_MAX).toBe(400);
    expect(PRIMARY_VOLUME_MIN).toBe(5);
    expect(PRIMARY_VOLUME_MAX).toBe(100);
    expect(DELAY_MAX_MS).toBe(10_000);
    expect(LATENCY_TARGET_MS).toBe(100);
  });

  it('still match the Rust constants they are mirrored from', () => {
    // Rust names, as they appear in the file that declares them.
    expect(SOURCE_LEVEL_MAX).toBe(rustConst('config.rs', 'SOURCE_VOLUME_MAX'));
    expect(PRIMARY_VOLUME_MIN).toBe(rustConst('config.rs', 'PRIMARY_VOLUME_MIN_PERCENT'));
    expect(PRIMARY_VOLUME_MAX).toBe(rustConst('config.rs', 'SOURCE_VOLUME_NEUTRAL'));
    expect(DELAY_MAX_MS).toBe(rustConst('config.rs', 'DELAY_MAX_MS'));
    expect(LATENCY_TARGET_MS).toBe(rustConst('audio/duplication.rs', 'LATENCY_TARGET_MS'));
  });

  it('have exactly one home in the frontend', () => {
    // The other half of the same disease: a TS literal copied into a component
    // is a third value nobody is bound to update. `lib/types.ts` is the only
    // place one may be *declared*; consumers import it.
    const names = [
      'SOURCE_LEVEL_MAX',
      'PRIMARY_VOLUME_MIN',
      'PRIMARY_VOLUME_MAX',
      'DELAY_MAX_MS',
      'LATENCY_TARGET_MS',
    ];
    // Files that still carry a local copy and have to be pointed at the
    // contract layer. This list may only ever shrink.
    const knownDuplicates = ['src/components/SourceLevelDial.tsx'];
    const declarations = sourceFilesUnder('src').flatMap((relative) => {
      if (relative === 'src/lib/types.ts') return [];
      if (knownDuplicates.includes(relative)) return [];
      const text = readFileSync(`${REPO}/${relative}`, 'utf8');
      return names
        .filter((name) => new RegExp(`\\b(?:const|let|var)\\s+${name}\\b\\s*=`).test(text))
        .map((name) => `${relative}: ${name}`);
    });
    expect(declarations).toEqual([]);
  });
});

/** The repository root. Vitest runs from it (`pnpm test` at the root, in both
 * CI and the docs), and `import.meta.url` is not a `file:` URL inside the jsdom
 * environment, so the working directory is the honest anchor. */
const REPO = process.cwd().replace(/\\/g, '/').replace(/\/$/, '');
if (!existsSync(`${REPO}/src-tauri/src/config.rs`)) {
  throw new Error(
    `paired-literal test expects to run from the repository root; ${REPO} has no src-tauri.`,
  );
}

/** Every TypeScript / TSX file under `dir`, as repo-relative paths. Test files
 * and ambient declarations are skipped: neither can hold a product literal a
 * consumer would read. */
function sourceFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(`${REPO}/${dir}`, { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...sourceFilesUnder(relative));
      continue;
    }
    if (!/\.(?:ts|tsx)$/.test(entry.name) || /\.d\.ts$/.test(entry.name)) continue;
    if (relative.endsWith('.test.ts') || relative.endsWith('.test.tsx')) continue;
    out.push(relative);
  }
  return out;
}
