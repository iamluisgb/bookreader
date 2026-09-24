// Config flat mínima de ESLint. Cubre el código de la app (módulos ES en browser)
// y el service worker. Los .ts (playwright) se ignoran: necesitarían el parser de
// TypeScript y no es el objetivo aquí.
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'app/vendor/**',
      'node_modules/**',
      'mcp/node_modules/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['app/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ePub: 'readonly', // epub.js (global vendorizado)
      },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // markdown.js usa NUL (\x00) como centinela de bloques de código: es intencionado.
      'no-control-regex': 'off',
    },
  },
  {
    files: ['sw.js', 'app/sw.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.serviceworker },
    },
  },
  {
    // Scripts de evals (EV1) y utilidades: Node ESM.
    files: ['evals/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    // MCP local (P28): Node ESM puro, sin DOM, y con una regla que no se puede romper:
    // stdout es el canal del protocolo, así que aquí no hay console.log que valga.
    files: ['mcp/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
];
