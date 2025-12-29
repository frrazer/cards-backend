import { APIGatewayProxyHandler } from 'aws-lambda';
import { badRequest, success, serverError } from '../utils/response';
import { getUserListings } from '../utils/marketplace';

/**
 * @route GET /marketplace/listings/{userId}
 * @timeout 5
 * @memory 256
 * @description Get all marketplace listings for a specific user
 */
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
