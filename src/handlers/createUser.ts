import { APIGatewayProxyHandler } from 'aws-lambda';
import { buildResponse } from '../utils/response';

export const handler: APIGatewayProxyHandler = async (event) => {
    try {
        console.log('Processing CreateUser request...');

        if (!event.body) {
            return buildResponse(400, { message: 'Missing request body' });
        }

        const body = JSON.parse(event.body);

        if (!body.name || !body.email) {
            return buildResponse(400, { message: 'Name and Email are required' });
        }

        const newUser = {
            id: Math.floor(Math.random() * 10000),
            ...body,
            createdAt: new Date().toISOString(),
        };

        // 5. Return success
        return buildResponse(201, {
            message: 'User created successfully',
            user: newUser,
        });
    } catch (error) {
        console.error('Error creating user:', error);
        return buildResponse(500, { message: 'Internal Server Error' });
    }
};
