import { APIGatewayProxyHandler } from 'aws-lambda';
import { badRequest, notFound, conflict, success } from '../utils/response';
import { parseBody } from '../utils/request';
import { withRetry } from '../utils/retry';
import { db } from '../utils/db';
import { getUserListings, calculateNewRap } from '../utils/marketplace';
import { parseInventoryItem, reconstructCard } from '../utils/inventory';
import { del as cacheDelete } from '../utils/cache';
import { CardListing, PackListing, RapRecord } from '../types/inventory';
import { RouteConfig } from '../types/route';

interface BuyCardRequest {
  type: 'card';
  buyerId: string;
  cardId: string;
  expectedCost: number;
}

interface BuyPackRequest {
  type: 'pack';
  buyerId: string;
  listingId: string;
  expectedCost: number;
}

type BuyRequest = BuyCardRequest | BuyPackRequest;

export const route: RouteConfig = {
  method: 'POST',
  path: '/marketplace/buy',
  auth: true,
  timeout: 10,
  memory: 256,
};

export const handler: APIGatewayProxyHandler = async event => {
  const parsed = parseBody<BuyRequest>(event.body);
  if (!parsed.success) return parsed.response;

  const { type, buyerId, expectedCost } = parsed.data;

  if (!type || !buyerId || expectedCost === undefined) {
    return badRequest('type, buyerId, and expectedCost are required');
  }

  if (type !== 'card' && type !== 'pack') {
    return badRequest('type must be "card" or "pack"');
  }

  if (type === 'card' && !('cardId' in parsed.data && parsed.data.cardId)) {
    return badRequest('cardId is required for card purchases');
  }

  if (type === 'pack' && !('listingId' in parsed.data && parsed.data.listingId)) {
    return badRequest('listingId is required for pack purchases');
  }

  return withRetry(
    async () =>
      type === 'card'
        ? handleCardPurchase(parsed.data as BuyCardRequest)
        : handlePackPurchase(parsed.data as BuyPackRequest),
    { baseDelayMs: 100, conflictMessage: 'Purchase failed due to concurrent modification. Please retry.' },
  );
};

async function handleCardPurchase(request: BuyCardRequest) {
  const { buyerId, cardId, expectedCost } = request;

  const listingItem = await db.get(`LISTING#CARD#${cardId}`, 'LISTING');
  if (!listingItem) return notFound('Listing not found or already sold');

  const listing = listingItem as unknown as CardListing;

  if (listing.cost !== expectedCost) {
    return conflict(`Price changed. Expected ${expectedCost}, actual ${listing.cost}`);
  }

  if (listing.sellerId === buyerId) {
    return badRequest('Cannot buy your own listing');
  }

  const card = reconstructCard(listing);

  const [sellerInventoryItem, buyerInventoryItem, rapItem] = await Promise.all([
    db.get(`USER#${listing.sellerId}`, 'INVENTORY'),
    db.get(`USER#${buyerId}`, 'INVENTORY'),
    db.get(`RAP#CARD#${listing.cardName}`, 'CURRENT'),
  ]);

  const seller = parseInventoryItem(listing.sellerId, sellerInventoryItem);
  const buyer = parseInventoryItem(buyerId, buyerInventoryItem);
  const updatedBuyerCards = [...buyer.cards, card];

  const timestamp = new Date().toISOString();
  const newRap = calculateNewRap((rapItem as RapRecord)?.rap, listing.cost);

  const operations: Parameters<typeof db.transactWrite>[0] = [
    { type: 'Delete', pk: `LISTING#CARD#${cardId}`, sk: 'LISTING', condition: 'attribute_exists(pk)' },
    { type: 'Delete', pk: `USER_LISTINGS#${listing.sellerId}`, sk: `CARD#${cardId}` },
    { type: 'Delete', pk: `ITEM_LISTINGS#CARD#${listing.cardName}`, sk: cardId },
  ];

  const newBuyerVersion = buyer.version + 1;
  if (buyer.exists) {
    operations.push({
      type: 'Update',
      pk: `USER#${buyerId}`,
      sk: 'INVENTORY',
      updates: { cards: updatedBuyerCards, packs: buyer.packs, version: newBuyerVersion, updatedAt: timestamp },
      condition: '#version = :expectedVersion',
      conditionNames: { '#version': 'version' },
      conditionValues: { ':expectedVersion': buyer.version },
    });
  } else {
    operations.push({
      type: 'Put',
      pk: `USER#${buyerId}`,
      sk: 'INVENTORY',
      item: { userId: buyerId, cards: [card], packs: {}, version: 1, updatedAt: timestamp },
      condition: 'attribute_not_exists(pk)',
    });
  }

  if (rapItem) {
    operations.push({
      type: 'Update',
      pk: `RAP#CARD#${listing.cardName}`,
      sk: 'CURRENT',
      updates: { rap: newRap, lastUpdated: timestamp },
    });
  } else {
    operations.push({
      type: 'Put',
      pk: `RAP#CARD#${listing.cardName}`,
      sk: 'CURRENT',
      item: { rap: newRap, lastUpdated: timestamp },
    });
    operations.push({
      type: 'Put',
      pk: 'RAP_REGISTRY',
      sk: `CARD#${listing.cardName}`,
      item: { itemType: 'card', itemName: listing.cardName, createdAt: timestamp },
      condition: 'attribute_not_exists(pk)',
    });
  }

  await db.transactWrite(operations);

  cacheDelete(`listings:card:${listing.cardName}`);
  cacheDelete(`rap:card:${listing.cardName}`);
  cacheDelete('marketplace:history');

  const sellerListings = await getUserListings(listing.sellerId);

  return success(
    {
      type: 'card',
      card,
      cost: listing.cost,
      newRap,
      sellerInventory: { userId: listing.sellerId, packs: seller.packs, cards: seller.cards, version: seller.version },
      buyerInventory: {
        userId: buyerId,
        packs: buyer.exists ? buyer.packs : {},
        cards: updatedBuyerCards,
        version: buyer.exists ? newBuyerVersion : 1,
      },
      sellerListings,
    },
    'Card purchase successful',
  );
}

async function handlePackPurchase(request: BuyPackRequest) {
  const { buyerId, listingId, expectedCost } = request;

  const listingItem = await db.get(`LISTING#PACK#${listingId}`, 'LISTING');
  if (!listingItem) return notFound('Listing not found or already sold');

  const listing = listingItem as unknown as PackListing;

  if (listing.sellerId === buyerId) {
    return badRequest('Cannot buy your own listing');
  }

  if (listing.cost !== expectedCost) {
    return conflict(`Price changed. Expected ${expectedCost}, actual ${listing.cost}`);
  }

  const [buyerInventoryItem, rapItem] = await Promise.all([
    db.get(`USER#${buyerId}`, 'INVENTORY'),
    db.get(`RAP#PACK#${listing.packName}`, 'CURRENT'),
  ]);

  const buyer = parseInventoryItem(buyerId, buyerInventoryItem);
  const updatedBuyerPacks = { ...buyer.packs, [listing.packName]: (buyer.packs[listing.packName] || 0) + 1 };

  const timestamp = new Date().toISOString();
  const newRap = calculateNewRap((rapItem as RapRecord)?.rap, listing.cost);

  const operations: Parameters<typeof db.transactWrite>[0] = [
    { type: 'Delete', pk: `LISTING#PACK#${listingId}`, sk: 'LISTING', condition: 'attribute_exists(pk)' },
    { type: 'Delete', pk: `USER_LISTINGS#${listing.sellerId}`, sk: `PACK#${listingId}` },
    { type: 'Delete', pk: `ITEM_LISTINGS#PACK#${listing.packName}`, sk: listingId },
  ];

  const newBuyerVersion = buyer.version + 1;
  if (buyer.exists) {
    operations.push({
      type: 'Update',
      pk: `USER#${buyerId}`,
      sk: 'INVENTORY',
      updates: { cards: buyer.cards, packs: updatedBuyerPacks, version: newBuyerVersion, updatedAt: timestamp },
      condition: '#version = :expectedVersion',
      conditionNames: { '#version': 'version' },
      conditionValues: { ':expectedVersion': buyer.version },
    });
  } else {
    operations.push({
      type: 'Put',
      pk: `USER#${buyerId}`,
      sk: 'INVENTORY',
      item: { userId: buyerId, cards: [], packs: { [listing.packName]: 1 }, version: 1, updatedAt: timestamp },
      condition: 'attribute_not_exists(pk)',
    });
  }

  if (rapItem) {
    operations.push({
      type: 'Update',
      pk: `RAP#PACK#${listing.packName}`,
      sk: 'CURRENT',
      updates: { rap: newRap, lastUpdated: timestamp },
    });
  } else {
    operations.push({
      type: 'Put',
      pk: `RAP#PACK#${listing.packName}`,
      sk: 'CURRENT',
      item: { rap: newRap, lastUpdated: timestamp },
    });
    operations.push({
      type: 'Put',
      pk: 'RAP_REGISTRY',
      sk: `PACK#${listing.packName}`,
      item: { itemType: 'pack', itemName: listing.packName, createdAt: timestamp },
      condition: 'attribute_not_exists(pk)',
    });
  }

  await db.transactWrite(operations);

  cacheDelete(`listings:pack:${listing.packName}`);
  cacheDelete(`rap:pack:${listing.packName}`);
  cacheDelete('marketplace:history');

  const [sellerListings, sellerInventoryItem] = await Promise.all([
    getUserListings(listing.sellerId),
    db.get(`USER#${listing.sellerId}`, 'INVENTORY'),
  ]);

  const seller = parseInventoryItem(listing.sellerId, sellerInventoryItem);

  return success(
    {
      type: 'pack',
      packName: listing.packName,
      listingId,
      cost: listing.cost,
      newRap,
      sellerInventory: { userId: listing.sellerId, packs: seller.packs, cards: seller.cards, version: seller.version },
      buyerInventory: {
        userId: buyerId,
        packs: updatedBuyerPacks,
        cards: buyer.cards,
        version: buyer.exists ? newBuyerVersion : 1,
      },
      sellerListings,
    },
    'Pack purchase successful',
  );
}
