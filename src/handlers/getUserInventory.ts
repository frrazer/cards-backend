import { APIGatewayProxyHandler } from 'aws-lambda';
import { buildResponse } from '../utils/response';
import { db } from '../utils/db';
import { InventoryCard } from '../types/inventory';

/**
 * @route GET /user/inventory/{userId}
 * @timeout 3
 * @memory 128
 * @description Retrieves a user's inventory
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
    const item = await db.get(`USER#${userId}`, 'INVENTORY');

    if (!item) {
      return buildResponse(200, {
        success: true,
        data: {
          userId,
          packs: {},
          cards: [],
          totalYps: 0,
          version: 0,
        },
      });
    }

    const cards = (item.cards as Array<InventoryCard>) || [];
    const totalYps = cards.reduce((sum, card) => sum + (card.yps || 0), 0);

    return buildResponse(200, {
      success: true,
      data: {
        userId: item.userId as string,
        packs: (item.packs as Record<string, number>) || {},
        cards,
        totalYps,
        version: (item.version as number) || 0,
      },
    });
  } catch (error) {
    console.error('Error fetching user inventory:', error);
    return buildResponse(500, {
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to fetch user inventory',
    });
  }
};
