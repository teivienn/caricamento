import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ValidationError } from '../../core/errors.js';
import type { ProjectRegistry, RegisteredProject } from '../../core/ports/index.js';

const NAME_PATTERN = /^[a-z0-9][a-z0-9-_]*$/i;

/**
 * JSON-backed project registry at ~/.caricamento/registry.json.
 * Per-project configs live alongside at ~/.caricamento/projects/<name>.config.ts,
 * so a target project never has to carry caricamento files.
 */
export class JsonProjectRegistry implements ProjectRegistry {
  private readonly file: string;

  constructor(private readonly baseDir: string = join(homedir(), '.caricamento')) {
    this.file = join(baseDir, 'registry.json');
  }

  configPathFor(name: string): string {
    return join(this.baseDir, 'projects', `${name}.config.ts`);
  }

  /** Per-project .env next to the registry config (SPEC §3.5). */
  envPathFor(name: string): string {
    return join(this.baseDir, 'projects', `${name}.env`);
  }

  async list(): Promise<RegisteredProject[]> {
    const data = await this.read();
    return Object.values(data).sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(name: string): Promise<RegisteredProject | null> {
    return (await this.read())[name] ?? null;
  }

  async add(project: RegisteredProject): Promise<void> {
    if (!NAME_PATTERN.test(project.name)) {
      throw new ValidationError(`Invalid project name "${project.name}"`, {
        hint: 'Use letters, digits, dashes and underscores, starting with a letter or digit.',
      });
    }
    if (!existsSync(project.path)) {
      throw new ValidationError(`Project path does not exist: ${project.path}`);
    }
    const data = await this.read();
    if (data[project.name]) {
      throw new ValidationError(`Project "${project.name}" is already registered`, {
        hint: 'Use `caricamento projects remove` first, or pick another name.',
      });
    }
    data[project.name] = { ...project, path: resolve(project.path) };
    await this.write(data);
  }

  async remove(name: string): Promise<void> {
    const data = await this.read();
    if (!data[name]) {
      throw new ValidationError(`Project "${name}" is not registered`);
    }
    delete data[name];
    await this.write(data);
  }

  private async read(): Promise<Record<string, RegisteredProject>> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (raw && typeof raw === 'object' && 'projects' in raw) {
        return (raw as { projects: Record<string, RegisteredProject> }).projects;
      }
      return {};
    } catch {
      return {};
    }
  }

  private async write(data: Record<string, RegisteredProject>): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify({ projects: data }, null, 2) + '\n', 'utf8');
    await rename(tmp, this.file);
  }
}
