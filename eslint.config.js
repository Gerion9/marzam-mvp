const js = require('@eslint/js');

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        // CommonJS
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        // Node runtime
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        global: 'readonly',
        globalThis: 'readonly',
        // Timers (Node + browser)
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        queueMicrotask: 'readonly',
        // Web platform globals available in Node 18+
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        Blob: 'readonly',
        FormData: 'readonly',
      },
    },
    rules: {
      // argsIgnorePattern lets you keep `function foo(_unused, used)`.
      // caughtErrorsIgnorePattern lets you keep `catch (_err)` blocks where
      // the error is intentionally ignored.
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-console': 'off',
    },
  },
  {
    ignores: ['node_modules/**', 'src/public/**'],
  },
];
