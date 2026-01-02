import { APIGatewayRequestAuthorizerHandler, APIGatewayAuthorizerResult } from 'aws-lambda';

export const handler: APIGatewayRequestAuthorizerHandler = async event => {
  const authToken = process.env.AUTH_TOKEN;

  if (!authToken) {
    console.error('AUTH_TOKEN environment variable is not set');
    throw new Error('Unauthorized');
  }

  let token: string | undefined;
  const authHeader = event.headers?.Authorization || event.headers?.authorization;

  if (authHeader) {
    token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
  }

  if (!token) {
    token = event.headers?.['x-api-key'] || event.headers?.['X-API-Key'];
  }

  const isValid = token === authToken;
  console.log('Authorization attempt:', {
    methodArn: event.methodArn,
    isValid,
  });

  return generatePolicy(isValid ? 'user' : 'unauthorized', isValid ? 'Allow' : 'Deny', event.methodArn);
};

const generatePolicy = (
  principalId: string,
  effect: 'Allow' | 'Deny',
  resource: string,
): APIGatewayAuthorizerResult => ({
  principalId,
  policyDocument: {
    Version: '2012-10-17',
    Statement: [
      {
        Action: 'execute-api:Invoke',
        Effect: effect,
        Resource: resource.split('/').slice(0, 2).join('/') + '/*',
      },
    ],
  },
});
