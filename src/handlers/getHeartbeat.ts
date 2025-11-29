import { APIGatewayProxyHandler } from 'aws-lambda';
import { buildResponse } from '../utils/response';

export const handler: APIGatewayProxyHandler = async () => {
    console.log('Processing GetUsers request...');

    return buildResponse(200, {
        success: true,
        message: 'API is running',
        timestamp: new Date().toISOString(),
    });
};
