import { APIGatewayProxyHandler } from 'aws-lambda';
import { buildResponse } from '../utils/response';
import { db } from '../utils/db';
import { InventoryCard, CardListing, PackListing, MarketplaceListing } from '../types/inventory';
import { randomUUID } from 'crypto';

interface ListCardRequest {
  type: 'card';
  userId: string;
  username: string;
  cardId: string;
  cost: number;
}

interface ListPackRequest {
  type: 'pack';
  userId: string;
  username: string;
  packName: string;
  cost: number;
}

type ListRequest = ListCardRequest | ListPackRequest;

const MAX_LISTINGS = 256;

/**
 * @route POST /marketplace/list
 * @auth
 * @timeout 5
 * @memory 256
 * @description Lists a card or pack for sale on the marketplace (max 50 per user)
 */
export const handler: APIGatewayProxyHandler = async event => {
  if (!event.body) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'Request body is required',
    });
  }

  let request: ListRequest;
  try {
    request = JSON.parse(event.body) as ListRequest;
  } catch {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'Invalid JSON in request body',
    });
  }

  const { type, userId, username, cost } = request;

  if (!type || !userId || !username || cost === undefined) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'type, userId, username, and cost are required',
    });
  }

  if (type !== 'card' && type !== 'pack') {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'type must be "card" or "pack"',
    });
  }

  if (typeof cost !== 'number' || cost < 1 || !Number.isInteger(cost)) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'cost must be a positive integer',
    });
  }

  if (type === 'card' && !('cardId' in request && request.cardId)) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'cardId is required for card listings',
    });
  }

  if (type === 'pack' && !('packName' in request && request.packName)) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'packName is required for pack listings',
    });
  }

  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // Get user's current listing count and inventory
      const [userListingsResult, inventoryItem] = await Promise.all([
        db.query(`USER_LISTINGS#${userId}`),
        db.get(`USER#${userId}`, 'INVENTORY'),
      ]);

      if (!inventoryItem) {
        return buildResponse(404, {
          success: false,
          error: 'Not Found',
          message: 'User inventory not found',
        });
      }

      const currentListingCount = userListingsResult.items.length;
      if (currentListingCount >= MAX_LISTINGS) {
        return buildResponse(400, {
          success: false,
          error: 'Bad Request',
          message: `Maximum of ${MAX_LISTINGS} listings reached`,
        });
      }

      const timestamp = new Date().toISOString();
      let listing: MarketplaceListing;
      const operations: Parameters<typeof db.transactWrite>[0] = [];

      if (type === 'card') {
        const cardId = (request as ListCardRequest).cardId;
        const cards = (inventoryItem.cards as InventoryCard[]) || [];
        const card = cards.find(c => c.cardId === cardId);

        if (!card) {
          return buildResponse(404, {
            success: false,
            error: 'Not Found',
            message: 'Card not found in user inventory',
          });
        }

        const existingListing = await db.get(`LISTING#CARD#${cardId}`, 'LISTING');
        if (existingListing) {
          return buildResponse(409, {
            success: false,
            error: 'Conflict',
            message: 'This card is already listed on the marketplace',
          });
        }

        listing = {
          type: 'card',
          cardName: card.cardName,
          cardId,
          cardLevel: card.level ?? 1,
          cardVariant: card.variant ?? 'Normal',
          sellerId: userId,
          sellerUsername: username,
          cost,
          timestamp,
        } satisfies CardListing;

        operations.push({
          type: 'Put',
          pk: `LISTING#CARD#${cardId}`,
          sk: 'LISTING',
          item: { ...listing },
          condition: 'attribute_not_exists(pk)',
        });

        operations.push({
          type: 'Put',
          pk: `USER_LISTINGS#${userId}`,
          sk: `CARD#${cardId}`,
          item: { cardId, type: 'card' },
          condition: 'attribute_not_exists(pk)',
        });
      } else {
        const packName = (request as ListPackRequest).packName;
        const packs = (inventoryItem.packs as Record<string, number>) || {};

        if (!packs[packName] || packs[packName] < 1) {
          return buildResponse(404, {
            success: false,
            error: 'Not Found',
            message: 'Pack not found in user inventory or insufficient quantity',
          });
        }

        const listingId = randomUUID();

        listing = {
          type: 'pack',
          listingId,
          packName,
          sellerId: userId,
          sellerUsername: username,
          cost,
          timestamp,
        } satisfies PackListing;

        operations.push({
          type: 'Put',
          pk: `LISTING#PACK#${listingId}`,
          sk: 'LISTING',
          item: { ...listing },
          condition: 'attribute_not_exists(pk)',
        });

        operations.push({
          type: 'Put',
          pk: `USER_LISTINGS#${userId}`,
          sk: `PACK#${listingId}`,
          item: { listingId, packName, type: 'pack' },
          condition: 'attribute_not_exists(pk)',
        });

        // Decrement pack from inventory
        const inventoryVersion = (inventoryItem.version as number) || 0;
        const updatedPacks = { ...packs, [packName]: packs[packName] - 1 };
        if (updatedPacks[packName] === 0) delete updatedPacks[packName];

        operations.push({
          type: 'Update',
          pk: `USER#${userId}`,
          sk: 'INVENTORY',
          updates: {
            packs: updatedPacks,
            version: inventoryVersion + 1,
            updatedAt: timestamp,
          },
          condition: '#version = :expectedVersion',
          conditionNames: { '#version': 'version' },
          conditionValues: { ':expectedVersion': inventoryVersion },
        });
      }

      await db.transactWrite(operations);

      return buildResponse(200, {
        success: true,
        message: `${type === 'card' ? 'Card' : 'Pack'} listed successfully`,
        data: listing,
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'TransactionCanceledException') {
        console.log(`Transaction conflict on attempt ${attempt + 1}, retrying...`);
        if (attempt === MAX_RETRIES - 1) {
          return buildResponse(409, {
            success: false,
            error: 'Conflict',
            message: 'Failed to list item due to concurrent operation. Please retry.',
          });
        }
        await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
        continue;
      }

      console.error('Error listing item:', error);
      return buildResponse(500, {
        success: false,
        error: 'Internal Server Error',
        message: 'Failed to list item',
      });
    }
  }

  return buildResponse(500, {
    success: false,
    error: 'Internal Server Error',
    message: 'Max retries exceeded',
  });
};
