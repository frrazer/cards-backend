import { APIGatewayProxyHandler } from 'aws-lambda';
import { buildResponse } from '../utils/response';

/**
 * @route GET /heartbeat
 * @timeout 3
 * @memory 128
 * @description Health check endpoint for API monitoring
 */
export const handler: APIGatewayProxyHandler = async () => {
    console.log('Processing heartbeat request...');

    return buildResponse(200, {
        success: true,
        message: 'API is running',
        timestamp: new Date().toISOString(),
    });
};
