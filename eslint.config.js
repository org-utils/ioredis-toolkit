import tseslint from 'typescript-eslint';

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
    // The kernel never knows what is built on top of it (CONTEXT.md, ADR-0001).
    files: ['src/redis/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ regex: '^\\.\\./', message: 'The kernel imports nothing from outside src/redis.' }] }]
    }
  }
);
