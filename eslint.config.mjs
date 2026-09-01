import globals from 'globals';

export default [
  {
    // public/ is loaded as a classic <script> (index.html), NOT a module —
    // sourceType 'script' is what makes ESLint resolve top-level function
    // declarations against each other the way the browser actually does.
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: { ...globals.browser },
    },
    rules: { 'no-undef': 'error', 'no-unused-vars': 'warn' },
  },
  {
    files: ['server/**/*.js', 'scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: { 'no-undef': 'error', 'no-unused-vars': 'warn' },
  },
];
