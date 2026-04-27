import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'apps/dashboard/dist/**',
      'runners/*/dist/**',
      'runners/*/node_modules/**',
      'store/**',
      'store-*/**',
      'data/**',
      'data-*/**',
      'coverage/**',
      'tmp/**',
      'cache/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2022,
        Bun: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-empty-object-type': 'warn',
      complexity: ['warn', { max: 35 }],
      'max-depth': ['warn', 5],
      'max-lines-per-function': [
        'warn',
        {
          max: 180,
          skipBlankLines: true,
          skipComments: true,
        },
      ],
      'max-params': ['warn', 7],
      'no-case-declarations': 'warn',
      'no-console': 'off',
      'no-control-regex': 'off',
      'no-unsafe-finally': 'warn',
      'no-useless-assignment': 'warn',
      'no-useless-escape': 'warn',
      'preserve-caught-error': 'warn',
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'scripts/**/*.ts'],
    rules: {
      'max-lines-per-function': 'off',
    },
  },
);
