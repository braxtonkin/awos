import { AST_NODE_TYPES, ESLintUtils, type TSESTree } from '@typescript-eslint/utils';
import ts from 'typescript';

type Asserted = TSESTree.TSAsExpression | TSESTree.TSTypeAssertion;

const isConstAssertion = (node: Asserted): boolean =>
  node.typeAnnotation.type === AST_NODE_TYPES.TSTypeReference && node.typeAnnotation.typeName.type === AST_NODE_TYPES.Identifier && node.typeAnnotation.typeName.name === 'const';

function brandKeys(checker: ts.TypeChecker, program: ts.Program, type: ts.Type): ReadonlySet<string> {
  const keys = checker
    .getPropertiesOfType(checker.getApparentType(type))
    .filter(property => {
      const name = property.getEscapedName().toString();
      const declared = property.declarations ?? [];
      return name.startsWith('__@') && declared.length > 0 && declared.every(declaration => !program.isSourceFileDefaultLibrary(declaration.getSourceFile()));
    })
    .map(property => property.getEscapedName().toString());
  return new Set(keys);
}

export const noBrandAssertions = ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: 'problem',
    messages: {
      predicate:
        'This type predicate narrows a value to {{type}}, which carries a brand, without proving it. Only the function that owns a brand may add it, so parse the value with the zod schema that declares the brand instead.',
      minted:
        'This type assertion makes a {{type}} that the value was not proven to be, and {{type}} carries a brand. Only the function that owns a brand may add it, so call that function, such as the zod schema that declares the brand, instead of asserting.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    const check = (node: Asserted): void => {
      if (isConstAssertion(node)) return;
      const target = services.getTypeAtLocation(node);
      const source = services.getTypeAtLocation(node.expression);
      const had = brandKeys(checker, services.program, source);
      const minted = [...brandKeys(checker, services.program, target)].filter(key => !had.has(key));
      if (minted.length > 0) context.report({ node, messageId: 'minted', data: { type: checker.typeToString(target) } });
    };
    const checkPredicate = (node: TSESTree.TSTypePredicate): void => {
      const owner = node.parent.parent;
      if (owner === undefined || node.typeAnnotation === null || node.parameterName.type !== AST_NODE_TYPES.Identifier || !('params' in owner)) return;
      const named = node.parameterName.name;
      const parameter = owner.params.find(param => param.type === AST_NODE_TYPES.Identifier && param.name === named);
      const target = services.getTypeAtLocation(node.typeAnnotation.typeAnnotation);
      const had = parameter === undefined ? new Set<string>() : brandKeys(checker, services.program, services.getTypeAtLocation(parameter));
      if ([...brandKeys(checker, services.program, target)].some(key => !had.has(key))) context.report({ node, messageId: 'predicate', data: { type: checker.typeToString(target) } });
    };
    return { TSAsExpression: check, TSTypeAssertion: check, TSTypePredicate: checkPredicate };
  },
});
