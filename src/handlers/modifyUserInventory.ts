import { APIGatewayProxyHandler } from 'aws-lambda';
import { buildResponse } from '../utils/response';
import { db } from '../utils/db';
import { ModifyInventoryRequest, UserInventory, InventoryCard } from '../types/inventory';

/**
 * @route POST /user/inventory/modify
 * @auth
 * @timeout 5
 * @memory 256
 * @description Modifies a user's inventory
 */
export const handler: APIGatewayProxyHandler = async event => {
  if (!event.body) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'Request body is required',
    });
  }

  let request: ModifyInventoryRequest;
  try {
    request = JSON.parse(event.body) as ModifyInventoryRequest;
  } catch {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'Invalid JSON in request body',
    });
  }

  const { userId, operations } = request;

  if (!userId || !operations || !Array.isArray(operations)) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'userId and operations array are required',
    });
  }

  if (operations.length === 0) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'At least one operation is required',
    });
  }

  const pk = `USER#${userId}`;
  const sk = 'INVENTORY';

  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const item = await db.get(pk, sk);
      let inventory: UserInventory;
      let currentVersion: number;

      if (!item) {
        inventory = {
          userId,
          packs: {},
          cards: [],
          totalYps: 0,
          version: 0,
        };
        currentVersion = 0;
      } else {
        inventory = {
          userId: item.userId as string,
          packs: (item.packs as Record<string, number>) || {},
          cards: (item.cards as InventoryCard[]) || [],
          totalYps: (item.totalYps as number) || 0,
          version: (item.version as number) || 0,
        };
        currentVersion = inventory.version || 0;
      }

      for (const operation of operations) {
        switch (operation.action) {
          case 'addCard': {
            if (!operation.card || !operation.card.cardId || !operation.card.cardName) {
              return buildResponse(400, {
                success: false,
                error: 'Bad Request',
                message: 'addCard requires card with cardId and cardName',
              });
            }
            if (typeof operation.card.yps !== 'number') {
              return buildResponse(400, {
                success: false,
                error: 'Bad Request',
                message: 'addCard requires card with yps (yenPerSecond) field',
              });
            }
            inventory.cards.push({
              ...operation.card,
              placed: operation.card.placed ?? false,
            });
            break;
          }

          case 'removeCard': {
            if (!operation.cardId) {
              return buildResponse(400, {
                success: false,
                error: 'Bad Request',
                message: 'removeCard requires cardId',
              });
            }
            const index = inventory.cards.findIndex(card => card.cardId === operation.cardId);
            if (index === -1) {
              return buildResponse(404, {
                success: false,
                error: 'Not Found',
                message: `Card with id ${operation.cardId} not found in inventory`,
              });
            }
            inventory.cards.splice(index, 1);
            break;
          }

          case 'addPack': {
            if (!operation.packName) {
              return buildResponse(400, {
                success: false,
                error: 'Bad Request',
                message: 'addPack requires packName',
              });
            }
            inventory.packs[operation.packName] =
              (inventory.packs[operation.packName] || 0) + (operation.quantity || 1);
            break;
          }

          case 'updateCardPlaced': {
            if (!operation.cardId) {
              return buildResponse(400, {
                success: false,
                error: 'Bad Request',
                message: 'updateCardPlaced requires cardId',
              });
            }
            if (typeof operation.placed !== 'boolean') {
              return buildResponse(400, {
                success: false,
                error: 'Bad Request',
                message: 'updateCardPlaced requires placed (boolean)',
              });
            }
            const card = inventory.cards.find(c => c.cardId === operation.cardId);
            if (!card) {
              return buildResponse(404, {
                success: false,
                error: 'Not Found',
                message: `Card with id ${operation.cardId} not found in inventory`,
              });
            }
            card.placed = operation.placed;
            break;
          }

          case 'removePack': {
            if (!operation.packName) {
              return buildResponse(400, {
                success: false,
                error: 'Bad Request',
                message: 'removePack requires packName',
              });
            }
            const quantity = operation.quantity || 1;
            const currentCount = inventory.packs[operation.packName] || 0;
            if (currentCount < quantity) {
              return buildResponse(400, {
                success: false,
                error: 'Bad Request',
                message: `Insufficient packs. Trying to remove ${quantity} but only have ${currentCount}`,
              });
            }
            inventory.packs[operation.packName] -= quantity;
            if (inventory.packs[operation.packName] === 0) {
              delete inventory.packs[operation.packName];
            }
            break;
          }

          default: {
            return buildResponse(400, {
              success: false,
              error: 'Bad Request',
              message: `Unknown action: ${(operation as unknown as { action: string }).action}`,
            });
          }
        }
      }

      const newVersion = currentVersion + 1;
      inventory.version = newVersion;
      inventory.totalYps = inventory.cards.filter(card => card.placed).reduce((sum, card) => sum + card.yps, 0);

      if (
        (
          await db.conditionalPut(
            {
              pk,
              sk,
              userId: inventory.userId,
              packs: inventory.packs,
              cards: inventory.cards,
              totalYps: inventory.totalYps,
              version: newVersion,
              updatedAt: new Date().toISOString(),
            },
            currentVersion === 0 ? undefined : currentVersion,
          )
        ).success
      ) {
        return buildResponse(200, {
          success: true,
          message: 'Inventory updated successfully',
          data: inventory,
        });
      }

      console.log(`Version mismatch on attempt ${attempt + 1}, retrying...`);
      if (attempt === MAX_RETRIES - 1) {
        return buildResponse(409, {
          success: false,
          error: 'Conflict',
          message: 'Inventory was modified by another request. Please retry.',
        });
      }
      await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
    } catch (error) {
      if (error instanceof Error) {
        console.error('Error modifying user inventory:', error.message);
      } else {
        console.error('Error modifying user inventory:', String(error));
      }
      return buildResponse(500, {
        success: false,
        error: 'Internal Server Error',
        message: 'Failed to modify user inventory',
      });
    }
  }

  return buildResponse(500, {
    success: false,
    error: 'Internal Server Error',
    message: 'Max retries exceeded',
  });
};
