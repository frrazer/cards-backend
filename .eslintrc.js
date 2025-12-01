const path = require('path');
const rulesDirPlugin = require('eslint-plugin-rulesdir');
rulesDirPlugin.RULES_DIR = path.join(__dirname, 'eslint-rules');

module.exports = {
    parser: '@typescript-eslint/parser',
    parserOptions: {
        ecmaVersion: 2020, // Allows for the parsing of modern ECMAScript features
        sourceType: 'module',
    },
    extends: [
        'plugin:@typescript-eslint/recommended', // recommended rules from the @typescript-eslint/eslint-plugin
        'plugin:prettier/recommended', // Enables eslint-plugin-prettier and eslint-config-prettier. This will display prettier errors as ESLint errors. Make sure this is always the last configuration in the extends array.
    ],
    plugins: ['rulesdir'],
    ignorePatterns: ['*.js', 'node_modules/', 'dist/', 'build/', '.aws-sam/'],
    rules: {
        // Custom code style rules
        'rulesdir/no-single-use-variables': ['warn', {
            ignoreDoubleUse: true, // Only warn about single-use variables
            excludePatterns: [
                '^keys$', '^response$', '^error$', // Common variable names
                '.*Expressions$', '.*AttributeNames$', '.*AttributeValues$', // AWS patterns
                'attrName', 'attrValue', 'key', 'index', // Loop variables
                '^pk$', '^sk$', 'item', 'updates', // Database operations
                'newVersion', 'currentVersion', 'currentCount', // Counters
                'authToken', 'transactItems', 'chunks', // Semantic names
                'event', 'client', // Common AWS Lambda/SDK names
                'operations', 'resolve', 'chunk', // Common callback names
                'statusCode', 'body', 'card', // Function parameters with semantic meaning
                'field', 'amount', // Utility function parameters
                'generatePolicy', 'principalId', 'effect', 'resource', // Auth function names
            ],
        }],
        
        // Additional helpful rules for code conciseness
        '@typescript-eslint/no-unused-vars': ['error', {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
        }],
        'prefer-const': 'error',
        'no-var': 'error',
    },
};
