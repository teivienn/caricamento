import type { Platform } from '../config/schema.js';

export type DetectedProjectType = 'ios' | 'android' | 'react-native' | 'flutter';

export interface ProjectDescriptor {
  type: DetectedProjectType;
  platforms: Platform[];
  paths: {
    root: string;
    ios?: string;
    android?: string;
  };
}
