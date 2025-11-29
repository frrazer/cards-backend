#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const HANDLERS_DIR = path.join(__dirname, '..', 'src', 'handlers');
const TEMPLATE_PATH = path.join(__dirname, '..', 'template.yaml');

const parseHandler = (filePath) => {
    const content = fs.readFileSync(filePath, 'utf-8');
    const docBlock = content.match(/\/\*\*([\s\S]*?)\*\/[\s\S]*?export\s+const\s+handler/)?.[1];

    if (!docBlock) return null;

    const routeMatch = docBlock.match(/@route\s+(GET|POST|PUT|DELETE|PATCH)\s+(\/[\w\-\/{}]*)/i);
    if (!routeMatch) return null;

    return {
        fileName: path.basename(filePath, '.ts'),
        method: routeMatch[1].toUpperCase(),
        path: routeMatch[2],
        timeout: docBlock.match(/@timeout\s+(\d+)/)?.[1],
        memory: docBlock.match(/@memory\s+(\d+)/)?.[1],
        description: docBlock.match(/@description\s+(.+)/)?.[1]?.trim(),
    };
};

const getFuncName = (name) => `${name.charAt(0).toUpperCase() + name.slice(1)}Function`;

const generateTemplate = (handlers) => {
    const resources = handlers
        .map((h) => {
            const props = [
                h.description && `    Description: ${h.description}`,
                h.timeout && `    Timeout: ${h.timeout}`,
                h.memory && `    MemorySize: ${h.memory}`,
            ]
                .filter(Boolean)
                .join('\n');

            return `  # ${h.method} ${h.path}
  ${getFuncName(h.fileName)}:
    Type: AWS::Serverless::Function
${props}
    Metadata:
      BuildMethod: esbuild
      BuildProperties:
        Minify: true
        Target: "es2020"
        Sourcemap: true
        EntryPoints: 
          - src/handlers/${h.fileName}.ts
    Properties:
      CodeUri: ./
      Handler: src/handlers/${h.fileName}.handler
      Events:
        ApiEvent:
          Type: Api
          Properties:
            RestApiId: !Ref MyApi
            Path: ${h.path}
            Method: ${h.method.toLowerCase()}`;
        })
        .join('\n\n');

    return `AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Description: Scalable TypeScript Backend API - Cards API

Parameters:
  Env: { Type: String, Default: dev, AllowedValues: [dev, prod], Description: Environment name }

Globals:
  Function:
    Timeout: 3
    MemorySize: 128
    Runtime: nodejs20.x
    Architectures: [arm64]
    Environment: { Variables: { NODE_ENV: !Ref Env } }

Resources:
  MyApi:
    Type: AWS::Serverless::Api
    Properties:
      StageName: !Ref Env
      Cors: { AllowMethods: "'GET,POST,PUT,DELETE,PATCH,OPTIONS'", AllowHeaders: "'Content-Type,Authorization'", AllowOrigin: "'*'" }

${resources}

Outputs:
  ApiEndpoint:
    Description: "API Gateway endpoint URL"
    Value: !Sub "https://\${MyApi}.execute-api.\${AWS::Region}.amazonaws.com/\${Env}${handlers[0]?.path || '/'}"
`;
};

(() => {
    console.log('🚀 Generating SAM template...');

    if (!fs.existsSync(HANDLERS_DIR)) {
        console.error('❌ Handlers directory not found:', HANDLERS_DIR);
        process.exit(1);
    }

    const handlers = fs
        .readdirSync(HANDLERS_DIR)
        .filter((f) => f.endsWith('.ts'))
        .map((f) => parseHandler(path.join(HANDLERS_DIR, f)))
        .filter(Boolean);

    if (handlers.length === 0) {
        console.error('❌ No annotated handlers found (needs @route tag)');
        process.exit(1);
    }

    handlers.forEach((h) => console.log(`   • ${h.method.padEnd(6)} ${h.path.padEnd(20)} → ${h.fileName}`));

    fs.writeFileSync(TEMPLATE_PATH, generateTemplate(handlers), 'utf-8');
    console.log('\n✨ Template generated successfully: template.yaml');
})();
