/**
 * eslint-plugin-pickle — architectural lint rules for Pickle Rick.
 *
 * Rules:
 *   pickle/no-raw-state-write    — must use writeStateFile(), not raw fs.writeFileSync on state
 *   pickle/cli-guard-basename    — CLI guards must use path.basename(process.argv[1]) === '...'
 *   pickle/hook-decision-values  — hook decisions must be "approve" or "block", never "allow"
 *   pickle/no-unsafe-error-cast  — catch bindings require instanceof Error guard before .message/.stack/.code
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Check if a node is `fs.writeFileSync` */
function isFsWriteFileSync(callee) {
  return (
    callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'fs' &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'writeFileSync'
  );
}

/** Check if a node resolves to a string containing "state.json" */
function refersToStateJson(node) {
  if (!node) return false;
  // Literal: "...state.json..."
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value.includes('state.json');
  }
  // Template literal
  if (node.type === 'TemplateLiteral') {
    return node.quasis.some((q) => q.value.raw.includes('state.json'));
  }
  // Variable named statePath, stateFile, etc.
  if (node.type === 'Identifier') {
    return /state/i.test(node.name) && /path|file/i.test(node.name);
  }
  return false;
}

/** Check if node is `process.argv[1]` */
function isProcessArgv1(node) {
  return (
    node.type === 'MemberExpression' &&
    node.computed === true &&
    node.object.type === 'MemberExpression' &&
    node.object.object.type === 'Identifier' &&
    node.object.object.name === 'process' &&
    node.object.property.type === 'Identifier' &&
    node.object.property.name === 'argv' &&
    node.property.type === 'Literal' &&
    node.property.value === 1
  );
}

/** Check if node is `path.basename(process.argv[1])` */
function isPathBasenameArgv1(node) {
  return (
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === 'path' &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === 'basename' &&
    node.arguments.length >= 1 &&
    isProcessArgv1(node.arguments[0])
  );
}

/** Walk up to find enclosing CatchClause */
function getEnclosingCatch(node) {
  let current = node;
  while (current) {
    if (current.type === 'CatchClause') return current;
    current = current.parent;
  }
  return null;
}

/**
 * Check if an instanceof Error guard exists for `name` in the same scope,
 * before the given node. We look for `name instanceof Error` in the
 * condition of an enclosing IfStatement or ConditionalExpression.
 */
function hasInstanceofGuard(node, paramName) {
  let current = node.parent;
  while (current) {
    // Ternary: param instanceof Error ? param.message : ...
    if (current.type === 'ConditionalExpression' && current.consequent) {
      if (isInstanceofErrorCheck(current.test, paramName)) return true;
    }
    // If statement: if (param instanceof Error)
    if (current.type === 'IfStatement') {
      if (isInstanceofErrorCheck(current.test, paramName)) return true;
    }
    // Logical AND: param instanceof Error && param.message
    if (current.type === 'LogicalExpression' && current.operator === '&&') {
      if (isInstanceofErrorCheck(current.left, paramName)) return true;
    }
    current = current.parent;
  }
  return false;
}

function isInstanceofErrorCheck(test, paramName) {
  if (!test) return false;
  if (
    test.type === 'BinaryExpression' &&
    test.operator === 'instanceof' &&
    test.left.type === 'Identifier' &&
    test.left.name === paramName &&
    test.right.type === 'Identifier' &&
    test.right.name === 'Error'
  ) {
    return true;
  }
  // Handle negated or compound: !(x instanceof Error), x instanceof Error || ...
  if (test.type === 'LogicalExpression') {
    return (
      isInstanceofErrorCheck(test.left, paramName) ||
      isInstanceofErrorCheck(test.right, paramName)
    );
  }
  if (test.type === 'UnaryExpression' && test.operator === '!') {
    return isInstanceofErrorCheck(test.argument, paramName);
  }
  return false;
}

// ─── Rules ──────────────────────────────────────────────────────────────────

const noRawStateWrite = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow raw fs.writeFileSync for state.json — use writeStateFile() for atomic writes',
    },
    messages: {
      useWriteStateFile:
        'Use writeStateFile() instead of fs.writeFileSync for state.json. Raw writes risk corruption on crash.',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isFsWriteFileSync(node.callee)) return;
        const firstArg = node.arguments[0];
        if (refersToStateJson(firstArg)) {
          context.report({ node, messageId: 'useWriteStateFile' });
        }
      },
    };
  },
};

const cliGuardBasename = {
  meta: {
    type: 'problem',
    docs: {
      description: 'CLI entry guards must use path.basename(process.argv[1]) === "file.js"',
    },
    messages: {
      requireBasename:
        'Use `path.basename(process.argv[1]) === "file.js"` for CLI guards. Never use startsWith/endsWith/includes or bare equality on process.argv[1].',
    },
    schema: [],
  },
  create(context) {
    return {
      // Catch: process.argv[1].startsWith / endsWith / includes
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === 'MemberExpression' &&
          isProcessArgv1(callee.object) &&
          callee.property.type === 'Identifier' &&
          ['startsWith', 'endsWith', 'includes'].includes(callee.property.name)
        ) {
          context.report({ node, messageId: 'requireBasename' });
        }
      },
      // Catch: process.argv[1] === "..." (without basename)
      BinaryExpression(node) {
        if (node.operator !== '===' && node.operator !== '==') return;
        const leftIsArgv1 = isProcessArgv1(node.left);
        const rightIsArgv1 = isProcessArgv1(node.right);
        if (!leftIsArgv1 && !rightIsArgv1) return;
        // OK if the other side is path.basename(process.argv[1])
        // But if raw process.argv[1] is directly compared to a literal, flag it
        const otherSide = leftIsArgv1 ? node.right : node.left;
        if (otherSide.type === 'Literal' && typeof otherSide.value === 'string') {
          context.report({ node, messageId: 'requireBasename' });
        }
      },
    };
  },
};

const hookDecisionValues = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Hook decisions must be "approve" or "block", never "allow"',
    },
    messages: {
      noAllow:
        'Hook decision "allow" is not recognized by Claude Code. Use "approve" or "block".',
      invalidDecision:
        'Hook decision must be "approve" or "block". Got "{{value}}".',
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename || context.getFilename();
    const inHooks = /hooks[/\\]/.test(filename);
    if (!inHooks) return {};

    return {
      // Flag decision property with wrong value
      Property(node) {
        if (
          node.key.type === 'Identifier' &&
          node.key.name === 'decision' &&
          node.value.type === 'Literal' &&
          typeof node.value.value === 'string'
        ) {
          if (node.value.value === 'allow') {
            context.report({ node: node.value, messageId: 'noAllow' });
          } else if (node.value.value !== 'approve' && node.value.value !== 'block') {
            context.report({
              node: node.value,
              messageId: 'invalidDecision',
              data: { value: node.value.value },
            });
          }
        }
      },
    };
  },
};

const noUnsafeErrorCast = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Catch bindings require instanceof Error guard before accessing .message/.stack/.code',
    },
    messages: {
      requireGuard:
        'Accessing .{{prop}} on catch binding "{{name}}" without `instanceof Error` guard. Use: `{{name}} instanceof Error ? {{name}}.{{prop}} : String({{name}})`',
      noAsCastError:
        'Do not cast catch binding to Error with `as Error`. Use instanceof guard instead.',
    },
    schema: [],
  },
  create(context) {
    const dangerousProps = new Set(['message', 'stack', 'code', 'cause']);

    return {
      // Flag: (err as Error) via TSAsExpression
      TSAsExpression(node) {
        if (
          node.typeAnnotation &&
          node.typeAnnotation.type === 'TSTypeReference' &&
          node.typeAnnotation.typeName &&
          node.typeAnnotation.typeName.name === 'Error' &&
          node.expression.type === 'Identifier'
        ) {
          const catchClause = getEnclosingCatch(node);
          if (catchClause && catchClause.param && catchClause.param.name === node.expression.name) {
            context.report({
              node,
              messageId: 'noAsCastError',
            });
          }
        }
      },
      // Flag: err.message without guard
      MemberExpression(node) {
        if (node.computed) return;
        if (node.property.type !== 'Identifier') return;
        if (!dangerousProps.has(node.property.name)) return;
        if (node.object.type !== 'Identifier') return;

        const catchClause = getEnclosingCatch(node);
        if (!catchClause) return;
        if (!catchClause.param) return; // catch without binding

        const paramName =
          catchClause.param.type === 'Identifier' ? catchClause.param.name : null;
        if (!paramName) return;
        if (node.object.name !== paramName) return;

        if (!hasInstanceofGuard(node, paramName)) {
          context.report({
            node,
            messageId: 'requireGuard',
            data: { prop: node.property.name, name: paramName },
          });
        }
      },
    };
  },
};

// ─── Plugin Export ───────────────────────────────────────────────────────────

const plugin = {
  meta: {
    name: 'eslint-plugin-pickle',
    version: '1.0.0',
  },
  rules: {
    'no-raw-state-write': noRawStateWrite,
    'cli-guard-basename': cliGuardBasename,
    'hook-decision-values': hookDecisionValues,
    'no-unsafe-error-cast': noUnsafeErrorCast,
  },
};

export default plugin;
