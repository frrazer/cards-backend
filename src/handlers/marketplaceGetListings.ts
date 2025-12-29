import { APIGatewayProxyHandler } from 'aws-lambda';
import { badRequest, success, serverError } from '../utils/response';
import { getUserListings } from '../utils/marketplace';
import { RouteConfig } from '../types/route';

export const route: RouteConfig = {
  method: 'GET',
  path: '/marketplace/listings/{userId}',
  timeout: 5,
  memory: 256,
};

export const handler: APIGatewayProxyHandler = async event => {
  const userId = event.pathParameters?.userId;

  if (!userId) {
    return badRequest('userId is required in path parameters');
  }

  try {
    const listings = await getUserListings(userId);

    return success({ userId, listings, count: listings.length });
  } catch (error) {
    console.error('Error fetching user listings:', error);
    return serverError('Failed to fetch user listings');
  }
};
