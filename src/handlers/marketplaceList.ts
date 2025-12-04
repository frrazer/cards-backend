import { APIGatewayProxyHandler } from 'aws-lambda';
import { buildResponse } from '../utils/response';
import { db } from '../utils/db';
import { InventoryCard, MarketplaceListing } from '../types/inventory';

interface ListCardRequest {
  userId: string;
  username: string;
  cardId: string;
  cost: number;
}

const padCost = (cost: number): string => cost.toString().padStart(15, '0');

/**
 * @route POST /marketplace/list
 * @auth
 * @timeout 5
 * @memory 256
 * @description Lists a card for sale on the marketplace
 */
export const handler: APIGatewayProxyHandler = async event => {
  if (!event.body) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'Request body is required',
    });
  }

  let request: ListCardRequest;
  try {
    request = JSON.parse(event.body) as ListCardRequest;
  } catch {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'Invalid JSON in request body',
    });
  }

  const { userId, username, cardId, cost } = request;

  if (!userId || !username || !cardId || cost === undefined) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'userId, username, cardId, and cost are required',
    });
  }

  if (typeof cost !== 'number' || cost < 1 || !Number.isInteger(cost)) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'cost must be a positive integer',
    });
  }

  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const existingListing = await db.get(`LISTING#${cardId}`, 'LISTING');
      if (existingListing) {
        return buildResponse(409, {
          success: false,
          error: 'Conflict',
          message: 'This card is already listed on the marketplace',
        });
      }

      const inventoryItem = await db.get(`USER#${userId}`, 'INVENTORY');
      if (!inventoryItem) {
        return buildResponse(404, {
          success: false,
          error: 'Not Found',
          message: 'User inventory not found',
        });
      }

      const cards = (inventoryItem.cards as InventoryCard[]) || [];
      const card = cards.find(c => c.cardId === cardId);

      if (!card) {
        return buildResponse(404, {
          success: false,
          error: 'Not Found',
          message: 'Card not found in user inventory',
        });
      }

      const listing: MarketplaceListing = {
        cardId,
        cardName: card.cardName,
        cardLevel: card.level,
        cardVariant: card.variant,
        sellerId: userId,
        sellerUsername: username,
        cost,
        listedAt: new Date().toISOString(),
      };

      const paddedCost = padCost(cost);

      await db.transactWrite([
        {
          type: 'Put',
          pk: `LISTING#${cardId}`,
          sk: 'LISTING',
          item: { ...listing },
          condition: 'attribute_not_exists(pk)',
        },
        {
          type: 'Put',
          pk: `MARKET#${card.cardName}#${card.level}`,
          sk: `${paddedCost}#${cardId}`,
          item: { cardId },
          condition: 'attribute_not_exists(pk)',
        },
        {
          type: 'Put',
          pk: 'MARKET_ALL',
          sk: `${paddedCost}#${card.cardName}#${card.level}#${cardId}`,
          item: { cardId },
          condition: 'attribute_not_exists(pk)',
        },
      ]);

      return buildResponse(200, {
        success: true,
        message: 'Card listed successfully',
        data: listing,
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'TransactionCanceledException') {
        console.log(`Transaction conflict on attempt ${attempt + 1}, retrying...`);
        if (attempt === MAX_RETRIES - 1) {
          return buildResponse(409, {
            success: false,
            error: 'Conflict',
            message: 'Failed to list card due to concurrent operation. Please retry.',
          });
        }
        await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
        continue;
      }

      console.error('Error listing card:', error);
      return buildResponse(500, {
        success: false,
        error: 'Internal Server Error',
        message: 'Failed to list card',
      });
    }
  }

  return buildResponse(500, {
    success: false,
    error: 'Internal Server Error',
    message: 'Max retries exceeded',
  });
};
