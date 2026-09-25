import type { CaricamentoConfig } from '../core/config/schema.js';
import { ProjectDetector } from '../core/project/detector.js';
import type { ProjectDescriptor } from '../core/project/types.js';
import { ValidationError } from '../core/errors.js';

export interface DetectInput {
  cwd: string;
  config: CaricamentoConfig;
}

export class DetectUseCase {
  constructor(private readonly detector = new ProjectDetector()) {}

  execute(input: DetectInput): ProjectDescriptor {
    const configured = input.config.project.type;
    const detected = this.detector.detect(input.cwd);

    if (configured !== 'auto') {
      if (!detected) {
        return {
          type: configured,
          platforms: configured === 'ios' ? ['ios'] : configured === 'android' ? ['android'] : ['ios', 'android'],
          paths: { root: input.cwd },
        };
      }
      return { ...detected, type: configured };
    }

    if (!detected) {
      throw new ValidationError(`Could not detect project type in ${input.cwd}`, {
        hint: 'Expected pubspec.yaml, package.json with ios/android dirs, *.xcodeproj, or settings.gradle. Or set project.type explicitly in caricamento.config.ts.',
      });
    }
    return detected;
  }
}
