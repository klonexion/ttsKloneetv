import js from '@eslint/js';
import globals from 'globals';

/**
 * ESLint 9 (flat config) para el backend. JS puro con módulos ES.
 * Las tareas siguientes añaden archivos bajo `src/`; no hace falta tocar esto.
 */
export default [
  {
    ignores: ['node_modules/**', 'data/**', 'vendor/**', 'logs/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
    },
  },
];
