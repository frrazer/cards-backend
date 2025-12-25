import { APIGatewayProxyHandler } from 'aws-lambda';
import { buildResponse } from '../utils/response';
import { db } from '../utils/db';
import { PackListing, MarketplaceListing } from '../types/inventory';

interface UnlistCardRequest {
  type: 'card';
  userId: string;
  cardId: string;
}

interface UnlistPackRequest {
  type: 'pack';
  userId: string;
  listingId: string;
}

type UnlistRequest = UnlistCardRequest | UnlistPackRequest;

async function getUserListings(userId: string): Promise<MarketplaceListing[]> {
  const userListingsResult = await db.query(`USER_LISTINGS#${userId}`);
  if (userListingsResult.items.length === 0) return [];

  const listingKeys = userListingsResult.items.map(item => {
    const sk = item.sk as string;
    if (sk.startsWith('CARD#')) {
      return { pk: `LISTING#CARD#${sk.replace('CARD#', '')}`, sk: 'LISTING' };
    } else {
      return { pk: `LISTING#PACK#${sk.replace('PACK#', '')}`, sk: 'LISTING' };
    }
  });

  const listingItems = await db.batchGet(listingKeys);
  return listingItems
    .map(item => item as unknown as MarketplaceListing)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

/**
 * @route POST /marketplace/unlist
 * @auth
 * @timeout 5
 * @memory 256
 * @description Unlists an item from the marketplace
 */
export const handler: APIGatewayProxyHandler = async event => {
  if (!event.body) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'Request body is required',
    });
  }

  let request: UnlistRequest;
  try {
    request = JSON.parse(event.body) as UnlistRequest;
  } catch {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'Invalid JSON in request body',
    });
  }

  const { type, userId } = request;

  if (!type || !userId) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'type and userId are required',
    });
  }

  if (type !== 'card' && type !== 'pack') {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'type must be "card" or "pack"',
    });
  }

  if (type === 'card' && !('cardId' in request && request.cardId)) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'cardId is required for card unlisting',
    });
  }

  if (type === 'pack' && !('listingId' in request && request.listingId)) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'listingId is required for pack unlisting',
    });
  }

  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const timestamp = new Date().toISOString();
      const operations: Parameters<typeof db.transactWrite>[0] = [];

      if (type === 'card') {
        const cardId = (request as UnlistCardRequest).cardId;

        const listingItem = await db.get(`LISTING#CARD#${cardId}`, 'LISTING');
        if (!listingItem) {
          return buildResponse(404, {
            success: false,
            error: 'Not Found',
            message: 'Listing not found',
          });
        }

        if (listingItem.sellerId !== userId) {
          return buildResponse(403, {
            success: false,
            error: 'Forbidden',
            message: 'You can only unlist your own items',
          });
        }

        operations.push({
          type: 'Delete',
          pk: `LISTING#CARD#${cardId}`,
          sk: 'LISTING',
          condition: 'attribute_exists(pk)',
        });

        operations.push({
          type: 'Delete',
          pk: `USER_LISTINGS#${userId}`,
          sk: `CARD#${cardId}`,
        });
      } else {
        const listingId = (request as UnlistPackRequest).listingId;

        const listingItem = await db.get(`LISTING#PACK#${listingId}`, 'LISTING');
        if (!listingItem) {
          return buildResponse(404, {
            success: false,
            error: 'Not Found',
            message: 'Listing not found',
          });
        }

        const listing = listingItem as unknown as PackListing;

        if (listing.sellerId !== userId) {
          return buildResponse(403, {
            success: false,
            error: 'Forbidden',
            message: 'You can only unlist your own items',
          });
        }

        operations.push({
          type: 'Delete',
          pk: `LISTING#PACK#${listingId}`,
          sk: 'LISTING',
          condition: 'attribute_exists(pk)',
        });

        operations.push({
          type: 'Delete',
          pk: `USER_LISTINGS#${userId}`,
          sk: `PACK#${listingId}`,
        });

        const inventoryItem = await db.get(`USER#${userId}`, 'INVENTORY');

        if (inventoryItem) {
          const packs = (inventoryItem.packs as Record<string, number>) || {};
          const inventoryVersion = (inventoryItem.version as number) || 0;
          const updatedPacks = { ...packs, [listing.packName]: (packs[listing.packName] || 0) + 1 };

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
        } else {
          operations.push({
            type: 'Put',
            pk: `USER#${userId}`,
            sk: 'INVENTORY',
            item: {
              userId,
              cards: [],
              packs: { [listing.packName]: 1 },
              version: 1,
              updatedAt: timestamp,
            },
            condition: 'attribute_not_exists(pk)',
          });
        }
      }

      await db.transactWrite(operations);

      // Fetch updated listings
      const updatedListings = await getUserListings(userId);

      return buildResponse(200, {
        success: true,
        message: `${type === 'card' ? 'Card' : 'Pack'} unlisted successfully`,
        data: {
          type,
          listings: updatedListings,
          listingsCount: updatedListings.length,
        },
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'TransactionCanceledException') {
        console.log(`Transaction conflict on attempt ${attempt + 1}, retrying...`);
        if (attempt === MAX_RETRIES - 1) {
          return buildResponse(409, {
            success: false,
            error: 'Conflict',
            message: 'Listing was modified or already removed',
          });
        }
        await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
        continue;
      }

      console.error('Error unlisting item:', error);
      return buildResponse(500, {
        success: false,
        error: 'Internal Server Error',
        message: 'Failed to unlist item',
      });
    }
  }

  return buildResponse(500, {
    success: false,
    error: 'Internal Server Error',
    message: 'Max retries exceeded',
  });
};
