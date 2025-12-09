import { APIGatewayProxyHandler } from 'aws-lambda';
import { buildResponse } from '../utils/response';
import { db } from '../utils/db';
import { InventoryCard } from '../types/inventory';

interface Transfer {
  fromUserId: string;
  toUserId: string;
  cards?: Array<{ cardId: string }>;
  packs?: Array<{ packName: string; quantity: number }>;
}

interface TradeRequest {
  transfers: Transfer[];
}

const IDEMPOTENCY_TTL_SECONDS = 600;
async function idempotentResponse(key: string, statusCode: number, body: Record<string, unknown>) {
  await db.update(`IDEMPOTENCY#${key}`, 'TRANSFER', {
    status: 'completed',
    statusCode,
    response: body,
    completedAt: new Date().toISOString(),
  });
  return buildResponse(statusCode, body);
}

/**
 * @route POST /transfer
 * @auth
 * @timeout 10
 * @memory 256
 * @description Atomically execute multi-way trades between users
 */
export const handler: APIGatewayProxyHandler = async event => {
  const idempotencyKey = event.headers['Idempotency-Key'] || event.headers['idempotency-key'];

  if (!idempotencyKey) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'Idempotency-Key header is required for transfer operations',
    });
  }

  const existing = await db.get(`IDEMPOTENCY#${idempotencyKey}`, 'TRANSFER');
  if (existing) {
    if (existing.status === 'processing') {
      return buildResponse(409, {
        success: false,
        error: 'Conflict',
        message: 'This request is already being processed',
      });
    }
    return buildResponse(existing.statusCode as number, existing.response as Record<string, unknown>);
  }

  try {
    await db.put({
      pk: `IDEMPOTENCY#${idempotencyKey}`,
      sk: 'TRANSFER',
      status: 'processing',
      createdAt: new Date().toISOString(),
      ttl: Math.floor(Date.now() / 1000) + IDEMPOTENCY_TTL_SECONDS,
      condition: 'attribute_not_exists(pk)',
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      return buildResponse(409, {
        success: false,
        error: 'Conflict',
        message: 'This request is already being processed',
      });
    }
    throw error;
  }

  if (!event.body) {
    return idempotentResponse(idempotencyKey, 400, {
      success: false,
      error: 'Bad Request',
      message: 'Request body is required',
    });
  }

  let request: TradeRequest;
  try {
    request = JSON.parse(event.body) as TradeRequest;
  } catch {
    return idempotentResponse(idempotencyKey, 400, {
      success: false,
      error: 'Bad Request',
      message: 'Invalid JSON in request body',
    });
  }

  const { transfers } = request;

  if (!transfers?.length) {
    return idempotentResponse(idempotencyKey, 400, {
      success: false,
      error: 'Bad Request',
      message: 'At least one transfer is required',
    });
  }

  for (const transfer of transfers) {
    if (!transfer.fromUserId || !transfer.toUserId) {
      return idempotentResponse(idempotencyKey, 400, {
        success: false,
        error: 'Bad Request',
        message: 'Each transfer requires fromUserId and toUserId',
      });
    }

    if (transfer.fromUserId === transfer.toUserId) {
      return idempotentResponse(idempotencyKey, 400, {
        success: false,
        error: 'Bad Request',
        message: 'Cannot transfer to self',
      });
    }

    if (!transfer.cards?.length && !transfer.packs?.length) {
      return idempotentResponse(idempotencyKey, 400, {
        success: false,
        error: 'Bad Request',
        message: 'Each transfer must specify at least one card or pack',
      });
    }
  }

  const uniqueUserIds = [...new Set(transfers.flatMap(t => [t.fromUserId, t.toUserId]))];

  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const items = await Promise.all(uniqueUserIds.map(userId => db.get(`USER#${userId}`, 'INVENTORY')));

      const inventories = new Map(
        uniqueUserIds.map((userId, index) => [
          userId,
          items[index]
            ? {
                userId: items[index].userId as string,
                packs: (items[index].packs as Record<string, number>) || {},
                cards: (items[index].cards as InventoryCard[]) || [],
                version: (items[index].version as number) || 0,
                exists: true,
              }
            : {
                userId,
                packs: {},
                cards: [],
                version: 0,
                exists: false,
              },
        ]),
      );

      for (const { fromUserId, toUserId, cards, packs } of transfers) {
        const fromInventory = inventories.get(fromUserId);
        const toInventory = inventories.get(toUserId);

        if (!fromInventory || !toInventory) {
          return buildResponse(500, {
            success: false,
            error: 'Internal Server Error',
            message: 'Failed to load user inventory',
          });
        }

        if (!fromInventory.exists) {
          return idempotentResponse(idempotencyKey, 404, {
            success: false,
            error: 'Not Found',
            message: `Inventory not found for user ${fromUserId}`,
          });
        }

        if (cards?.length) {
          for (const { cardId } of cards) {
            const cardIndex = fromInventory.cards.findIndex(c => c.cardId === cardId);
            if (cardIndex === -1) {
              return idempotentResponse(idempotencyKey, 400, {
                success: false,
                error: 'Bad Request',
                message: `Card ${cardId} not found in ${fromUserId}'s inventory`,
              });
            }
            toInventory.cards.push(fromInventory.cards[cardIndex]);
            fromInventory.cards.splice(cardIndex, 1);
          }
        }

        if (packs?.length) {
          for (const { packName, quantity } of packs) {
            if ((fromInventory.packs[packName] || 0) < quantity) {
              return idempotentResponse(idempotencyKey, 400, {
                success: false,
                error: 'Bad Request',
                message: `Insufficient packs. User ${fromUserId} has ${
                  fromInventory.packs[packName] || 0
                } ${packName} but trying to send ${quantity}`,
              });
            }
            fromInventory.packs[packName] -= quantity;
            if (fromInventory.packs[packName] === 0) delete fromInventory.packs[packName];
            toInventory.packs[packName] = (toInventory.packs[packName] || 0) + quantity;
          }
        }
      }

      const operations: Parameters<typeof db.transactWrite>[0] = [];

      for (const [userId, inventory] of inventories) {
        inventory.version++;

        if (inventory.exists) {
          operations.push({
            type: 'Update',
            pk: `USER#${userId}`,
            sk: 'INVENTORY',
            updates: {
              cards: inventory.cards,
              packs: inventory.packs,
              version: inventory.version,
              updatedAt: new Date().toISOString(),
            },
            condition: '#version = :expectedVersion',
            conditionNames: {
              '#version': 'version',
            },
            conditionValues: {
              ':expectedVersion': inventory.version - 1,
            },
          });
        } else {
          operations.push({
            type: 'Put',
            pk: `USER#${userId}`,
            sk: 'INVENTORY',
            item: {
              userId,
              cards: inventory.cards,
              packs: inventory.packs,
              version: inventory.version,
              updatedAt: new Date().toISOString(),
            },
            condition: 'attribute_not_exists(pk)',
          });
        }
      }

      await db.transactWrite(operations);

      return idempotentResponse(idempotencyKey, 200, {
        success: true,
        message: 'Trade completed successfully',
        data: Object.fromEntries(
          Array.from(inventories.entries()).map(([userId, inv]) => [userId, { cards: inv.cards, packs: inv.packs }]),
        ),
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'TransactionCanceledException') {
        console.log(`Transaction conflict on attempt ${attempt + 1}, retrying...`);
        if (attempt === MAX_RETRIES - 1) {
          return buildResponse(409, {
            success: false,
            error: 'Conflict',
            message: 'Trade failed due to concurrent modifications. Please retry.',
          });
        }
        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
        continue;
      }

      console.error('Error in trade:', error);
      return buildResponse(500, {
        success: false,
        error: 'Internal Server Error',
        message: 'Failed to complete trade',
      });
    }
  }

  return buildResponse(500, {
    success: false,
    error: 'Internal Server Error',
    message: 'Max retries exceeded',
  });
};
