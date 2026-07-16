import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'build/**', 'node_modules/**', 'lib.js', 'main.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Source: strict TypeScript.
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // Harness scripts + build config: plain JS/TS run under Node.
    files: ['scripts/**/*.js', '*.config.ts', '*.config.js'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': 'off',
    },
  },
  prettier
);
