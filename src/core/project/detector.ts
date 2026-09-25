import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectDescriptor, DetectedProjectType } from './types.js';
import type { Platform } from '../config/schema.js';

/**
 * Detection order per SPEC.md §4 (top priority first):
 *   1. pubspec.yaml -> Flutter
 *   2. package.json + (ios/*.xcodeproj | android/build.gradle) -> React Native
 *   3. *.xcodeproj / *.xcworkspace -> native iOS
 *   4. settings.gradle(.kts) / build.gradle(.kts) -> native Android
 */
export class ProjectDetector {
  detect(root: string): ProjectDescriptor | null {
    const entries = this.safeReaddir(root);

    if (entries.includes('pubspec.yaml')) {
      return this.descriptor('flutter', root);
    }

    if (entries.includes('package.json')) {
      const iosDir = join(root, 'ios');
      const hasRnIos = this.safeReaddir(iosDir).some((e) => e.endsWith('.xcodeproj') || e.endsWith('.xcworkspace'));
      const hasRnAndroid =
        existsSync(join(root, 'android', 'build.gradle')) || existsSync(join(root, 'android', 'build.gradle.kts'));
      if (hasRnIos || hasRnAndroid) {
        return this.descriptor('react-native', root);
      }
    }

    if (entries.some((e) => e.endsWith('.xcodeproj') || e.endsWith('.xcworkspace'))) {
      return { type: 'ios', platforms: ['ios'], paths: { root, ios: root } };
    }

    if (
      entries.some((e) => e === 'settings.gradle' || e === 'settings.gradle.kts' || e === 'build.gradle' || e === 'build.gradle.kts')
    ) {
      return { type: 'android', platforms: ['android'], paths: { root, android: root } };
    }

    return null;
  }

  private descriptor(type: DetectedProjectType, root: string): ProjectDescriptor {
    const platforms: Platform[] = [];
    const paths: ProjectDescriptor['paths'] = { root };
    if (existsSync(join(root, 'ios'))) {
      platforms.push('ios');
      paths.ios = join(root, 'ios');
    }
    if (existsSync(join(root, 'android'))) {
      platforms.push('android');
      paths.android = join(root, 'android');
    }
    return { type, platforms, paths };
  }

  private safeReaddir(dir: string): string[] {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  }
}
