import js from '@eslint/js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'eslint/config';
import tseslint, { type CompatiblePlugin } from 'typescript-eslint';
import { noBrandAssertions } from './tools/eslint/no-brand-assertions.ts';
import { noComments } from './tools/eslint/no-comments.ts';

if (existsSync(join(import.meta.dirname, 'eslint-suppressions.json'))) {
  throw new Error('eslint-suppressions.json silences lint errors, which AGENTS.md rule B2 forbids. Delete it and fix the errors, or change the rule in its own PR.');
}

const rules = { 'no-comments': noComments, 'no-brand-assertions': noBrandAssertions };

const plugin = { meta: { name: 'autoworker' }, rules };

const autoworker: CompatiblePlugin = plugin;

const importSource = ':matches(ImportDeclaration, ExportAllDeclaration, ExportNamedDeclaration, ImportExpression)';
const importByJsName = 'Import the .ts file by its .ts name. Node runs .ts files directly and cannot find a .js name that only tsc resolves.';

const restrictedImports = [
  { selector: `${importSource}[source.value=/^\\..*\\.[cm]?js$/]`, message: importByJsName },
  { selector: 'ImportExpression > TemplateLiteral.source', message: 'Write an import path as a plain string, so the import rules can read it.' },
  { selector: `${importSource}[source.value=/\\.claude/]`, message: 'Product code never imports from .claude/, which holds agent tooling that lint does not check.' },
];

const ticketKeyText = '/\\[A-Z\\]\\[A-Z0-9_\\]\\*-\\\\d\\+/';

const ticketKeyCopy = {
  selector: `:matches(Literal[regex.pattern=${ticketKeyText}], Literal[value=${ticketKeyText}], TemplateElement[value.raw=${ticketKeyText}])`,
  message: 'Import ticket from shared/actions.ts, which holds the one ticket-key rule, in place of a copy of its pattern.',
};

export default defineConfig(
  { ignores: ['.claude/**'] },
  {
    files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked],
    plugins: { autoworker },
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
      'no-restricted-syntax': ['error', ...restrictedImports, ticketKeyCopy],
      'autoworker/no-comments': 'error',
      'autoworker/no-brand-assertions': 'error',
    },
  },
  {
    files: ['shared/actions.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...restrictedImports],
    },
  },
);
