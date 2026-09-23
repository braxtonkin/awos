import type { Rule } from 'eslint';

const referenceDirective = /^\/\s*<reference\s+(?:path|types|lib)="[^"]*"\s*\/>\s*$/;

export const noComments: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Reject code comments, as AGENTS.md rule B1 requires' },
    messages: {
      comment:
        'AGENTS.md rule B1 forbids comments. Restructure the code so names and types carry the meaning, or open an issue for a workaround.',
    },
    schema: [],
  },
  create(context) {
    const { sourceCode, filename } = context;
    const isTypeDeclaration = filename.endsWith('.d.ts');
    const firstToken = sourceCode.ast.tokens[0];
    const beforeCode = (end: number): boolean => firstToken === undefined || end <= firstToken.range[0];
    return {
      Program() {
        for (const comment of sourceCode.getAllComments()) {
          const [start, end] = comment.range ?? [-1, -1];
          const isShebang = start === 0 && sourceCode.text.startsWith('#!');
          const isReference = isTypeDeclaration && comment.type === 'Line' && referenceDirective.test(comment.value) && beforeCode(end);
          if (!isShebang && !isReference && comment.loc) {
            context.report({ loc: comment.loc, messageId: 'comment' });
          }
        }
      },
    };
  },
};
