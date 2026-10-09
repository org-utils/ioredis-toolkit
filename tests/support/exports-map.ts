import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** Where the exports map sends an import of one path: the declarations, and the code they describe. */
interface ExportTarget { types: string; import: string; }

export const root = fileURLToPath(new URL('../..', import.meta.url));
export const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { name: string; main: string; types: string; files: string[]; exports: Record<string, string | ExportTarget> };

/** What the exports map makes importable, other than the manifest itself: the root, and a subpath per module. */
export const exported = Object.entries(manifest.exports).filter((entry): entry is [string, ExportTarget] => typeof entry[1] !== 'string');
/** The specifier a consumer writes for each: the package name, alone or followed by a subpath. */
export const specifiers = exported.map(([subpath]) => path.posix.join(manifest.name, subpath));
export const subpathSpecifiers = specifiers.filter(specifier => specifier !== manifest.name);

export const rootBarrel = path.join(root, 'src', 'index.ts');

/** The entry point of the module a subpath is named for. */
export function entryPointOf(specifier: string): string {
  return path.join(root, 'src', specifier.slice(manifest.name.length + 1), 'index.ts');
}

/** The source file a specifier is built from: the root barrel for the package name, a module's entry point for a subpath. */
export function sourceOf(specifier: string): string {
  return specifier === manifest.name ? rootBarrel : entryPointOf(specifier);
}

/** A program over `files` under the package's own compiler options, so its name resolves through the exports map to the source each target is built from. */
export function packageProgram(files: string[]): ts.Program {
  const { options } = ts.getParsedCommandLineOfConfigFile(path.join(root, 'tsconfig.json'), { noEmit: true }, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')); } })!;
  return ts.createProgram(files, options);
}

/** Every name a source file exports, runtime value or type alone, with the declaration each resolves to. */
export function exportsOf(program: ts.Program, file: string): Map<string, ts.Symbol> {
  const checker = program.getTypeChecker();
  return new Map(
    checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(file)!)!)
      .map(symbol => [symbol.name, symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol]),
  );
}
