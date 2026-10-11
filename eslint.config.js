import js from '@eslint/js';
import globals from 'globals';
import vitest from '@vitest/eslint-plugin';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', 'dist/', 'src/worker-configuration.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  { files: ['scripts/**/*.mjs'], languageOptions: { globals: globals.node } },
  {
    files: ['src/**/*.test.ts'],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      // Issue #20: an assertion inside catch passes silently when nothing is thrown.
      'vitest/no-conditional-expect': 'error',
      'vitest/no-conditional-in-test': 'error',
    },
  },
);
