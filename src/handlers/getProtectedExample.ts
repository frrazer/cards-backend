import { APIGatewayProxyHandler } from 'aws-lambda';
import { buildResponse } from '../utils/response';

/**
 * @route GET /protected/example
 * @auth
 * @timeout 3
 * @memory 128
 * @description Example protected endpoint that requires authentication
 */
export const handler: APIGatewayProxyHandler = async () => {
  console.log('Processing authenticated request...');

  return buildResponse(200, {
    success: true,
    message: 'You have successfully accessed a protected endpoint!',
    timestamp: new Date().toISOString(),
  });
};
