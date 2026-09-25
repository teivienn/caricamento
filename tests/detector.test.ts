import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ProjectDetector } from '../src/core/project/detector.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));

describe('ProjectDetector (SPEC §4)', () => {
  const detector = new ProjectDetector();

  it('detects Flutter via pubspec.yaml with both platforms', () => {
    const result = detector.detect(`${fixtures}/flutter`);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('flutter');
    expect(result?.platforms).toEqual(['ios', 'android']);
  });

  it('detects React Native via package.json + android/build.gradle', () => {
    const result = detector.detect(`${fixtures}/react-native`);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('react-native');
    expect(result?.platforms).toContain('android');
  });

  it('detects native Android via settings.gradle', () => {
    const result = detector.detect(`${fixtures}/android-native`);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('android');
    expect(result?.platforms).toEqual(['android']);
  });

  it('returns null for unrecognized directories', () => {
    expect(detector.detect(fixtures)).toBeNull();
  });
});
