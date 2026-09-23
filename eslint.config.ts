import js from '@eslint/js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

if (existsSync(join(import.meta.dirname, 'eslint-suppressions.json'))) {
  throw new Error('eslint-suppressions.json silences lint errors, which AGENTS.md rule B2 forbids. Delete it and fix the errors, or change the rule in its own PR.');
}

const importSource = ':matches(ImportDeclaration, ExportAllDeclaration, ExportNamedDeclaration, ImportExpression)';
const importByJsName = 'Import the .ts file by its .ts name. Node runs .ts files directly and cannot find a .js name that only tsc resolves.';

export default defineConfig(
  { ignores: ['.claude/**'] },
  {
    files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      noInlineConfig: true,
    },
    rules: {
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-expect-error': true, 'ts-ignore': true, 'ts-nocheck': true }],
      'no-warning-comments': ['error', { terms: ['@ts-'], location: 'anywhere' }],
      'no-restricted-syntax': [
        'error',
        { selector: `${importSource}[source.value=/^\\..*\\.[cm]?js$/]`, message: importByJsName },
        { selector: 'ImportExpression > TemplateLiteral.source', message: 'Write an import path as a plain string, so the import rules can read it.' },
        { selector: `${importSource}[source.value=/\\.claude/]`, message: 'Product code never imports from .claude/, which holds agent tooling that lint does not check.' },
      ],
    },
  },
);
