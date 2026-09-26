import { formatReleaseNotes } from '../../core/changelog/index.js';
import type { ChangelogConfig } from '../../core/config/schema.js';
import { ValidationError } from '../../core/errors.js';
import type { ChangelogProvider, ProcessRunner } from '../../core/ports/index.js';

/**
 * Release notes from the target project's git history (SPEC §7): commits
 * since the last tag (`git describe --tags --abbrev=0`), or the last
 * `maxCommits` when the repo has no tags. Merges are excluded.
 */
export class GitChangelogProvider implements ChangelogProvider {
  readonly name = 'git';

  constructor(
    private readonly processes: ProcessRunner,
    private readonly config: ChangelogConfig,
  ) {}

  async generateReleaseNotes(cwd: string): Promise<string> {
    const git = await this.processes.which('git');
    if (!git) {
      throw new ValidationError('changelog.source is "git" but git was not found', {
        hint: 'Install git, or remove the changelog block from caricamento.config.ts.',
      });
    }

    const tag = await this.processes.run(git, ['describe', '--tags', '--abbrev=0'], { cwd });
    if (tag.exitCode !== 0 && !tag.stderr.includes('No names found') && !(await this.isGitRepo(git, cwd))) {
      throw new ValidationError(`changelog.source is "git" but ${cwd} is not a git repository`, {
        hint: 'Run the command from the project repository, or remove the changelog block from the config.',
      });
    }

    const range = tag.exitCode === 0 ? [`${tag.stdout.trim()}..HEAD`] : ['-n', String(this.config.maxCommits)];
    const log = await this.processes.run(git, ['log', '--no-merges', '--format=%s', ...range], { cwd });
    if (log.exitCode !== 0) {
      throw new ValidationError('git log failed while generating release notes', {
        hint: 'Check that the project repository has at least one commit.',
        context: { stderr: log.stderr.trim() },
      });
    }

    const notes = formatReleaseNotes(log.stdout.split('\n'));
    if (!notes) {
      throw new ValidationError('git log produced no commits for release notes', {
        hint: tag.exitCode === 0
          ? `No commits since tag ${tag.stdout.trim()} — pass --release-notes or tag an older release.`
          : 'The repository has no commits yet.',
      });
    }
    return notes;
  }

  private async isGitRepo(git: string, cwd: string): Promise<boolean> {
    const result = await this.processes.run(git, ['rev-parse', '--is-inside-work-tree'], { cwd });
    return result.exitCode === 0;
  }
}
