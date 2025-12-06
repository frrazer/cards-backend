import { APIGatewayProxyHandler } from 'aws-lambda';
import { buildResponse } from '../utils/response';
import { db } from '../utils/db';
import { MarketplaceListing } from '../types/inventory';

interface UnlistCardRequest {
  cardId: string;
}

const padCost = (cost: number): string => cost.toString().padStart(15, '0');

/**
 * @route POST /marketplace/unlist
 * @auth
 * @timeout 5
 * @memory 256
 * @description Unlists a card from the marketplace
 */
export const handler: APIGatewayProxyHandler = async event => {
  if (!event.body) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'Request body is required',
    });
  }

  let request: UnlistCardRequest;
  try {
    request = JSON.parse(event.body) as UnlistCardRequest;
  } catch {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'Invalid JSON in request body',
    });
  }

  const { cardId } = request;

  if (!cardId) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'cardId is required',
    });
  }

  try {
    const listingItem = await db.get(`LISTING#${cardId}`, 'LISTING');
    if (!listingItem) {
      return buildResponse(404, {
        success: false,
        error: 'Not Found',
        message: 'Listing not found',
      });
    }

    const listing = listingItem as unknown as MarketplaceListing;
    const cardLevel = listing.cardLevel ?? 1;
    const paddedCost = padCost(listing.cost);

    await db.transactWrite([
      {
        type: 'Delete',
        pk: `LISTING#${cardId}`,
        sk: 'LISTING',
        condition: 'attribute_exists(pk)',
      },
      {
        type: 'Delete',
        pk: `MARKET#${listing.cardName}#${cardLevel}`,
        sk: `${paddedCost}#${cardId}`,
      },
      {
        type: 'Delete',
        pk: 'MARKET_ALL',
        sk: `${paddedCost}#${listing.cardName}#${cardLevel}#${cardId}`,
      },
    ]);

    return buildResponse(200, {
      success: true,
      message: 'Card unlisted successfully',
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'TransactionCanceledException') {
      return buildResponse(409, {
        success: false,
        error: 'Conflict',
        message: 'Listing was modified or already removed',
      });
    }

    console.error('Error unlisting card:', error);
    return buildResponse(500, {
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to unlist card',
    });
  }
};
