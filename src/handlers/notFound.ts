import { APIGatewayProxyHandler } from 'aws-lambda';
import { buildResponse } from '../utils/response';
import { RouteConfig } from '../types/route';

export const route: RouteConfig = {
  method: 'ANY',
  path: '/{proxy+}',
  timeout: 3,
  memory: 128,
};

export const handler: APIGatewayProxyHandler = async event => {
  return buildResponse(404, {
    success: false,
    error: 'Not Found',
    message: `The requested endpoint ${event.httpMethod} ${event.path} does not exist`,
    timestamp: new Date().toISOString(),
  });
};
