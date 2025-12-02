import { APIGatewayProxyHandler } from 'aws-lambda';
import { buildResponse } from '../utils/response';
import { db } from '../utils/db';
import { InventoryCard } from '../types/inventory';

interface TransferRequest {
  fromUserId: string;
  toUserId: string;
  cards?: Array<{ cardId: string }>;
  packs?: Array<{ packName: string; quantity: number }>;
}

/**
 * @route POST /transfer
 * @auth
 * @timeout 10
 * @memory 256
 * @description Atomically transfer cards/packs between users
 */
export const handler: APIGatewayProxyHandler = async event => {
  if (!event.body) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'Request body is required',
    });
  }

  let request: TransferRequest;
  try {
    request = JSON.parse(event.body) as TransferRequest;
  } catch {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'Invalid JSON in request body',
    });
  }

  const { fromUserId, toUserId, cards, packs } = request;

  if (!fromUserId || !toUserId) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'fromUserId and toUserId are required',
    });
  }

  if (fromUserId === toUserId) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'Cannot transfer to self',
    });
  }

  if (!cards?.length && !packs?.length) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'At least one card or pack must be specified for transfer',
    });
  }

  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const [fromItem, toItem] = await Promise.all([
        db.get(`USER#${fromUserId}`, 'INVENTORY'),
        db.get(`USER#${toUserId}`, 'INVENTORY'),
      ]);

      if (!fromItem) {
        return buildResponse(404, {
          success: false,
          error: 'Not Found',
          message: `Sender inventory not found`,
        });
      }

      const fromInventory = {
        userId: fromItem.userId as string,
        packs: (fromItem.packs as Record<string, number>) || {},
        cards: (fromItem.cards as InventoryCard[]) || [],
        version: (fromItem.version as number) || 0,
      };

      const toInventory = toItem
        ? {
            userId: toItem.userId as string,
            packs: (toItem.packs as Record<string, number>) || {},
            cards: (toItem.cards as InventoryCard[]) || [],
            version: (toItem.version as number) || 0,
          }
        : {
            userId: toUserId,
            packs: {},
            cards: [],
            version: 0,
          };

      if (cards?.length) {
        for (const { cardId } of cards) {
          const cardIndex = fromInventory.cards.findIndex(c => c.cardId === cardId);
          if (cardIndex === -1) {
            return buildResponse(400, {
              success: false,
              error: 'Bad Request',
              message: `Card ${cardId} not found in sender's inventory`,
            });
          }
          toInventory.cards.push(fromInventory.cards[cardIndex]);
          fromInventory.cards.splice(cardIndex, 1);
        }
      }

      if (packs?.length) {
        for (const { packName, quantity } of packs) {
          if ((fromInventory.packs[packName] || 0) < quantity) {
            return buildResponse(400, {
              success: false,
              error: 'Bad Request',
              message: `Insufficient packs. Sender has ${
                fromInventory.packs[packName] || 0
              } ${packName} but trying to send ${quantity}`,
            });
          }
          fromInventory.packs[packName] -= quantity;
          if (fromInventory.packs[packName] === 0) delete fromInventory.packs[packName];
          toInventory.packs[packName] = (toInventory.packs[packName] || 0) + quantity;
        }
      }

      fromInventory.version++;
      toInventory.version++;

      const operations: Parameters<typeof db.transactWrite>[0] = [
        {
          type: 'Update',
          pk: `USER#${fromUserId}`,
          sk: 'INVENTORY',
          updates: {
            cards: fromInventory.cards,
            packs: fromInventory.packs,
            version: fromInventory.version,
            updatedAt: new Date().toISOString(),
          },
          condition: '#version = :expectedVersion',
          conditionNames: {
            '#version': 'version',
          },
          conditionValues: {
            ':expectedVersion': fromInventory.version - 1,
          },
        },
      ];

      if (toItem) {
        operations.push({
          type: 'Update',
          pk: `USER#${toUserId}`,
          sk: 'INVENTORY',
          updates: {
            cards: toInventory.cards,
            packs: toInventory.packs,
            version: toInventory.version,
            updatedAt: new Date().toISOString(),
          },
          condition: '#version = :expectedVersion',
          conditionNames: {
            '#version': 'version',
          },
          conditionValues: {
            ':expectedVersion': toInventory.version - 1,
          },
        });
      } else {
        operations.push({
          type: 'Put',
          pk: `USER#${toUserId}`,
          sk: 'INVENTORY',
          item: {
            userId: toUserId,
            cards: toInventory.cards,
            packs: toInventory.packs,
            version: toInventory.version,
            updatedAt: new Date().toISOString(),
          },
          condition: 'attribute_not_exists(pk)',
        });
      }

      await db.transactWrite(operations);

      return buildResponse(200, {
        success: true,
        message: 'Transfer completed successfully',
        data: {
          from: {
            userId: fromUserId,
            cards: fromInventory.cards,
            packs: fromInventory.packs,
          },
          to: {
            userId: toUserId,
            cards: toInventory.cards,
            packs: toInventory.packs,
          },
        },
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'TransactionCanceledException') {
        console.log(`Transaction conflict on attempt ${attempt + 1}, retrying...`);
        if (attempt === MAX_RETRIES - 1) {
          return buildResponse(409, {
            success: false,
            error: 'Conflict',
            message: 'Transaction failed due to concurrent modifications. Please retry.',
          });
        }
        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
        continue;
      }

      console.error('Error in transfer:', error);
      return buildResponse(500, {
        success: false,
        error: 'Internal Server Error',
        message: 'Failed to complete transfer',
      });
    }
  }

  return buildResponse(500, {
    success: false,
    error: 'Internal Server Error',
    message: 'Max retries exceeded',
  });
};
