import { APIGatewayProxyHandler } from 'aws-lambda';
import { buildResponse } from '../utils/response';
import { RouteConfig } from '../types/route';

export const route: RouteConfig = {
  method: 'GET',
  path: '/protected/example',
  auth: true,
  timeout: 3,
  memory: 128,
};

export const handler: APIGatewayProxyHandler = async () => {
  return buildResponse(200, {
    success: true,
    message: 'You have successfully accessed a protected endpoint!',
    timestamp: new Date().toISOString(),
  });
};
