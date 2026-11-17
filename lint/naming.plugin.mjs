const CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/u
const INTERFACE_NAME = /^I[A-Z][a-zA-Z0-9]*$/u
const TYPE_PARAMETER_NAME = /^T[A-Z][a-zA-Z]+$/u
const BOOLEAN_NAME = /^(?:is|should|has|can|did|will|expected|does)[A-Z][a-zA-Z0-9]*$/u

const BOOLEAN_METHODS = new Set([
  'includes',
  'startsWith',
  'endsWith',
  'some',
  'every',
  'test',
  'isArray',
  'isInteger',
  'isFinite',
  'isNaN',
  'isSafeInteger',
  'hasOwn',
  'hasOwnProperty',
])

const COMPARISON_OPERATORS = new Set(['===', '!==', '==', '!=', '<', '>', '<=', '>=', 'instanceof', 'in'])

const identifierName = (node) => (node.type === 'Identifier' ? node.name : null)

const isBooleanCall = (callee) =>
  callee.type === 'Identifier'
    ? callee.name === 'Boolean'
    : callee.type === 'MemberExpression' && !callee.computed && BOOLEAN_METHODS.has(identifierName(callee.property))

const isBooleanInitializer = (initializer) => {
  switch (initializer?.type) {
    case 'Literal':
      return typeof initializer.value === 'boolean'
    case 'UnaryExpression':
      return initializer.operator === '!'
    case 'BinaryExpression':
      return COMPARISON_OPERATORS.has(initializer.operator)
    case 'CallExpression':
      return isBooleanCall(initializer.callee)
    default:
      return false
  }
}

const isBooleanVariable = ({ id, init }) =>
  id.typeAnnotation ? id.typeAnnotation.typeAnnotation.type === 'TSBooleanKeyword' : isBooleanInitializer(init)

const declarationNaming = {
  meta: {
    messages: {
      interfaceName: "Interface '{{name}}' must be PascalCase and start with 'I' (e.g. IUserRepository).",
      typeParameterName: "Type parameter '{{name}}' must match ^T[A-Z][a-zA-Z]+$ (e.g. TEntity, TResult).",
      privateMember: "Private member '{{name}}' must be camelCase without a leading underscore.",
    },
  },
  create: (context) => {
    const check = (node, name, pattern, messageId) => {
      if (name !== null && !pattern.test(name)) {
        context.report({ node, messageId, data: { name } })
      }
    }

    const checkPrivateMember = (node, nameNode) => {
      if (node.accessibility === 'private' && !node.computed) {
        check(nameNode, identifierName(nameNode), CAMEL_CASE, 'privateMember')
      }
    }

    return {
      TSInterfaceDeclaration: ({ id }) => check(id, identifierName(id), INTERFACE_NAME, 'interfaceName'),
      TSTypeParameter: (node) => check(node, identifierName(node.name), TYPE_PARAMETER_NAME, 'typeParameterName'),
      PropertyDefinition: (node) => checkPrivateMember(node, node.key),
      MethodDefinition: (node) => checkPrivateMember(node, node.key),
      TSParameterProperty: (node) =>
        checkPrivateMember(node, node.parameter.type === 'AssignmentPattern' ? node.parameter.left : node.parameter),
    }
  },
}

const booleanPrefix = {
  meta: {
    messages: {
      booleanName:
        "Boolean variable '{{name}}' must start with is/should/has/can/did/will/expected/does followed by PascalCase (e.g. isValid, hasAccess).",
    },
  },
  create: (context) => ({
    VariableDeclarator: (node) => {
      const { id } = node
      if (id.type === 'Identifier' && !BOOLEAN_NAME.test(id.name) && isBooleanVariable(node)) {
        context.report({ node: id, messageId: 'booleanName', data: { name: id.name } })
      }
    },
  }),
}

export default {
  meta: { name: 'naming' },
  rules: {
    'declaration-naming': declarationNaming,
    'boolean-prefix': booleanPrefix,
  },
}
