import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { name: string; exports: Record<string, { types: string; import: string }> };

/** What the exports map makes importable, other than the manifest itself: the root, and a subpath per module. */
const exported = Object.entries(manifest.exports).filter(([subpath]) => subpath !== './package.json');
/** The specifier a consumer writes for each: the package name, alone or followed by a subpath. */
const specifiers = exported.map(([subpath]) => path.posix.join(manifest.name, subpath));
const subpathSpecifiers = specifiers.filter(specifier => specifier !== manifest.name);

const rootBarrel = path.join(root, 'src', 'index.ts');

/** The consumer written against one specifier: tests/consumer/<subpath>.ts, or root.ts for the root. */
function consumerOf(specifier: string): string {
  return path.join(root, 'tests', 'consumer', `${specifier === manifest.name ? 'root' : specifier.slice(manifest.name.length + 1)}.ts`);
}

/** The entry point of the module a subpath is named for. */
function entryPointOf(specifier: string): string {
  return path.join(root, 'src', specifier.slice(manifest.name.length + 1), 'index.ts');
}

describe('subpaths', () => {
  let program: ts.Program;

  /** The source file a consumer's import of a specifier resolves to. */
  function resolve(specifier: string): string | undefined {
    const resolved = ts.resolveModuleName(specifier, consumerOf(specifier), program.getCompilerOptions(), ts.sys, undefined, undefined, ts.ModuleKind.ESNext).resolvedModule?.resolvedFileName;
    return resolved && path.normalize(resolved);
  }

  beforeAll(() => {
    // The package's own compiler options, so its name resolves through the exports map to the source each target is built from.
    const { options } = ts.getParsedCommandLineOfConfigFile(path.join(root, 'tsconfig.json'), { noEmit: true }, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')); } })!;
    program = ts.createProgram(readdirSync(path.join(root, 'tests', 'consumer')).map(file => path.join(root, 'tests', 'consumer', file)), options);
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
    const checker = program.getTypeChecker();
    const exportsOf = (file: string): Map<string, ts.Symbol> => new Map(
      checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(file)!)!)
        .map(symbol => [symbol.name, symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol]),
    );
    const barrel = exportsOf(rootBarrel);
    const missing = [...exportsOf(entryPointOf(specifier))].filter(([name, declared]) => barrel.get(name) !== declared).map(([name]) => name);
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
