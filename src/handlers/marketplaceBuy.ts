import { APIGatewayProxyHandler } from 'aws-lambda';
import { buildResponse } from '../utils/response';
import { db } from '../utils/db';
import { InventoryCard, CardListing, PackListing, UserSlots, RapRecord } from '../types/inventory';

interface BuyCardRequest {
  type: 'card';
  buyerId: string;
  cardId: string;
  expectedCost: number;
}

interface BuyPackRequest {
  type: 'pack';
  buyerId: string;
  sellerId: string;
  slot: number;
  expectedCost: number;
}

type BuyRequest = BuyCardRequest | BuyPackRequest;

const calculateNewRap = (currentRap: number | undefined, salePrice: number): number => {
  if (currentRap === undefined) return salePrice;
  return currentRap + (salePrice - currentRap) / 10;
};

/**
 * @route POST /marketplace/buy
 * @auth
 * @timeout 10
 * @memory 256
 * @description Purchases a card or pack from the marketplace
 */
export const handler: APIGatewayProxyHandler = async event => {
  if (!event.body) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'Request body is required',
    });
  }

  let request: BuyRequest;
  try {
    request = JSON.parse(event.body) as BuyRequest;
  } catch {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'Invalid JSON in request body',
    });
  }

  const { type, buyerId, expectedCost } = request;

  if (!type || !buyerId || expectedCost === undefined) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'type, buyerId, and expectedCost are required',
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
      message: 'cardId is required for card purchases',
    });
  }

  if (type === 'pack' && (!('sellerId' in request && request.sellerId) || !('slot' in request && request.slot))) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'sellerId and slot are required for pack purchases',
    });
  }

  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (type === 'card') {
        return await handleCardPurchase(request as BuyCardRequest);
      } else {
        return await handlePackPurchase(request as BuyPackRequest);
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'TransactionCanceledException') {
        console.log(`Transaction conflict on attempt ${attempt + 1}, retrying...`);
        if (attempt === MAX_RETRIES - 1) {
          return buildResponse(409, {
            success: false,
            error: 'Conflict',
            message: 'Purchase failed due to concurrent modification. Please retry.',
          });
        }
        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
        continue;
      }

      console.error('Error buying item:', error);
      return buildResponse(500, {
        success: false,
        error: 'Internal Server Error',
        message: 'Failed to complete purchase',
      });
    }
  }

  return buildResponse(500, {
    success: false,
    error: 'Internal Server Error',
    message: 'Max retries exceeded',
  });
};

async function handleCardPurchase(request: BuyCardRequest) {
  const { buyerId, cardId, expectedCost } = request;

  const listingItem = await db.get(`LISTING#CARD#${cardId}`, 'LISTING');
  if (!listingItem) {
    return buildResponse(404, {
      success: false,
      error: 'Not Found',
      message: 'Listing not found or already sold',
    });
  }

  const listing = listingItem as unknown as CardListing;

  if (listing.cost !== expectedCost) {
    return buildResponse(409, {
      success: false,
      error: 'Conflict',
      message: `Price changed. Expected ${expectedCost}, actual ${listing.cost}`,
    });
  }

  if (listing.sellerId === buyerId) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'Cannot buy your own listing',
    });
  }

  const [sellerInventoryItem, buyerInventoryItem, sellerSlotsItem, rapItem] = await Promise.all([
    db.get(`USER#${listing.sellerId}`, 'INVENTORY'),
    db.get(`USER#${buyerId}`, 'INVENTORY'),
    db.get(`USER_SLOTS#${listing.sellerId}`, 'SLOTS'),
    db.get(`RAP#CARD#${listing.cardName}`, 'CURRENT'),
  ]);

  if (!sellerInventoryItem) {
    return buildResponse(404, {
      success: false,
      error: 'Not Found',
      message: 'Seller inventory not found',
    });
  }

  if (!sellerSlotsItem) {
    return buildResponse(404, {
      success: false,
      error: 'Not Found',
      message: 'Seller slots not found',
    });
  }

  const sellerCards = (sellerInventoryItem.cards as InventoryCard[]) || [];
  const cardIndex = sellerCards.findIndex(c => c.cardId === cardId);

  if (cardIndex === -1) {
    await cleanupCardListing(listing);
    return buildResponse(410, {
      success: false,
      error: 'Gone',
      message: 'Card no longer exists in seller inventory. Listing has been removed.',
    });
  }

  const card = sellerCards[cardIndex];
  const sellerVersion = (sellerInventoryItem.version as number) || 0;
  const buyerVersion = (buyerInventoryItem?.version as number) || 0;
  const buyerCards = (buyerInventoryItem?.cards as InventoryCard[]) || [];
  const buyerPacks = (buyerInventoryItem?.packs as Record<string, number>) || {};
  const sellerPacks = (sellerInventoryItem.packs as Record<string, number>) || {};
  const sellerSlots = sellerSlotsItem as UserSlots & { version: number };

  const updatedSellerCards = [...sellerCards];
  updatedSellerCards.splice(cardIndex, 1);
  const updatedBuyerCards = [...buyerCards, card];

  const updatedSellerSlots = { ...sellerSlots.slots };
  delete updatedSellerSlots[listing.slot];

  const timestamp = new Date().toISOString();

  const currentRap = (rapItem as RapRecord)?.rap;
  const newRap = calculateNewRap(currentRap, listing.cost);

  const operations: Parameters<typeof db.transactWrite>[0] = [
    {
      type: 'Delete',
      pk: `LISTING#CARD#${cardId}`,
      sk: 'LISTING',
      condition: 'attribute_exists(pk)',
    },
    {
      type: 'Update',
      pk: `USER#${listing.sellerId}`,
      sk: 'INVENTORY',
      updates: {
        cards: updatedSellerCards,
        packs: sellerPacks,
        version: sellerVersion + 1,
        updatedAt: timestamp,
      },
      condition: '#version = :expectedVersion',
      conditionNames: { '#version': 'version' },
      conditionValues: { ':expectedVersion': sellerVersion },
    },
    {
      type: 'Update',
      pk: `USER_SLOTS#${listing.sellerId}`,
      sk: 'SLOTS',
      updates: {
        slots: updatedSellerSlots,
        version: sellerSlots.version + 1,
        updatedAt: timestamp,
      },
      condition: '#version = :expectedVersion',
      conditionNames: { '#version': 'version' },
      conditionValues: { ':expectedVersion': sellerSlots.version },
    },
  ];

  if (buyerInventoryItem) {
    operations.push({
      type: 'Update',
      pk: `USER#${buyerId}`,
      sk: 'INVENTORY',
      updates: {
        cards: updatedBuyerCards,
        packs: buyerPacks,
        version: buyerVersion + 1,
        updatedAt: timestamp,
      },
      condition: '#version = :expectedVersion',
      conditionNames: { '#version': 'version' },
      conditionValues: { ':expectedVersion': buyerVersion },
    });
  } else {
    operations.push({
      type: 'Put',
      pk: `USER#${buyerId}`,
      sk: 'INVENTORY',
      item: {
        userId: buyerId,
        cards: [card],
        packs: {},
        version: 1,
        updatedAt: timestamp,
      },
      condition: 'attribute_not_exists(pk)',
    });
  }

  if (rapItem) {
    operations.push({
      type: 'Update',
      pk: `RAP#CARD#${listing.cardName}`,
      sk: 'CURRENT',
      updates: {
        rap: newRap,
        lastUpdated: timestamp,
      },
    });
  } else {
    operations.push({
      type: 'Put',
      pk: `RAP#CARD#${listing.cardName}`,
      sk: 'CURRENT',
      item: {
        rap: newRap,
        lastUpdated: timestamp,
      },
    });
    operations.push({
      type: 'Put',
      pk: 'RAP_REGISTRY',
      sk: `CARD#${listing.cardName}`,
      item: {
        itemType: 'card',
        itemName: listing.cardName,
        createdAt: timestamp,
      },
      condition: 'attribute_not_exists(pk)',
    });
  }

  await db.transactWrite(operations);

  return buildResponse(200, {
    success: true,
    message: 'Card purchase successful',
    data: {
      type: 'card',
      card: { ...card, level: card.level ?? listing.cardLevel },
      cost: listing.cost,
      sellerId: listing.sellerId,
      newRap,
    },
  });
}

async function handlePackPurchase(request: BuyPackRequest) {
  const { buyerId, sellerId, slot, expectedCost } = request;

  if (sellerId === buyerId) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'Cannot buy your own listing',
    });
  }

  const listingItem = await db.get(`LISTING#PACK#${sellerId}#${slot}`, 'LISTING');
  if (!listingItem) {
    return buildResponse(404, {
      success: false,
      error: 'Not Found',
      message: 'Listing not found or already sold',
    });
  }

  const listing = listingItem as unknown as PackListing;

  if (listing.cost !== expectedCost) {
    return buildResponse(409, {
      success: false,
      error: 'Conflict',
      message: `Price changed. Expected ${expectedCost}, actual ${listing.cost}`,
    });
  }

  const [buyerInventoryItem, sellerSlotsItem, rapItem] = await Promise.all([
    db.get(`USER#${buyerId}`, 'INVENTORY'),
    db.get(`USER_SLOTS#${sellerId}`, 'SLOTS'),
    db.get(`RAP#PACK#${listing.packName}`, 'CURRENT'),
  ]);

  if (!sellerSlotsItem) {
    return buildResponse(404, {
      success: false,
      error: 'Not Found',
      message: 'Seller slots not found',
    });
  }

  const buyerVersion = (buyerInventoryItem?.version as number) || 0;
  const buyerCards = (buyerInventoryItem?.cards as InventoryCard[]) || [];
  const buyerPacks = (buyerInventoryItem?.packs as Record<string, number>) || {};
  const sellerSlots = sellerSlotsItem as UserSlots & { version: number };

  const updatedSellerSlots = { ...sellerSlots.slots };
  delete updatedSellerSlots[slot];

  const updatedBuyerPacks = { ...buyerPacks, [listing.packName]: (buyerPacks[listing.packName] || 0) + 1 };

  const timestamp = new Date().toISOString();

  const currentRap = (rapItem as RapRecord)?.rap;
  const newRap = calculateNewRap(currentRap, listing.cost);

  const operations: Parameters<typeof db.transactWrite>[0] = [
    {
      type: 'Delete',
      pk: `LISTING#PACK#${sellerId}#${slot}`,
      sk: 'LISTING',
      condition: 'attribute_exists(pk)',
    },
    {
      type: 'Update',
      pk: `USER_SLOTS#${sellerId}`,
      sk: 'SLOTS',
      updates: {
        slots: updatedSellerSlots,
        version: sellerSlots.version + 1,
        updatedAt: timestamp,
      },
      condition: '#version = :expectedVersion',
      conditionNames: { '#version': 'version' },
      conditionValues: { ':expectedVersion': sellerSlots.version },
    },
  ];

  if (buyerInventoryItem) {
    operations.push({
      type: 'Update',
      pk: `USER#${buyerId}`,
      sk: 'INVENTORY',
      updates: {
        cards: buyerCards,
        packs: updatedBuyerPacks,
        version: buyerVersion + 1,
        updatedAt: timestamp,
      },
      condition: '#version = :expectedVersion',
      conditionNames: { '#version': 'version' },
      conditionValues: { ':expectedVersion': buyerVersion },
    });
  } else {
    operations.push({
      type: 'Put',
      pk: `USER#${buyerId}`,
      sk: 'INVENTORY',
      item: {
        userId: buyerId,
        cards: [],
        packs: { [listing.packName]: 1 },
        version: 1,
        updatedAt: timestamp,
      },
      condition: 'attribute_not_exists(pk)',
    });
  }

  if (rapItem) {
    operations.push({
      type: 'Update',
      pk: `RAP#PACK#${listing.packName}`,
      sk: 'CURRENT',
      updates: {
        rap: newRap,
        lastUpdated: timestamp,
      },
    });
  } else {
    operations.push({
      type: 'Put',
      pk: `RAP#PACK#${listing.packName}`,
      sk: 'CURRENT',
      item: {
        rap: newRap,
        lastUpdated: timestamp,
      },
    });
    operations.push({
      type: 'Put',
      pk: 'RAP_REGISTRY',
      sk: `PACK#${listing.packName}`,
      item: {
        itemType: 'pack',
        itemName: listing.packName,
        createdAt: timestamp,
      },
      condition: 'attribute_not_exists(pk)',
    });
  }

  await db.transactWrite(operations);

  return buildResponse(200, {
    success: true,
    message: 'Pack purchase successful',
    data: {
      type: 'pack',
      packName: listing.packName,
      cost: listing.cost,
      sellerId: listing.sellerId,
      newRap,
    },
  });
}

async function cleanupCardListing(listing: CardListing) {
  const sellerSlotsItem = await db.get(`USER_SLOTS#${listing.sellerId}`, 'SLOTS');

  const operations: Parameters<typeof db.transactWrite>[0] = [
    { type: 'Delete', pk: `LISTING#CARD#${listing.cardId}`, sk: 'LISTING' },
  ];

  if (sellerSlotsItem) {
    const sellerSlots = sellerSlotsItem as UserSlots & { version: number };
    const updatedSlots = { ...sellerSlots.slots };
    delete updatedSlots[listing.slot];

    operations.push({
      type: 'Update',
      pk: `USER_SLOTS#${listing.sellerId}`,
      sk: 'SLOTS',
      updates: {
        slots: updatedSlots,
        version: sellerSlots.version + 1,
        updatedAt: new Date().toISOString(),
      },
      condition: '#version = :expectedVersion',
      conditionNames: { '#version': 'version' },
      conditionValues: { ':expectedVersion': sellerSlots.version },
    });
  }

  try {
    await db.transactWrite(operations);
  } catch (error) {
    // Cleanup is best-effort - log but don't fail the request
    console.warn('Failed to cleanup orphan listing:', error);
  }
}
