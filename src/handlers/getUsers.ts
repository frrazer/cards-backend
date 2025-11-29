import { APIGatewayProxyHandler } from 'aws-lambda';
import { buildResponse } from '../utils/response';

const users = [
    { id: 1, name: 'Alice', role: 'admin' },
    { id: 2, name: 'Bob', role: 'user' },
    { id: 3, name: 'Charlie', role: 'user' },
];

export const handler: APIGatewayProxyHandler = async () => {
    console.log('Processing GetUsers request...');

    return buildResponse(200, {
        success: true,
        count: users.length,
        data: users,
    });
};
