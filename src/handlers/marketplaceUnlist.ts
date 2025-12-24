import { APIGatewayProxyHandler } from 'aws-lambda';
import { buildResponse } from '../utils/response';
import { db } from '../utils/db';
import { CardListing, PackListing, UserSlots } from '../types/inventory';

interface UnlistRequest {
  userId: string;
  slot: number;
}

/**
 * @route POST /marketplace/unlist
 * @auth
 * @timeout 5
 * @memory 256
 * @description Unlists an item from the marketplace by slot
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

  const { userId, slot } = request;

  if (!userId || !slot) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'userId and slot are required',
    });
  }

  if (!Number.isInteger(slot) || slot < 1 || slot > 4) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'slot must be an integer between 1 and 4',
    });
  }

  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const slotsItem = await db.get(`USER_SLOTS#${userId}`, 'SLOTS');

      if (!slotsItem) {
        return buildResponse(404, {
          success: false,
          error: 'Not Found',
          message: 'No listings found for user',
        });
      }

      const userSlots = slotsItem as UserSlots & { version: number };
      const listing = userSlots.slots[slot];

      if (!listing) {
        return buildResponse(404, {
          success: false,
          error: 'Not Found',
          message: `No listing found in slot ${slot}`,
        });
      }

      const timestamp = new Date().toISOString();
      const operations: Parameters<typeof db.transactWrite>[0] = [];

      if (listing.type === 'card') {
        const cardListing = listing as CardListing;
        operations.push({
          type: 'Delete',
          pk: `LISTING#CARD#${cardListing.cardId}`,
          sk: 'LISTING',
          condition: 'attribute_exists(pk)',
        });
      } else {
        operations.push({
          type: 'Delete',
          pk: `LISTING#PACK#${userId}#${slot}`,
          sk: 'LISTING',
          condition: 'attribute_exists(pk)',
        });

        const inventoryItem = await db.get(`USER#${userId}`, 'INVENTORY');
        const packListing = listing as PackListing;

        if (inventoryItem) {
          const packs = (inventoryItem.packs as Record<string, number>) || {};
          const inventoryVersion = (inventoryItem.version as number) || 0;
          const updatedPacks = { ...packs, [packListing.packName]: (packs[packListing.packName] || 0) + 1 };

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
              packs: { [packListing.packName]: 1 },
              version: 1,
              updatedAt: timestamp,
            },
            condition: 'attribute_not_exists(pk)',
          });
        }
      }

      const updatedSlots = { ...userSlots.slots };
      delete updatedSlots[slot];

      operations.push({
        type: 'Update',
        pk: `USER_SLOTS#${userId}`,
        sk: 'SLOTS',
        updates: {
          slots: updatedSlots,
          version: userSlots.version + 1,
          updatedAt: timestamp,
        },
        condition: '#version = :expectedVersion',
        conditionNames: { '#version': 'version' },
        conditionValues: { ':expectedVersion': userSlots.version },
      });

      await db.transactWrite(operations);

      return buildResponse(200, {
        success: true,
        message: `${listing.type === 'card' ? 'Card' : 'Pack'} unlisted successfully`,
        data: { slot, type: listing.type },
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
