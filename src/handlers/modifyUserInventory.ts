import { APIGatewayProxyHandler } from 'aws-lambda';
import { badRequest, notFound, conflict, success, serverError } from '../utils/response';
import { parseBody } from '../utils/request';
import { db } from '../utils/db';
import { parseInventoryItem } from '../utils/inventory';
import { ModifyInventoryRequest } from '../types/inventory';

/**
 * @route POST /user/inventory/modify
 * @auth
 * @timeout 5
 * @memory 256
 * @description Modifies a user's inventory
 */
export const handler: APIGatewayProxyHandler = async event => {
  const parsed = parseBody<ModifyInventoryRequest>(event.body);
  if (!parsed.success) return parsed.response;

  const { userId, operations } = parsed.data;

  if (!userId || !operations || !Array.isArray(operations)) {
    return badRequest('userId and operations array are required');
  }

  if (operations.length === 0) {
    return badRequest('At least one operation is required');
  }

  const pk = `USER#${userId}`;
  const sk = 'INVENTORY';

  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const item = await db.get(pk, sk);
      const inventory = parseInventoryItem(userId, item);

      for (const operation of operations) {
        switch (operation.action) {
          case 'addCard': {
            if (!operation.card || !operation.card.cardId || !operation.card.cardName) {
              return badRequest('addCard requires card with cardId and cardName');
            }
            inventory.cards.push({
              cardId: operation.card.cardId,
              cardName: operation.card.cardName,
              level: operation.card.level ?? 1,
              variant: operation.card.variant ?? 'Normal',
            });
            break;
          }

          case 'removeCard': {
            if (!operation.cardId) return badRequest('removeCard requires cardId');
            const index = inventory.cards.findIndex(card => card.cardId === operation.cardId);
            if (index === -1) return notFound(`Card with id ${operation.cardId} not found in inventory`);
            inventory.cards.splice(index, 1);
            break;
          }

          case 'setCardLevel': {
            if (!operation.cardId || operation.level === undefined) {
              return badRequest('setCardLevel requires cardId and level');
            }
            if (typeof operation.level !== 'number' || operation.level < 1 || !Number.isInteger(operation.level)) {
              return badRequest('level must be a positive integer');
            }
            const cardIndex = inventory.cards.findIndex(card => card.cardId === operation.cardId);
            if (cardIndex === -1) return notFound(`Card with id ${operation.cardId} not found in inventory`);
            inventory.cards[cardIndex].level = operation.level;
            break;
          }

          case 'addPack': {
            if (!operation.packName) return badRequest('addPack requires packName');
            inventory.packs[operation.packName] =
              (inventory.packs[operation.packName] || 0) + (operation.quantity || 1);
            break;
          }

          case 'removePack': {
            if (!operation.packName) return badRequest('removePack requires packName');
            const quantity = operation.quantity || 1;
            const currentCount = inventory.packs[operation.packName] || 0;
            if (currentCount < quantity) {
              return badRequest(`Insufficient packs. Trying to remove ${quantity} but only have ${currentCount}`);
            }
            inventory.packs[operation.packName] -= quantity;
            if (inventory.packs[operation.packName] === 0) delete inventory.packs[operation.packName];
            break;
          }

          default:
            return badRequest(`Unknown action: ${(operation as { action: string }).action}`);
        }
      }

      const newVersion = inventory.version + 1;

      const result = await db.conditionalPut(
        {
          pk,
          sk,
          userId,
          packs: inventory.packs,
          cards: inventory.cards,
          version: newVersion,
          updatedAt: new Date().toISOString(),
        },
        inventory.version === 0 ? undefined : inventory.version,
      );

      if (result.success) {
        return success(
          { userId, packs: inventory.packs, cards: inventory.cards, version: newVersion },
          'Inventory updated successfully',
        );
      }

      console.log(`Version mismatch on attempt ${attempt + 1}, retrying...`);
      if (attempt === MAX_RETRIES - 1) {
        return conflict('Inventory was modified by another request. Please retry.');
      }
      await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
    } catch (error) {
      console.error('Error modifying user inventory:', error instanceof Error ? error.message : String(error));
      return serverError('Failed to modify user inventory');
    }
  }

  return serverError('Max retries exceeded');
};
