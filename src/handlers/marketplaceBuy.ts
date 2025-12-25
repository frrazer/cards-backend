import { APIGatewayProxyHandler } from 'aws-lambda';
import { buildResponse } from '../utils/response';
import { db } from '../utils/db';
import { InventoryCard, CardListing, PackListing, MarketplaceListing, RapRecord } from '../types/inventory';

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

interface InventoryData {
  userId: string;
  packs: Record<string, number>;
  cards: InventoryCard[];
  version: number;
}

const calculateNewRap = (currentRap: number | undefined, salePrice: number): number => {
  if (currentRap === undefined) return salePrice;
  return currentRap + (salePrice - currentRap) / 10;
};

async function getUserListings(userId: string): Promise<MarketplaceListing[]> {
  const userListingsResult = await db.query(`USER_LISTINGS#${userId}`);
  if (userListingsResult.items.length === 0) return [];

  const listingKeys = userListingsResult.items.map(item => {
    const sk = item.sk as string;
    if (sk.startsWith('CARD#')) {
      return { pk: `LISTING#CARD#${sk.replace('CARD#', '')}`, sk: 'LISTING' };
    } else {
      return { pk: `LISTING#PACK#${sk.replace('PACK#', '')}`, sk: 'LISTING' };
    }
  });

  const listingItems = await db.batchGet(listingKeys);
  return listingItems
    .map(item => item as unknown as MarketplaceListing)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

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

  if (type === 'pack' && !('listingId' in request && request.listingId)) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'listingId is required for pack purchases',
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

  const [sellerInventoryItem, buyerInventoryItem, rapItem] = await Promise.all([
    db.get(`USER#${listing.sellerId}`, 'INVENTORY'),
    db.get(`USER#${buyerId}`, 'INVENTORY'),
    db.get(`RAP#CARD#${listing.cardName}`, 'CURRENT'),
  ]);

  if (!sellerInventoryItem) {
    return buildResponse(404, {
      success: false,
      error: 'Not Found',
      message: 'Seller inventory not found',
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

  const updatedSellerCards = [...sellerCards];
  updatedSellerCards.splice(cardIndex, 1);
  const updatedBuyerCards = [...buyerCards, card];

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
      type: 'Delete',
      pk: `USER_LISTINGS#${listing.sellerId}`,
      sk: `CARD#${cardId}`,
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
  ];

  const newBuyerVersion = buyerVersion + 1;
  if (buyerInventoryItem) {
    operations.push({
      type: 'Update',
      pk: `USER#${buyerId}`,
      sk: 'INVENTORY',
      updates: {
        cards: updatedBuyerCards,
        packs: buyerPacks,
        version: newBuyerVersion,
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

  // Fetch updated data for response
  const [sellerListings] = await Promise.all([getUserListings(listing.sellerId)]);

  const sellerInventory: InventoryData = {
    userId: listing.sellerId,
    packs: sellerPacks,
    cards: updatedSellerCards,
    version: sellerVersion + 1,
  };

  const buyerInventory: InventoryData = {
    userId: buyerId,
    packs: buyerInventoryItem ? buyerPacks : {},
    cards: updatedBuyerCards,
    version: buyerInventoryItem ? newBuyerVersion : 1,
  };

  return buildResponse(200, {
    success: true,
    message: 'Card purchase successful',
    data: {
      type: 'card',
      card: { ...card, level: card.level ?? listing.cardLevel },
      cost: listing.cost,
      newRap,
      sellerInventory,
      buyerInventory,
      sellerListings,
    },
  });
}

async function handlePackPurchase(request: BuyPackRequest) {
  const { buyerId, listingId, expectedCost } = request;

  const listingItem = await db.get(`LISTING#PACK#${listingId}`, 'LISTING');
  if (!listingItem) {
    return buildResponse(404, {
      success: false,
      error: 'Not Found',
      message: 'Listing not found or already sold',
    });
  }

  const listing = listingItem as unknown as PackListing;

  if (listing.sellerId === buyerId) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'Cannot buy your own listing',
    });
  }

  if (listing.cost !== expectedCost) {
    return buildResponse(409, {
      success: false,
      error: 'Conflict',
      message: `Price changed. Expected ${expectedCost}, actual ${listing.cost}`,
    });
  }

  const [buyerInventoryItem, rapItem] = await Promise.all([
    db.get(`USER#${buyerId}`, 'INVENTORY'),
    db.get(`RAP#PACK#${listing.packName}`, 'CURRENT'),
  ]);

  const buyerVersion = (buyerInventoryItem?.version as number) || 0;
  const buyerCards = (buyerInventoryItem?.cards as InventoryCard[]) || [];
  const buyerPacks = (buyerInventoryItem?.packs as Record<string, number>) || {};
  const updatedBuyerPacks = { ...buyerPacks, [listing.packName]: (buyerPacks[listing.packName] || 0) + 1 };

  const timestamp = new Date().toISOString();

  const currentRap = (rapItem as RapRecord)?.rap;
  const newRap = calculateNewRap(currentRap, listing.cost);

  const operations: Parameters<typeof db.transactWrite>[0] = [
    {
      type: 'Delete',
      pk: `LISTING#PACK#${listingId}`,
      sk: 'LISTING',
      condition: 'attribute_exists(pk)',
    },
    {
      type: 'Delete',
      pk: `USER_LISTINGS#${listing.sellerId}`,
      sk: `PACK#${listingId}`,
    },
  ];

  const newBuyerVersion = buyerVersion + 1;
  if (buyerInventoryItem) {
    operations.push({
      type: 'Update',
      pk: `USER#${buyerId}`,
      sk: 'INVENTORY',
      updates: {
        cards: buyerCards,
        packs: updatedBuyerPacks,
        version: newBuyerVersion,
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

  // Fetch updated data for response
  const [sellerListings, sellerInventoryItem] = await Promise.all([
    getUserListings(listing.sellerId),
    db.get(`USER#${listing.sellerId}`, 'INVENTORY'),
  ]);

  const sellerInventory: InventoryData = sellerInventoryItem
    ? {
        userId: listing.sellerId,
        packs: (sellerInventoryItem.packs as Record<string, number>) || {},
        cards: (sellerInventoryItem.cards as InventoryCard[]) || [],
        version: (sellerInventoryItem.version as number) || 0,
      }
    : { userId: listing.sellerId, packs: {}, cards: [], version: 0 };

  const buyerInventory: InventoryData = {
    userId: buyerId,
    packs: updatedBuyerPacks,
    cards: buyerCards,
    version: buyerInventoryItem ? newBuyerVersion : 1,
  };

  return buildResponse(200, {
    success: true,
    message: 'Pack purchase successful',
    data: {
      type: 'pack',
      packName: listing.packName,
      listingId,
      cost: listing.cost,
      newRap,
      sellerInventory,
      buyerInventory,
      sellerListings,
    },
  });
}

async function cleanupCardListing(listing: CardListing) {
  const operations: Parameters<typeof db.transactWrite>[0] = [
    { type: 'Delete', pk: `LISTING#CARD#${listing.cardId}`, sk: 'LISTING' },
    { type: 'Delete', pk: `USER_LISTINGS#${listing.sellerId}`, sk: `CARD#${listing.cardId}` },
  ];

  try {
    await db.transactWrite(operations);
  } catch (error) {
    console.warn('Failed to cleanup orphan listing:', error);
  }
}
