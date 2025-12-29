#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */

const fs = require('fs');
const path = require('path');

const HANDLERS_DIR = path.join(__dirname, '..', 'src', 'handlers');
const TEMPLATE_PATH = path.join(__dirname, '..', 'template.yaml');

const parseHandler = filePath => {
  const content = fs.readFileSync(filePath, 'utf-8');

  const routeMatch = content.match(
    /export\s+const\s+route\s*(?::\s*RouteConfig)?\s*=\s*(\{[\s\S]*?\})\s*(?:as\s+const)?;/,
  );
  if (!routeMatch) return null;

  let config;
  try {
    const configStr = routeMatch[1]
      .replace(/(\w+):/g, '"$1":')
      .replace(/'/g, '"')
      .replace(/,\s*}/g, '}')
      .replace(/,\s*,/g, ',');
    config = JSON.parse(configStr);
  } catch {
    console.warn(`⚠️  Could not parse route config in ${path.basename(filePath)}`);
    return null;
  }

  if (!config.method || !config.path) return null;

  return {
    fileName: path.basename(filePath, '.ts'),
    method: config.method.toUpperCase(),
    path: config.path,
    timeout: config.timeout,
    memory: config.memory,
    description: config.description,
    requiresAuth: config.auth === true,
    isCatchAll: config.path === '/{proxy+}',
  };
};

const getFuncName = name => `${name.charAt(0).toUpperCase() + name.slice(1)}Function`;

const generateTemplate = handlers => {
  const regularHandlers = handlers.filter(h => !h.isCatchAll);
  const catchAllHandlers = handlers.filter(h => h.isCatchAll);

  const generateResource = h => {
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

    return `  ${getFuncName(h.fileName)}:
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
  };

  const resources = regularHandlers.map(generateResource).join('\n\n');
  const catchAllResources = catchAllHandlers.map(generateResource).join('\n\n');

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
    .filter(f => f.endsWith('.ts'))
    .map(f => parseHandler(path.join(HANDLERS_DIR, f)))
    .filter(Boolean);

  if (handlers.length === 0) {
    console.error('❌ No handlers with route config found');
    process.exit(1);
  }

  handlers.forEach(h => console.log(`   • ${h.method.padEnd(6)} ${h.path.padEnd(30)} → ${h.fileName}`));

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
  ApiWebACL:
    Type: AWS::WAFv2::WebACL
    Properties:
      Name: !Sub "\${AWS::StackName}-\${Env}-waf"
      Scope: REGIONAL
      DefaultAction:
        Block: {}
      Rules:
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
        - Name: RateLimitPerIP
          Priority: 2
          Statement:
            RateBasedStatement:
              Limit: 500
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

  ApiWebACLAssociation:
    Type: AWS::WAFv2::WebACLAssociation
    Properties:
      ResourceArn: !Sub "arn:aws:apigateway:\${AWS::Region}::/restapis/\${MyApi}/stages/\${Env}"
      WebACLArn: !GetAtt ApiWebACL.Arn

  MyApi:
    Type: AWS::Serverless::Api
    Properties:
      StageName: !Ref Env
      MinimumCompressionSize: 0
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
  
  AuthorizerFunction:
    Type: AWS::Serverless::Function
    Metadata:
      BuildMethod: esbuild
      BuildProperties:
        Minify: true
        Target: "es2020"
        Sourcemap: true
        EntryPoints:
          - src/handlers/authorizer.ts
    Properties:
      CodeUri: ./
      Handler: src/handlers/authorizer.handler
      Environment:
        Variables:
          AUTH_TOKEN: !Ref AuthToken

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
