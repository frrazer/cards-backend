#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */

const fs = require('fs');
const path = require('path');

const HANDLERS_DIR = path.join(__dirname, '..', 'src', 'handlers');
const TEMPLATE_PATH = path.join(__dirname, '..', 'template.yaml');

const parseHandler = (filePath) => {
    const content = fs.readFileSync(filePath, 'utf-8');
    const docBlock = content.match(/\/\*\*([\s\S]*?)\*\/[\s\S]*?export\s+const\s+handler/)?.[1];

    if (!docBlock) return null;

    const routeMatch = docBlock.match(/@route\s+(GET|POST|PUT|DELETE|PATCH|ANY)\s+(\/[\w\-\/{}+]*)/i);
    if (!routeMatch) return null;

    return {
        fileName: path.basename(filePath, '.ts'),
        method: routeMatch[1].toUpperCase(),
        path: routeMatch[2],
        timeout: docBlock.match(/@timeout\s+(\d+)/)?.[1],
        memory: docBlock.match(/@memory\s+(\d+)/)?.[1],
        description: docBlock.match(/@description\s+(.+)/)?.[1]?.trim(),
        requiresAuth: /@auth/i.test(docBlock),
        isCatchAll: routeMatch[2] === '/{proxy+}',
    };
};

const getFuncName = (name) => `${name.charAt(0).toUpperCase() + name.slice(1)}Function`;

const generateTemplate = (handlers) => {
    // Separate catch-all handlers from regular handlers
    const regularHandlers = handlers.filter((h) => !h.isCatchAll);
    const catchAllHandlers = handlers.filter((h) => h.isCatchAll);

    // Regular handlers first
    const resources = regularHandlers
        .map((h) => {
            const props = [
                h.description && `    Description: ${h.description}`,
                h.timeout && `    Timeout: ${h.timeout}`,
                h.memory && `    MemorySize: ${h.memory}`,
            ]
                .filter(Boolean)
                .join('\n');

            // No need for AUTH_TOKEN in individual functions anymore
            // The authorizer handles it

            const authConfig = h.requiresAuth
                ? `            Auth:
              Authorizer: ApiAuthorizer`
                : '';

            return `  # ${h.method} ${h.path}${h.requiresAuth ? ' [AUTH REQUIRED]' : ''}
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
      Policies:
        - DynamoDBCrudPolicy:
            TableName: !Ref MainTable
      Events:
        ApiEvent:
          Type: Api
          Properties:
            RestApiId: !Ref MyApi
            Path: ${h.path}
            Method: ${h.method.toLowerCase()}
${authConfig}`;
        })
        .join('\n\n');

    // Catch-all handlers last (so they don't override specific routes)
    const catchAllResources = catchAllHandlers
        .map((h) => {
            const props = [
                h.description && `    Description: ${h.description}`,
                h.timeout && `    Timeout: ${h.timeout}`,
                h.memory && `    MemorySize: ${h.memory}`,
            ]
                .filter(Boolean)
                .join('\n');

            const authConfig = h.requiresAuth
                ? `            Auth:
              Authorizer: ApiAuthorizer`
                : '';

            return `  # ${h.method} ${h.path}${h.requiresAuth ? ' [AUTH REQUIRED]' : ''}
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
      Policies:
        - DynamoDBCrudPolicy:
            TableName: !Ref MainTable
      Events:
        ApiEvent:
          Type: Api
          Properties:
            RestApiId: !Ref MyApi
            Path: ${h.path}
            Method: ${h.method.toLowerCase()}
${authConfig}`;
        })
        .join('\n\n');

    return resources + (catchAllResources ? '\n\n' + catchAllResources : '');
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

    const template = `AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Description: Scalable TypeScript Backend API - Cards API

Parameters:
  Env: { Type: String, Default: dev, AllowedValues: [dev, prod], Description: Environment name }
  AuthToken: { Type: String, NoEcho: true, Description: API authentication token for protected endpoints }
  WafHeaderName: { Type: String, NoEcho: true, Description: WAF custom header name for request filtering }
  WafHeaderValue: { Type: String, NoEcho: true, Description: WAF custom header value for request filtering }

Globals:
  Function:
    Timeout: 3
    MemorySize: 128
    Runtime: nodejs20.x
    Architectures: [arm64]
    Environment:
      Variables:
        NODE_ENV: !Ref Env
        TABLE_NAME: !Ref MainTable

Resources:
  # WAF Web ACL for API Protection
  ApiWebACL:
    Type: AWS::WAFv2::WebACL
    Properties:
      Name: !Sub "\${AWS::StackName}-\${Env}-waf"
      Scope: REGIONAL
      DefaultAction:
        Block: {}
      Rules:
        # Rule 1: Require specific header
        - Name: RequireCustomHeader
          Priority: 1
          Statement:
            ByteMatchStatement:
              SearchString: !Ref WafHeaderValue
              FieldToMatch:
                SingleHeader:
                  Name: !Ref WafHeaderName
              TextTransformations:
                - Priority: 0
                  Type: NONE
              PositionalConstraint: EXACTLY
          Action:
            Allow: {}
          VisibilityConfig:
            SampledRequestsEnabled: true
            CloudWatchMetricsEnabled: true
            MetricName: RequireCustomHeader
        
        # Rule 2: Rate limiting per IP (100 requests per 5 minutes)
        - Name: RateLimitPerIP
          Priority: 2
          Statement:
            RateBasedStatement:
              Limit: 100
              AggregateKeyType: IP
          Action:
            Block: {}
          VisibilityConfig:
            SampledRequestsEnabled: true
            CloudWatchMetricsEnabled: true
            MetricName: RateLimitPerIP
      VisibilityConfig:
        SampledRequestsEnabled: true
        CloudWatchMetricsEnabled: true
        MetricName: !Sub "\${AWS::StackName}-\${Env}-waf"

  # Associate WAF with API Gateway
  ApiWebACLAssociation:
    Type: AWS::WAFv2::WebACLAssociation
    Properties:
      ResourceArn: !Sub "arn:aws:apigateway:\${AWS::Region}::/restapis/\${MyApi}/stages/\${Env}"
      WebACLArn: !GetAtt ApiWebACL.Arn

  MyApi:
    Type: AWS::Serverless::Api
    Properties:
      StageName: !Ref Env
      Auth:
        Authorizers:
          ApiAuthorizer:
            FunctionArn: !GetAtt AuthorizerFunction.Arn
            FunctionPayloadType: REQUEST
            Identity:
              Headers:
                - Authorization
              ReauthorizeEvery: 300
      Cors:
        AllowMethods: "'GET,POST,PUT,DELETE,PATCH,OPTIONS'"
        AllowHeaders: !Sub "'Content-Type,Authorization,\${WafHeaderName}'"
        AllowOrigin: "'*'"
  
  # Lambda Authorizer Function
  AuthorizerFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: ./
      Handler: src/handlers/authorizer.handler
      Runtime: nodejs20.x
      Architectures: [arm64]
      Environment:
        Variables:
          AUTH_TOKEN: !Ref AuthToken
      Metadata:
        BuildMethod: esbuild
        BuildProperties:
          Minify: true
          Target: "es2020"
          Sourcemap: true
          EntryPoints:
            - src/handlers/authorizer.ts

  MainTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: !Sub "\${AWS::StackName}-\${Env}-table"
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - AttributeName: pk
          AttributeType: S
        - AttributeName: sk
          AttributeType: S
      KeySchema:
        - AttributeName: pk
          KeyType: HASH
        - AttributeName: sk
          KeyType: RANGE
      StreamSpecification:
        StreamViewType: NEW_AND_OLD_IMAGES
      PointInTimeRecoverySpecification:
        PointInTimeRecoveryEnabled: true
      Tags:
        - Key: Environment
          Value: !Ref Env

${generateTemplate(handlers)}

Outputs:
  ApiEndpoint:
    Description: "API Gateway endpoint URL"
    Value: !Sub "https://\${MyApi}.execute-api.\${AWS::Region}.amazonaws.com/\${Env}"
  TableName:
    Description: "DynamoDB Table Name"
    Value: !Ref MainTable
  TableArn:
    Description: "DynamoDB Table ARN"
    Value: !GetAtt MainTable.Arn
`;

    fs.writeFileSync(TEMPLATE_PATH, template, 'utf-8');
    console.log('\n✨ Template generated successfully: template.yaml');
})();
