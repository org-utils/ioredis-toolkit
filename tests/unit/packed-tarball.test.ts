import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { manifest, root } from '../support/exports-map.js';

/** What a checkout does not carry: installed dependencies, the repository itself, and the output of an earlier build. */
const notCheckedOut = new Set(['node_modules', '.git', 'dist']);

/** Every file the manifest sends a consumer's import to: `main`, `types`, and each target in the exports map. */
const pointedAt = [...new Set([manifest.main, manifest.types, ...Object.values(manifest.exports).flatMap(target => typeof target === 'string' ? [target] : Object.values(target))])];

describe('packed tarball', () => {
  let checkout: string;
  /** Every path in the tarball, relative to the package root. */
  let packed: string[];

  function run(command: string, ...args: string[]): string {
    return execFileSync(command, args, { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }

  /** The packed paths one entry of the manifest's `files` accounts for: the file it names, or everything under the directory it names. */
  function publishedBy(entry: string): string[] {
    return packed.filter(file => file === entry || file.startsWith(`${entry}/`));
  }

  // The tarball of a release: a copy of the working tree with nothing built in it, the manifest's own build, then a pack.
  beforeAll(() => {
    checkout = mkdtempSync(path.join(tmpdir(), 'packed-tarball-'));
    cpSync(root, checkout, { recursive: true, filter: source => !notCheckedOut.has(path.relative(root, source)) });
    symlinkSync(path.join(root, 'node_modules'), path.join(checkout, 'node_modules'));
    run('npm', 'run', 'build');
    const [tarball] = JSON.parse(run('npm', 'pack', '--dry-run', '--json', '--ignore-scripts')) as [{ files: { path: string }[] }];
    packed = tarball.files.map(file => file.path);
  }, 120_000);

  afterAll(() => {
    rmSync(checkout, { recursive: true, force: true });
  });

  it.each(manifest.files)('%s, which the manifest publishes, is in the tarball', entry => {
    expect(publishedBy(entry)).not.toEqual([]);
  });

  it('holds nothing but the manifest and what it publishes', () => {
    const published = new Set(['package.json', ...manifest.files.flatMap(publishedBy)]);
    expect(packed.filter(file => !published.has(file))).toEqual([]);
  });

  it.each(pointedAt)('%s, which the manifest points a consumer at, is in the tarball', target => {
    expect(packed).toContain(path.posix.normalize(target));
  });
});
