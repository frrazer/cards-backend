# Cards API

Scalable TypeScript Backend API built with AWS SAM (Serverless Application Model).

## 📁 Project Structure

- `src/handlers/` - Lambda function handlers written in TypeScript
- `src/utils/` - Shared utility functions
- `scripts/` - Build and automation scripts
- `template.yaml` - SAM template (auto-generated from handler annotations)

## ⚡ Auto-Generated SAM Template

This project uses **annotation-based template generation**. Instead of manually maintaining `template.yaml`, simply add JSDoc annotations to your handler files:

### Creating a Handler

```typescript
import { APIGatewayProxyHandler } from 'aws-lambda';
import { buildResponse } from '../utils/response';

/**
 * @route GET /users
 * @timeout 5
 * @memory 256
 * @description Retrieves a list of all users
 */
export const handler: APIGatewayProxyHandler = async () => {
    // Your handler logic here
    return buildResponse(200, { users: [] });
};
```

### Supported Annotations

- `@route` - **Required**. Format: `METHOD /path` (e.g., `GET /users`, `POST /users/{id}`)
- `@timeout` - Optional. Timeout in seconds (default: 3)
- `@memory` - Optional. Memory in MB (default: 128)
- `@description` - Optional. Function description

### Generate Template

After adding or modifying handlers, run:

```bash
npm run generate:template
```

This will scan all files in `src/handlers/` and regenerate `template.yaml` based on the annotations.

### Workflow

1. Create a new handler file in `src/handlers/`
2. Add annotations with `@route` and optional settings
3. Run `npm run generate:template`
4. Deploy with `sam build && sam deploy`

## 🚀 Prerequisites

- [SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-install.html)
- [Node.js 20](https://nodejs.org/en/) with npm
- [Docker](https://hub.docker.com/search/?type=edition&offering=community) (for local testing)
- AWS credentials configured

## 📦 Installation

```bash
npm install
```

## 🛠️ Development

### Build and Deploy

```bash
# Generate template from annotations
npm run generate:template

# Build the application
sam build

# Deploy (first time - guided)
sam deploy --guided

# Deploy (subsequent times)
sam deploy
```

### Deployment Prompts

- **Stack Name**: Unique name for your CloudFormation stack (e.g., `cards-api-dev`)
- **AWS Region**: Target region (e.g., `us-east-1`)
- **Confirm changes before deploy**: Set to `yes` for manual review
- **Allow SAM CLI IAM role creation**: Set to `yes` (required for Lambda execution)
- **Save arguments to samconfig.toml**: Set to `yes` for future deployments

### Local Testing

```bash
# Build the application
sam build

# Start local API Gateway (port 3000)
sam local start-api

# Test endpoints
curl http://localhost:3000/heartbeat
curl http://localhost:3000/users
```

### Available Scripts

- `npm run generate:template` - Generate SAM template from handler annotations
- `npm run compile` - Compile TypeScript
- `npm run test` - Run unit tests
- `npm run lint` - Lint and fix code

## 📊 Monitoring

View Lambda function logs:

```bash
sam logs -n GetUsersFunction --stack-name cards-api-dev --tail
```

## 🧪 Testing

```bash
npm test
```

## 🗑️ Cleanup

```bash
sam delete --stack-name cards-api-dev
```

## 📚 Resources

- [AWS SAM Documentation](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/what-is-sam.html)
- [API Gateway Documentation](https://docs.aws.amazon.com/apigateway/)
- [Lambda Documentation](https://docs.aws.amazon.com/lambda/)
