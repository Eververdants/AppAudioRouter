import { describe, expect, it } from 'vitest';
import { detectCarrierPair, matchesCarrier } from './carrierDetect';
import type { AudioDevice, FeedCarrier } from './types';

function device(id: string, name: string): AudioDevice {
  return { id, name };
}

describe('detectCarrierPair', () => {
  it('recognizes VB-Cable by its two stable names, suffixes and case aside', () => {
    const match = detectCarrierPair(
      [
        device('r1', 'Speakers (Realtek Audio)'),
        device('r2', 'CABLE Input (VB-Audio Virtual Cable)'),
      ],
      [device('c1', 'Microphone (USB Mic)'), device('c2', 'CABLE Output (VB-Audio Virtual Cable)')],
    );
    expect(match).not.toBeNull();
    expect(match!.driver.key).toBe('vb-cable');
    expect(match!.renderId).toBe('r2');
    expect(match!.captureId).toBe('c2');
  });

  it('pairs VoiceMeeter with the VAIO pair, never the Aux monitoring pair', () => {
    const match = detectCarrierPair(
      [
        device('r1', 'VoiceMeeter Input (VB-Audio VoiceMeeter VAIO)'),
        device('r2', 'VoiceMeeter Aux Input (VB-Audio VoiceMeeter VAIO3)'),
      ],
      [
        device('c1', 'VoiceMeeter Output (VB-Audio VoiceMeeter VAIO)'),
        device('c2', 'VoiceMeeter Aux Output (VB-Audio VoiceMeeter VAIO3)'),
      ],
    );
    expect(match).not.toBeNull();
    expect(match!.driver.key).toBe('voicemeeter');
    expect(match!.renderId).toBe('r1');
    expect(match!.captureId).toBe('c1');
  });

  it('prefers VB-Cable when several known drivers are installed', () => {
    const match = detectCarrierPair(
      [device('a', 'CABLE Input (VB-Audio Virtual Cable)'), device('b', 'VoiceMeeter Input')],
      [device('x', 'CABLE Output (VB-Audio Virtual Cable)'), device('y', 'VoiceMeeter Output')],
    );
    expect(match!.driver.key).toBe('vb-cable');
  });

  it('returns null when either side is missing — a playback-only endpoint is not a carrier', () => {
    expect(
      detectCarrierPair(
        [device('r1', 'CABLE Input (VB-Audio Virtual Cable)')],
        [device('c1', 'Microphone (Realtek Audio)')],
      ),
    ).toBeNull();
    expect(
      detectCarrierPair(
        [device('r1', 'Speakers (Realtek Audio)')],
        [device('c1', 'CABLE Output (VB-Audio Virtual Cable)')],
      ),
    ).toBeNull();
  });

  it('returns null for an empty machine', () => {
    expect(detectCarrierPair([], [])).toBeNull();
  });
});

describe('matchesCarrier', () => {
  const match = detectCarrierPair(
    [device('r1', 'CABLE Input (VB-Audio Virtual Cable)')],
    [device('c1', 'CABLE Output (VB-Audio Virtual Cable)')],
  )!;

  it('is true only when both endpoints are the ones it found, false when either is null', () => {
    expect(matchesCarrier(match, { render: 'r1', capture: 'c1' })).toBe(true);
    expect(matchesCarrier(match, { render: 'r1', capture: null })).toBe(false);
    expect(matchesCarrier(match, { render: null, capture: null })).toBe(false);
  });

  it('does not pair half of another driver', () => {
    const other: FeedCarrier = { render: 'r1', capture: 'zz' };
    expect(matchesCarrier(match, other)).toBe(false);
  });
});
