import { readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import { entryPointOf, exported, exportsOf, manifest, packageProgram, root, rootBarrel, specifiers, subpathSpecifiers } from '../support/exports-map.js';

/** The consumer written against one specifier: tests/consumer/<subpath>.ts, or root.ts for the root. */
function consumerOf(specifier: string): string {
  return path.join(root, 'tests', 'consumer', `${specifier === manifest.name ? 'root' : specifier.slice(manifest.name.length + 1)}.ts`);
}

describe('subpaths', () => {
  let program: ts.Program;

  /** The source file a consumer's import of a specifier resolves to. */
  function resolve(specifier: string): string | undefined {
    const resolved = ts.resolveModuleName(specifier, consumerOf(specifier), program.getCompilerOptions(), ts.sys, undefined, undefined, ts.ModuleKind.ESNext).resolvedModule?.resolvedFileName;
    return resolved && path.normalize(resolved);
  }

  beforeAll(() => {
    program = packageProgram(readdirSync(path.join(root, 'tests', 'consumer')).map(file => path.join(root, 'tests', 'consumer', file)));
  }, 60_000);

  it('the package name alone resolves to the root barrel', () => {
    expect(resolve(manifest.name)).toBe(rootBarrel);
  });

  it.each(subpathSpecifiers)('%s resolves to the entry point of the module it is named for', specifier => {
    expect(resolve(specifier)).toBe(entryPointOf(specifier));
  });

  it.each(exported)('%s names one file for its types and for the code they describe', (_subpath, target) => {
    expect(target.import).toBe(target.types.replace(/\.d\.ts$/, '.js'));
  });

  it.each(subpathSpecifiers)('the root barrel re-exports every name %s exports', specifier => {
    const barrel = exportsOf(program, rootBarrel);
    const missing = [...exportsOf(program, entryPointOf(specifier))].filter(([name, declared]) => barrel.get(name) !== declared).map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it.each(specifiers)('a consumer of %s compiles importing from it alone', specifier => {
    const consumer = program.getSourceFile(consumerOf(specifier));
    expect(consumer, `no consumer is written against ${specifier}`).toBeDefined();
    expect(ts.preProcessFile(consumer!.text).importedFiles.map(imported => imported.fileName).filter(imported => imported !== specifier)).toEqual([]);
    // Syntactic and semantic diagnostics only: a consumer sits outside rootDir, which matters to emit and nothing is emitted.
    const diagnostics = [...program.getSyntacticDiagnostics(consumer), ...program.getSemanticDiagnostics(consumer)];
    expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  });
});
