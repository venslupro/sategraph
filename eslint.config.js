import parser from '@typescript-eslint/parser';

export default [{
  files: ['{src,scripts,tests}/**/*.{js,ts,tsx}', 'eslint.config.js'],
  languageOptions: {parser},
  rules: {
    curly: ['error', 'all'],
    'one-var': ['error', 'never'],
    'no-var': 'error',
    'prefer-const': 'error',
  },
}];
