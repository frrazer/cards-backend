import { APIGatewayProxyHandler } from 'aws-lambda';
import { buildResponse, badRequest, conflict } from '../utils/response';
import { parseBody } from '../utils/request';
import { withRetry } from '../utils/retry';
import { db } from '../utils/db';
import { parseInventoryItem, ParsedInventory } from '../utils/inventory';
import { RouteConfig } from '../types/route';

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

export const route: RouteConfig = {
  method: 'POST',
  path: '/transfer',
  auth: true,
  timeout: 10,
  memory: 256,
};

export const handler: APIGatewayProxyHandler = async event => {
  const idempotencyKey = event.headers['Idempotency-Key'] || event.headers['idempotency-key'];

  if (!idempotencyKey) {
    return badRequest('Idempotency-Key header is required for transfer operations');
  }

  const existing = await db.get(`IDEMPOTENCY#${idempotencyKey}`, 'TRANSFER');
  if (existing) {
    if (existing.status === 'processing') {
      return conflict('This request is already being processed');
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
      return conflict('This request is already being processed');
    }
    throw error;
  }

  const parsed = parseBody<TradeRequest>(event.body);
  if (!parsed.success) {
    const response = JSON.parse(parsed.response.body);
    return idempotentResponse(idempotencyKey, parsed.response.statusCode, response);
  }

  const { transfers } = parsed.data;

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

  return withRetry(
    async () => {
      const items = await Promise.all(uniqueUserIds.map(userId => db.get(`USER#${userId}`, 'INVENTORY')));
      const inventories = new Map<string, ParsedInventory>(
        uniqueUserIds.map((userId, index) => [userId, parseInventoryItem(userId, items[index])]),
      );

      for (const { fromUserId, toUserId, cards, packs } of transfers) {
        const fromInventory = inventories.get(fromUserId);
        const toInventory = inventories.get(toUserId);

        if (!fromInventory || !toInventory) {
          return idempotentResponse(idempotencyKey, 500, {
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

      const timestamp = new Date().toISOString();
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
              updatedAt: timestamp,
            },
            condition: '#version = :expectedVersion',
            conditionNames: { '#version': 'version' },
            conditionValues: { ':expectedVersion': inventory.version - 1 },
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
              updatedAt: timestamp,
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
    },
    { baseDelayMs: 100, conflictMessage: 'Trade failed due to concurrent modifications. Please retry.' },
  );
};
