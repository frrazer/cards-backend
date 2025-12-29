import { APIGatewayProxyHandler } from 'aws-lambda';
import { badRequest, notFound, forbidden, success } from '../utils/response';
import { parseBody } from '../utils/request';
import { withRetry } from '../utils/retry';
import { db } from '../utils/db';
import { getUserListings } from '../utils/marketplace';
import { parseInventoryItem, reconstructCard } from '../utils/inventory';
import { CardListing, PackListing } from '../types/inventory';

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

/**
 * @route POST /marketplace/unlist
 * @auth
 * @timeout 5
 * @memory 256
 * @description Unlists an item from the marketplace
 */
export const handler: APIGatewayProxyHandler = async event => {
  const parsed = parseBody<UnlistRequest>(event.body);
  if (!parsed.success) return parsed.response;

  const { type, userId } = parsed.data;

  if (!type || !userId) {
    return badRequest('type and userId are required');
  }

  if (type !== 'card' && type !== 'pack') {
    return badRequest('type must be "card" or "pack"');
  }

  if (type === 'card' && !('cardId' in parsed.data && parsed.data.cardId)) {
    return badRequest('cardId is required for card unlisting');
  }

  if (type === 'pack' && !('listingId' in parsed.data && parsed.data.listingId)) {
    return badRequest('listingId is required for pack unlisting');
  }

  return withRetry(
    async () => {
      const timestamp = new Date().toISOString();
      const operations: Parameters<typeof db.transactWrite>[0] = [];

      const inventoryItem = await db.get(`USER#${userId}`, 'INVENTORY');
      const inventory = parseInventoryItem(userId, inventoryItem);
      let updatedCards = inventory.cards;
      let updatedPacks = inventory.packs;

      if (type === 'card') {
        const cardId = (parsed.data as UnlistCardRequest).cardId;

        const listingItem = await db.get(`LISTING#CARD#${cardId}`, 'LISTING');
        if (!listingItem) return notFound('Listing not found');

        const listing = listingItem as unknown as CardListing;
        if (listing.sellerId !== userId) return forbidden('You can only unlist your own items');

        const card = reconstructCard(listing);
        updatedCards = [...inventory.cards, card];

        operations.push(
          { type: 'Delete', pk: `LISTING#CARD#${cardId}`, sk: 'LISTING', condition: 'attribute_exists(pk)' },
          { type: 'Delete', pk: `USER_LISTINGS#${userId}`, sk: `CARD#${cardId}` },
          { type: 'Delete', pk: `ITEM_LISTINGS#CARD#${listing.cardName}`, sk: cardId },
        );

        if (inventory.exists) {
          operations.push({
            type: 'Update',
            pk: `USER#${userId}`,
            sk: 'INVENTORY',
            updates: { cards: updatedCards, packs: updatedPacks, version: inventory.version + 1, updatedAt: timestamp },
            condition: '#version = :expectedVersion',
            conditionNames: { '#version': 'version' },
            conditionValues: { ':expectedVersion': inventory.version },
          });
        } else {
          operations.push({
            type: 'Put',
            pk: `USER#${userId}`,
            sk: 'INVENTORY',
            item: { userId, cards: [card], packs: {}, version: 1, updatedAt: timestamp },
            condition: 'attribute_not_exists(pk)',
          });
        }
      } else {
        const listingId = (parsed.data as UnlistPackRequest).listingId;

        const listingItem = await db.get(`LISTING#PACK#${listingId}`, 'LISTING');
        if (!listingItem) return notFound('Listing not found');

        const listing = listingItem as unknown as PackListing;
        if (listing.sellerId !== userId) return forbidden('You can only unlist your own items');

        updatedPacks = { ...inventory.packs, [listing.packName]: (inventory.packs[listing.packName] || 0) + 1 };

        operations.push(
          { type: 'Delete', pk: `LISTING#PACK#${listingId}`, sk: 'LISTING', condition: 'attribute_exists(pk)' },
          { type: 'Delete', pk: `USER_LISTINGS#${userId}`, sk: `PACK#${listingId}` },
          { type: 'Delete', pk: `ITEM_LISTINGS#PACK#${listing.packName}`, sk: listingId },
        );

        if (inventory.exists) {
          operations.push({
            type: 'Update',
            pk: `USER#${userId}`,
            sk: 'INVENTORY',
            updates: { cards: updatedCards, packs: updatedPacks, version: inventory.version + 1, updatedAt: timestamp },
            condition: '#version = :expectedVersion',
            conditionNames: { '#version': 'version' },
            conditionValues: { ':expectedVersion': inventory.version },
          });
        } else {
          operations.push({
            type: 'Put',
            pk: `USER#${userId}`,
            sk: 'INVENTORY',
            item: { userId, cards: [], packs: { [listing.packName]: 1 }, version: 1, updatedAt: timestamp },
            condition: 'attribute_not_exists(pk)',
          });
        }
      }

      await db.transactWrite(operations);

      const updatedListings = await getUserListings(userId);
      const newVersion = inventory.exists ? inventory.version + 1 : 1;

      return success(
        {
          type,
          listings: updatedListings,
          listingsCount: updatedListings.length,
          sellerInventory: { userId, cards: updatedCards, packs: updatedPacks, version: newVersion },
        },
        `${type === 'card' ? 'Card' : 'Pack'} unlisted successfully`,
      );
    },
    { conflictMessage: 'Listing was modified or already removed' },
  );
};
