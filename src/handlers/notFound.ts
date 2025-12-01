import { APIGatewayProxyHandler } from 'aws-lambda';
import { buildResponse } from '../utils/response';

/**
 * @route ANY /{proxy+}
 * @timeout 3
 * @memory 128
 * @description Catch-all handler for undefined routes - returns 404
 */
export const handler: APIGatewayProxyHandler = async event => {
  console.log('404 - Route not found:', event.path);

  return buildResponse(404, {
    success: false,
    error: 'Not Found',
    message: `The requested endpoint ${event.httpMethod} ${event.path} does not exist`,
    timestamp: new Date().toISOString(),
  });
};
