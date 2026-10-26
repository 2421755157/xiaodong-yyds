export default [
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        window: 'readonly', document: 'readonly', console: 'readonly',
        localStorage: 'readonly', sessionStorage: 'readonly', location: 'readonly',
        navigator: 'readonly', performance: 'readonly', fetch: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly', Image: 'readonly', URLSearchParams: 'readonly',
        URL: 'readonly', Blob: 'readonly', FileReader: 'readonly', MutationObserver: 'readonly',
        IntersectionObserver: 'readonly', ResizeObserver: 'readonly', WebSocket: 'readonly',
        THREE: 'readonly', matchMedia: 'readonly', history: 'readonly',
        alert: 'readonly', confirm: 'readonly', prompt: 'readonly',
        atob: 'readonly', btoa: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly',
        queueMicrotask: 'readonly', structuredClone: 'readonly',
        innerWidth: 'readonly', innerHeight: 'readonly', outerWidth: 'readonly',
        outerHeight: 'readonly', devicePixelRatio: 'readonly', addEventListener: 'readonly',
        removeEventListener: 'readonly', dispatchEvent: 'readonly',
        requestIdleCallback: 'readonly', scrollTo: 'readonly', scrollBy: 'readonly',
        getComputedStyle: 'readonly', customElements: 'readonly', crypto: 'readonly',
        process: 'readonly', Buffer: 'readonly', __dirname: 'readonly',
        AbortController: 'readonly', AbortSignal: 'readonly', FormData: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'after-used', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-undef': 'warn',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-var': 'error',
      'prefer-const': 'warn',
      'eqeqeq': ['warn', 'smart'],
      'no-self-compare': 'warn',
      'no-async-promise-executor': 'error',
      'no-return-await': 'error',
      'no-cond-assign': 'error',
      'no-constant-condition': ['warn', { checkLoops: false }]
    }
  }
];
