import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import pickle from './eslint-plugin-pickle/index.js';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { pickle },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-control-regex': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'preserve-caught-error': 'off',
      'pickle/no-raw-state-write': 'error',
      'pickle/cli-guard-basename': 'error',
      'pickle/hook-decision-values': 'error',
      'pickle/no-unsafe-error-cast': 'error',
      'pickle/no-gemini-path': 'error',
      'pickle/no-deployed-file-edit': 'error',
      'pickle/require-number-validation': 'error',
      'pickle/no-process-exit-in-library': 'error',
      'pickle/promise-token-format': 'error',
      'pickle/no-sync-in-async': 'warn',
      'pickle/spawn-error-handler': 'error',
      'pickle/no-hardcoded-timeout': 'error',
    },
  },
  {
    ignores: ['bin/**', 'services/**', 'tests/**', '*.js', 'eslint.config.js', 'eslint-plugin-pickle/**'],
  },
);
