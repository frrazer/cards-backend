/**
 * ESLint rule: no-single-use-variables
 * 
 * Enforces that variables should only be created if they're used more than twice.
 * For single-use values, they should be inlined directly where needed.
 * For values used exactly twice, the rule suggests evaluating if extraction improves readability.
 */

module.exports = {
    meta: {
        type: 'suggestion',
        docs: {
            description: 'Disallow variables that are only used once or twice',
            category: 'Best Practices',
            recommended: false,
        },
        messages: {
            singleUse: 'Variable "{{name}}" is only used once. Consider inlining it directly.',
            doubleUse: 'Variable "{{name}}" is only used twice. Evaluate if extraction improves readability, otherwise consider inlining.',
        },
        schema: [
            {
                type: 'object',
                properties: {
                    ignoreDoubleUse: {
                        type: 'boolean',
                        default: false,
                    },
                    excludePatterns: {
                        type: 'array',
                        items: { type: 'string' },
                        default: [],
                    },
                },
                additionalProperties: false,
            },
        ],
    },

    create(context) {
        const options = context.options[0] || {};
        const ignoreDoubleUse = options.ignoreDoubleUse || false;
        const excludePatterns = options.excludePatterns || [];

        // Track variable declarations and their usage counts
        const variableUsage = new Map();

        function isExcluded(name) {
            return excludePatterns.some((pattern) => new RegExp(pattern).test(name));
        }

        function shouldIgnoreVariable(node, name, variable) {
            // Ignore destructured variables
            if (node.parent.type === 'ArrayPattern' || node.parent.type === 'ObjectPattern') {
                return true;
            }

            // Ignore function parameters
            if (node.parent.type === 'FunctionDeclaration' || node.parent.type === 'ArrowFunctionExpression') {
                return true;
            }

            // Ignore variables in for loops
            if (node.parent.type === 'ForStatement' || node.parent.type === 'ForInStatement' || node.parent.type === 'ForOfStatement') {
                return true;
            }

            // Ignore catch clause parameters
            if (node.parent.type === 'CatchClause') {
                return true;
            }

            // Ignore type definitions and exports
            if (variable.defs[0]?.type === 'Type' || variable.defs[0]?.type === 'TSTypeAnnotation') {
                return true;
            }

            // Ignore function declarations (not assignments)
            if (node.parent.type === 'FunctionDeclaration') {
                return true;
            }

            // Ignore constants (all caps with underscores)
            if (name === name.toUpperCase() && name.includes('_')) {
                return true;
            }

            // Ignore callback parameters in common array methods
            const parentCallExpression = node.parent?.parent;
            if (parentCallExpression?.type === 'CallExpression') {
                const callee = parentCallExpression.callee;
                if (callee?.type === 'MemberExpression') {
                    const methodName = callee.property?.name;
                    if (['forEach', 'map', 'filter', 'reduce', 'find', 'some', 'every'].includes(methodName)) {
                        return true;
                    }
                }
            }

            // Ignore excluded patterns
            if (isExcluded(name)) {
                return true;
            }

            return false;
        }

        function isComplexInitializer(init) {
            if (!init) return false;

            // Consider these as complex enough to warrant a variable:
            // - Multiple chained calls (e.g., foo.bar().baz())
            // - Binary expressions with multiple operations
            // - Long ternary expressions
            // - Array/Object with many elements
            // - Function calls with multiple arguments

            if (init.type === 'CallExpression') {
                // Multiple chained calls
                if (init.callee.type === 'MemberExpression' && init.callee.object.type === 'CallExpression') {
                    return true;
                }
                // Call with multiple complex arguments
                if (init.arguments.length >= 3) {
                    return true;
                }
            }

            if (init.type === 'MemberExpression') {
                // Deep property access (3+ levels)
                let depth = 0;
                let current = init;
                while (current.type === 'MemberExpression') {
                    depth++;
                    current = current.object;
                }
                if (depth >= 3) {
                    return true;
                }
            }

            if (init.type === 'BinaryExpression' || init.type === 'LogicalExpression') {
                // Multiple operations
                let count = 0;
                function countOperations(node) {
                    if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') {
                        count++;
                        countOperations(node.left);
                        countOperations(node.right);
                    }
                }
                countOperations(init);
                if (count >= 2) {
                    return true;
                }
            }

            if (init.type === 'ConditionalExpression') {
                // Nested ternaries or complex conditions
                if (init.test.type === 'ConditionalExpression' || 
                    init.consequent.type === 'ConditionalExpression' || 
                    init.alternate.type === 'ConditionalExpression') {
                    return true;
                }
            }

            if (init.type === 'ArrayExpression' && init.elements.length >= 5) {
                return true;
            }

            if (init.type === 'ObjectExpression' && init.properties.length >= 4) {
                return true;
            }

            return false;
        }

        return {
            'Program:exit': function (programNode) {
                const sourceCode = context.getSourceCode();
                const scope = sourceCode.getScope ? sourceCode.getScope(programNode) : context.getScope();

                function checkScope(currentScope) {
                    currentScope.variables.forEach((variable) => {
                        // Skip special variables
                        if (variable.name === 'arguments' || variable.name.startsWith('_')) {
                            return;
                        }

                        const references = variable.references.filter(ref => !ref.init);
                        const usageCount = references.length;

                        // Get the declaration node
                        const declaration = variable.defs[0];
                        if (!declaration || !declaration.node) {
                            return;
                        }

                        const declarationNode = declaration.node;
                        const variableName = variable.name;

                        // Check if we should ignore this variable
                        if (shouldIgnoreVariable(declarationNode, variableName, variable)) {
                            return;
                        }

                        // Skip if not a const variable declaration
                        if (declaration.parent && declaration.parent.kind !== 'const') {
                            return;
                        }

                        // Get the initializer
                        const init = declarationNode.init;

                        // If the initializer is complex, allow the variable
                        if (isComplexInitializer(init)) {
                            return;
                        }

                        // Check usage count
                        if (usageCount === 1) {
                            context.report({
                                node: declarationNode,
                                messageId: 'singleUse',
                                data: { name: variableName },
                            });
                        } else if (usageCount === 2 && !ignoreDoubleUse) {
                            context.report({
                                node: declarationNode,
                                messageId: 'doubleUse',
                                data: { name: variableName },
                            });
                        }
                    });

                    // Check child scopes
                    currentScope.childScopes.forEach(checkScope);
                }

                checkScope(scope);
            },
        };
    },
};
