import { APIGatewayProxyEvent } from 'aws-lambda';

/**
 * Checks if the request contains a valid authentication token.
 * Looks for the token in the Authorization header (Bearer token) or x-api-key header.
 *
 * @param event - The API Gateway proxy event
 * @returns True if authenticated, false otherwise
 */
export const checkAuth = (event: APIGatewayProxyEvent): boolean => {
    const authToken = process.env.AUTH_TOKEN;

    if (!authToken) {
        console.error('AUTH_TOKEN environment variable is not set');
        return false;
    }

    // Check Authorization header (Bearer token)
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    if (authHeader) {
        // Support both "Bearer TOKEN" and just "TOKEN" formats
        const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;

        if (token === authToken) {
            return true;
        }
    }

    // Check x-api-key header as fallback
    const apiKey = event.headers?.['x-api-key'] || event.headers?.['X-API-Key'];
    if (apiKey && apiKey === authToken) {
        return true;
    }

    return false;
};

/**
 * Gets an unauthorized response object
 */
export const getUnauthorizedResponse = () => ({
    statusCode: 401,
    headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify({
        success: false,
        error: 'Unauthorized',
        message: 'Invalid or missing authentication token',
        timestamp: new Date().toISOString(),
    }),
});
