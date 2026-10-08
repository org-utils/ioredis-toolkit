import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';

const root = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(root, 'src');
const kernelDir = path.join(srcDir, 'redis');
const packageName = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).name;

/** The literal module specifier a source node carries, or undefined when it is not statically known. */
function specifierOf(source) {
  return source.type === 'Literal' ? source.value
    : source.type === 'TemplateLiteral' && source.expressions.length === 0 ? source.quasis[0].value.cooked
    : undefined;
}

/** A visitor calling `check` on the source of every static form a module specifier takes: import, export-from, import(), import() types and import-equals. */
function specifierVisitor(check) {
  return {
    ImportDeclaration: node => check(node.source),
    ExportNamedDeclaration: node => check(node.source),
    ExportAllDeclaration: node => check(node.source),
    ImportExpression: node => check(node.source, true),
    TSImportType: node => check(node.source ?? node.argument?.literal),
    TSExternalModuleReference: node => check(node.expression)
  };
}

/**
 * The kernel never knows what is built on top of it (CONTEXT.md). Reports any module
 * specifier in a kernel file that resolves outside src/redis or names this package,
 * in every static form: import, export-from, import(), import() types and import-equals.
 */
const kernelBoundary = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      outside: 'The kernel never knows what is built on top of it: "{{specifier}}" resolves outside src/redis.',
      unchecked: 'import() in the kernel needs a literal specifier so the kernel boundary can be checked.'
    }
  },
  create(context) {
    const fromDir = path.dirname(context.filename);
    return specifierVisitor((source, dynamic = false) => {
      if (!source) return;
      const specifier = specifierOf(source);
      if (typeof specifier !== 'string') {
        if (dynamic) context.report({ node: source, messageId: 'unchecked' });
        return;
      }
      const fromKernel = path.relative(kernelDir, path.resolve(fromDir, specifier));
      const outside = specifier.startsWith('.')
        ? fromKernel.startsWith('..') || path.isAbsolute(fromKernel)
        : specifier === packageName || specifier.startsWith(`${packageName}/`);
      if (outside) context.report({ node: source, messageId: 'outside', data: { specifier } });
    });
  }
};

/**
 * Every module has exactly one entry point, src/<module>/index.ts, and a module is imported through it.
 * Reports a specifier that reaches into another module past its entry point; one that reaches a module's
 * entry point from inside that module, or the root barrel or client facade from inside any module, either
 * of which would close an import cycle; and one that names this package, which resolves around the rule.
 */
const entryPoint = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      past: 'Every module has one entry point: "{{specifier}}" reaches past {{module}}/index.js.',
      own: 'A module\'s own files import each other directly: "{{specifier}}" is the entry point of the module this file is in.',
      above: 'A module never imports what is built on top of it: "{{specifier}}" sits above the modules.',
      selfName: 'Source files import each other by relative path: "{{specifier}}" names this package.',
      unchecked: 'import() needs a literal specifier so that entry points can be checked.'
    }
  },
  create(context) {
    /** The module a file under src/<module>/ belongs to; undefined for a file directly in src. */
    const moduleOf = file => {
      const [module, ...rest] = path.relative(srcDir, file).split(path.sep);
      return rest.length ? module : undefined;
    };
    const fromModule = moduleOf(context.filename);
    return specifierVisitor((source, dynamic = false) => {
      if (!source) return;
      const specifier = specifierOf(source);
      if (typeof specifier !== 'string') {
        if (dynamic) context.report({ node: source, messageId: 'unchecked' });
        return;
      }
      if (specifier === packageName || specifier.startsWith(`${packageName}/`)) {
        context.report({ node: source, messageId: 'selfName', data: { specifier } });
        return;
      }
      if (!specifier.startsWith('.')) return;
      const target = path.resolve(path.dirname(context.filename), specifier);
      const inSrc = path.relative(srcDir, target);
      if (inSrc.startsWith('..') || path.isAbsolute(inSrc)) return;
      const toModule = moduleOf(target);
      if (toModule === undefined) {
        if (fromModule !== undefined) context.report({ node: source, messageId: 'above', data: { specifier } });
        return;
      }
      const isEntryPoint = target === path.join(srcDir, toModule, 'index.js');
      if (toModule !== fromModule && !isEntryPoint) context.report({ node: source, messageId: 'past', data: { specifier, module: toModule } });
      if (toModule === fromModule && isEntryPoint) context.report({ node: source, messageId: 'own', data: { specifier } });
    });
  }
};

const boundaries = { rules: { kernel: kernelBoundary, 'entry-point': entryPoint } };

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'error'
    }
  },
  {
    files: ['src/**/*.ts'],
    plugins: { boundaries },
    rules: {
      'boundaries/entry-point': 'error'
    }
  },
  {
    files: ['src/redis/**/*.ts'],
    plugins: { boundaries },
    rules: {
      'boundaries/kernel': 'error'
    }
  },
  {
    files: ['src/index.ts', 'src/*/index.ts'],
    rules: {
      'no-restricted-syntax': ['error', { selector: 'ExportAllDeclaration', message: 'The root barrel and every entry point list each name they export: a wildcard makes adding a public name an accident.' }]
    }
  }
);
