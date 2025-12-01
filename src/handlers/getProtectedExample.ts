import { APIGatewayProxyHandler } from 'aws-lambda';
import { buildResponse } from '../utils/response';
import { checkAuth, getUnauthorizedResponse } from '../utils/auth';

/**
 * @route GET /protected/example
 * @auth
 * @timeout 3
 * @memory 128
 * @description Example protected endpoint that requires authentication
 */
export const handler: APIGatewayProxyHandler = async (event) => {
    // Check authentication
    if (!checkAuth(event)) {
        console.log('Authentication failed for protected endpoint');
        return getUnauthorizedResponse();
    }

    console.log('Processing authenticated request...');

    return buildResponse(200, {
        success: true,
        message: 'You have successfully accessed a protected endpoint!',
        timestamp: new Date().toISOString(),
    });
};
