import { APIGatewayProxyHandler } from 'aws-lambda';
import { badRequest, notFound, conflict, success } from '../utils/response';
import { parseBody } from '../utils/request';
import { withRetry } from '../utils/retry';
import { db } from '../utils/db';
import { getUserListings } from '../utils/marketplace';
import { parseInventoryItem } from '../utils/inventory';
import { del as cacheDelete } from '../utils/cache';
import { CardListing, PackListing, MarketplaceListing } from '../types/inventory';
import { RouteConfig } from '../types/route';
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

export const route: RouteConfig = {
  method: 'POST',
  path: '/marketplace/list',
  auth: true,
  timeout: 5,
  memory: 256,
};

export const handler: APIGatewayProxyHandler = async event => {
  const parsed = parseBody<ListRequest>(event.body);
  if (!parsed.success) return parsed.response;

  const { type, userId, username, cost } = parsed.data;

  if (!type || !userId || !username || cost === undefined) {
    return badRequest('type, userId, username, and cost are required');
  }

  if (type !== 'card' && type !== 'pack') {
    return badRequest('type must be "card" or "pack"');
  }

  if (typeof cost !== 'number' || cost < 1 || !Number.isInteger(cost)) {
    return badRequest('cost must be a positive integer');
  }

  if (type === 'card' && !('cardId' in parsed.data && parsed.data.cardId)) {
    return badRequest('cardId is required for card listings');
  }

  if (type === 'pack' && !('packName' in parsed.data && parsed.data.packName)) {
    return badRequest('packName is required for pack listings');
  }

  return withRetry(
    async () => {
      const [userListingsResult, inventoryItem] = await Promise.all([
        db.query(`USER_LISTINGS#${userId}`),
        db.get(`USER#${userId}`, 'INVENTORY'),
      ]);

      if (!inventoryItem) return notFound('User inventory not found');

      if (userListingsResult.items.length >= MAX_LISTINGS) {
        return badRequest(`Maximum of ${MAX_LISTINGS} listings reached`);
      }

      const timestamp = new Date().toISOString();
      const inventory = parseInventoryItem(userId, inventoryItem);
      const operations: Parameters<typeof db.transactWrite>[0] = [];

      let listing: MarketplaceListing;
      let updatedCards = inventory.cards;
      let updatedPacks = inventory.packs;

      if (type === 'card') {
        const cardId = (parsed.data as ListCardRequest).cardId;
        const cardIndex = inventory.cards.findIndex(c => c.cardId === cardId);

        if (cardIndex === -1) return notFound('Card not found in user inventory');

        const existingListing = await db.get(`LISTING#CARD#${cardId}`, 'LISTING');
        if (existingListing) return conflict('This card is already listed on the marketplace');

        const card = inventory.cards[cardIndex];
        updatedCards = [...inventory.cards];
        updatedCards.splice(cardIndex, 1);

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

        operations.push(
          {
            type: 'Put',
            pk: `LISTING#CARD#${cardId}`,
            sk: 'LISTING',
            item: { ...listing },
            condition: 'attribute_not_exists(pk)',
          },
          {
            type: 'Put',
            pk: `USER_LISTINGS#${userId}`,
            sk: `CARD#${cardId}`,
            item: { cardId, type: 'card' },
            condition: 'attribute_not_exists(pk)',
          },
          { type: 'Put', pk: `ITEM_LISTINGS#CARD#${card.cardName}`, sk: cardId, item: { ...listing } },
        );

        cacheDelete(`listings:card:${card.cardName}`);
      } else {
        const packName = (parsed.data as ListPackRequest).packName;

        if (!inventory.packs[packName] || inventory.packs[packName] < 1) {
          return notFound('Pack not found in user inventory or insufficient quantity');
        }

        const listingId = randomUUID();
        updatedPacks = { ...inventory.packs, [packName]: inventory.packs[packName] - 1 };
        if (updatedPacks[packName] === 0) delete updatedPacks[packName];

        listing = {
          type: 'pack',
          listingId,
          packName,
          sellerId: userId,
          sellerUsername: username,
          cost,
          timestamp,
        } satisfies PackListing;

        operations.push(
          {
            type: 'Put',
            pk: `LISTING#PACK#${listingId}`,
            sk: 'LISTING',
            item: { ...listing },
            condition: 'attribute_not_exists(pk)',
          },
          {
            type: 'Put',
            pk: `USER_LISTINGS#${userId}`,
            sk: `PACK#${listingId}`,
            item: { listingId, packName, type: 'pack' },
            condition: 'attribute_not_exists(pk)',
          },
          { type: 'Put', pk: `ITEM_LISTINGS#PACK#${packName}`, sk: listingId, item: { ...listing } },
        );

        cacheDelete(`listings:pack:${packName}`);
      }

      operations.push({
        type: 'Update',
        pk: `USER#${userId}`,
        sk: 'INVENTORY',
        updates: { cards: updatedCards, packs: updatedPacks, version: inventory.version + 1, updatedAt: timestamp },
        condition: '#version = :expectedVersion',
        conditionNames: { '#version': 'version' },
        conditionValues: { ':expectedVersion': inventory.version },
      });

      await db.transactWrite(operations);

      const updatedListings = await getUserListings(userId);

      return success(
        {
          listing,
          listings: updatedListings,
          listingsCount: updatedListings.length,
          sellerInventory: { userId, cards: updatedCards, packs: updatedPacks, version: inventory.version + 1 },
        },
        `${type === 'card' ? 'Card' : 'Pack'} listed successfully`,
      );
    },
    { conflictMessage: 'Failed to list item due to concurrent operation. Please retry.' },
  );
};
