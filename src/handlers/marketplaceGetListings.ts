import { APIGatewayProxyHandler } from 'aws-lambda';
import { buildResponse } from '../utils/response';
import { db } from '../utils/db';
import { MarketplaceListing, UserSlots } from '../types/inventory';

/**
 * @route GET /marketplace/listings/{userId}
 * @timeout 3
 * @memory 128
 * @description Get all marketplace listings for a specific user
 */
export const handler: APIGatewayProxyHandler = async event => {
  const userId = event.pathParameters?.userId;

  if (!userId) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'userId is required in path parameters',
    });
  }

  try {
    const slotsItem = await db.get(`USER_SLOTS#${userId}`, 'SLOTS');

    if (!slotsItem) {
      return buildResponse(200, {
        success: true,
        data: {
          userId,
          listings: [],
        },
      });
    }

    const userSlots = slotsItem as UserSlots;
    const listings: MarketplaceListing[] = Object.values(userSlots.slots).filter(
      (slot): slot is MarketplaceListing => slot !== null && slot !== undefined,
    );

    listings.sort((a, b) => a.slot - b.slot);

    return buildResponse(200, {
      success: true,
      data: {
        userId,
        listings,
      },
    });
  } catch (error) {
    console.error('Error fetching user listings:', error);
    return buildResponse(500, {
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to fetch user listings',
    });
  }
};
