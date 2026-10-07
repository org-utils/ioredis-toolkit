import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';

const root = path.dirname(fileURLToPath(import.meta.url));
const kernelDir = path.join(root, 'src', 'redis');
const packageName = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).name;

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
    const check = (source, dynamic = false) => {
      if (!source) return;
      const specifier = source.type === 'Literal' ? source.value
        : source.type === 'TemplateLiteral' && source.expressions.length === 0 ? source.quasis[0].value.cooked
        : undefined;
      if (typeof specifier !== 'string') {
        if (dynamic) context.report({ node: source, messageId: 'unchecked' });
        return;
      }
      const fromKernel = path.relative(kernelDir, path.resolve(fromDir, specifier));
      const outside = specifier.startsWith('.')
        ? fromKernel.startsWith('..') || path.isAbsolute(fromKernel)
        : specifier === packageName || specifier.startsWith(`${packageName}/`);
      if (outside) context.report({ node: source, messageId: 'outside', data: { specifier } });
    };
    return {
      ImportDeclaration: node => check(node.source),
      ExportNamedDeclaration: node => check(node.source),
      ExportAllDeclaration: node => check(node.source),
      ImportExpression: node => check(node.source, true),
      TSImportType: node => check(node.source ?? node.argument?.literal),
      TSExternalModuleReference: node => check(node.expression)
    };
  }
};

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
    files: ['src/redis/**/*.ts'],
    plugins: { boundaries: { rules: { kernel: kernelBoundary } } },
    rules: {
      'boundaries/kernel': 'error'
    }
  }
);
