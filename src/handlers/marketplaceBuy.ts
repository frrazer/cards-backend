import { APIGatewayProxyHandler } from 'aws-lambda';
import { buildResponse } from '../utils/response';
import { db } from '../utils/db';
import { InventoryCard, MarketplaceListing } from '../types/inventory';
import { invalidateListingsCache } from './marketplaceGetListings';

interface BuyCardRequest {
  buyerId: string;
  cardId: string;
  expectedCost: number;
}

const padCost = (cost: number): string => cost.toString().padStart(15, '0');

/**
 * @route POST /marketplace/buy
 * @auth
 * @timeout 10
 * @memory 256
 * @description Purchases a card from the marketplace, transferring it to the buyer
 */
export const handler: APIGatewayProxyHandler = async event => {
  if (!event.body) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'Request body is required',
    });
  }

  let request: BuyCardRequest;
  try {
    request = JSON.parse(event.body) as BuyCardRequest;
  } catch {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'Invalid JSON in request body',
    });
  }

  const { buyerId, cardId, expectedCost } = request;

  if (!buyerId || !cardId || expectedCost === undefined) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'buyerId, cardId, and expectedCost are required',
    });
  }

  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const listingItem = await db.get(`LISTING#${cardId}`, 'LISTING');
      if (!listingItem) {
        return buildResponse(404, {
          success: false,
          error: 'Not Found',
          message: 'Listing not found or already sold',
        });
      }

      const listing = listingItem as unknown as MarketplaceListing;

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

      const [sellerInventoryItem, buyerInventoryItem] = await Promise.all([
        db.get(`USER#${listing.sellerId}`, 'INVENTORY'),
        db.get(`USER#${buyerId}`, 'INVENTORY'),
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
        await db.transactWrite([
          { type: 'Delete', pk: `LISTING#${cardId}`, sk: 'LISTING' },
          {
            type: 'Delete',
            pk: `MARKET#${listing.cardName}#${listing.cardLevel}`,
            sk: `${padCost(listing.cost)}#${cardId}`,
          },
          {
            type: 'Delete',
            pk: 'MARKET_ALL',
            sk: `${padCost(listing.cost)}#${listing.cardName}#${listing.cardLevel}#${cardId}`,
          },
        ]);
        invalidateListingsCache(listing.cardName, listing.cardLevel);

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

      const paddedCost = padCost(listing.cost);

      const operations: Parameters<typeof db.transactWrite>[0] = [
        {
          type: 'Delete',
          pk: `LISTING#${cardId}`,
          sk: 'LISTING',
          condition: 'attribute_exists(pk)',
        },
        {
          type: 'Delete',
          pk: `MARKET#${listing.cardName}#${listing.cardLevel}`,
          sk: `${paddedCost}#${cardId}`,
        },
        {
          type: 'Delete',
          pk: 'MARKET_ALL',
          sk: `${paddedCost}#${listing.cardName}#${listing.cardLevel}#${cardId}`,
        },
        {
          type: 'Update',
          pk: `USER#${listing.sellerId}`,
          sk: 'INVENTORY',
          updates: {
            cards: updatedSellerCards,
            packs: sellerPacks,
            version: sellerVersion + 1,
            updatedAt: new Date().toISOString(),
          },
          condition: '#version = :expectedVersion',
          conditionNames: { '#version': 'version' },
          conditionValues: { ':expectedVersion': sellerVersion },
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
            updatedAt: new Date().toISOString(),
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
            updatedAt: new Date().toISOString(),
          },
          condition: 'attribute_not_exists(pk)',
        });
      }

      await db.transactWrite(operations);
      invalidateListingsCache(listing.cardName, listing.cardLevel);

      return buildResponse(200, {
        success: true,
        message: 'Purchase successful',
        data: {
          card,
          cost: listing.cost,
          sellerId: listing.sellerId,
        },
      });
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

      console.error('Error buying card:', error);
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
