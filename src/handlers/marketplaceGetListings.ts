import { APIGatewayProxyHandler } from 'aws-lambda';
import { buildResponse } from '../utils/response';
import { db } from '../utils/db';
import { MarketplaceListing } from '../types/inventory';

/**
 * @route GET /marketplace/listings/{userId}
 * @timeout 5
 * @memory 256
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
    // Query all user's listing index entries
    const userListingsResult = await db.query(`USER_LISTINGS#${userId}`);

    if (userListingsResult.items.length === 0) {
      return buildResponse(200, {
        success: true,
        data: {
          userId,
          listings: [],
          count: 0,
        },
      });
    }

    // Batch get all actual listings
    const listingKeys = userListingsResult.items.map(item => {
      const sk = item.sk as string;
      if (sk.startsWith('CARD#')) {
        const cardId = sk.replace('CARD#', '');
        return { pk: `LISTING#CARD#${cardId}`, sk: 'LISTING' };
      } else {
        const listingId = sk.replace('PACK#', '');
        return { pk: `LISTING#PACK#${listingId}`, sk: 'LISTING' };
      }
    });

    const listingItems = await db.batchGet(listingKeys);
    const listings = listingItems
      .map(item => item as unknown as MarketplaceListing)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return buildResponse(200, {
      success: true,
      data: {
        userId,
        listings,
        count: listings.length,
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
