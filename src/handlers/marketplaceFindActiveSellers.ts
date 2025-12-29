import { APIGatewayProxyHandler } from 'aws-lambda';
import { badRequest, success, serverError } from '../utils/response';
import { db } from '../utils/db';
import { MarketplaceListing, RapRecord } from '../types/inventory';

interface ActiveSeller {
  userId: string;
  active: boolean;
  jobId: string;
  boothIdx: number;
  lastUpdated: string;
}

type ListingWithSeller = MarketplaceListing & {
  sellerJobId: string;
  sellerBoothIdx: number;
};

const ACTIVE_SELLER_TIMEOUT_MS = 60_000;

/**
 * @route GET /marketplace/find-sellers
 * @timeout 10
 * @memory 256
 */
export const handler: APIGatewayProxyHandler = async event => {
  const itemName = event.queryStringParameters?.itemName;
  const itemType = event.queryStringParameters?.itemType as 'card' | 'pack' | undefined;

  if (!itemName || !itemType) {
    return badRequest('itemName and itemType query parameters are required');
  }

  if (itemType !== 'card' && itemType !== 'pack') {
    return badRequest('itemType must be "card" or "pack"');
  }

  try {
    const [itemListingsResult, rapItem] = await Promise.all([
      db.query(`ITEM_LISTINGS#${itemType.toUpperCase()}#${itemName}`),
      db.get(`RAP#${itemType.toUpperCase()}#${itemName}`, 'CURRENT'),
    ]);

    if (itemListingsResult.items.length === 0) {
      return success({ itemName, itemType, listings: [], count: 0 });
    }

    const listingKeys = itemListingsResult.items.map(item => ({
      pk: `LISTING#${itemType.toUpperCase()}#${item.sk as string}`,
      sk: 'LISTING',
    }));

    const listings = (await db.batchGet(listingKeys)).filter(Boolean) as unknown as MarketplaceListing[];
    if (listings.length === 0) {
      return success({ itemName, itemType, listings: [], count: 0 });
    }

    const sellerIds = [...new Set(listings.map(l => l.sellerId))];
    const sellerKeys = sellerIds.map(id => ({ pk: `ACTIVE_SELLER#${id}`, sk: 'STATUS' }));
    const sellerRecords = await db.batchGet(sellerKeys);

    const now = Date.now();
    const activeSellerMap = new Map<string, ActiveSeller>();
    for (const record of sellerRecords) {
      const seller = record as unknown as ActiveSeller;
      if (seller.active && now - new Date(seller.lastUpdated).getTime() < ACTIVE_SELLER_TIMEOUT_MS) {
        activeSellerMap.set(seller.userId, seller);
      }
    }

    const activeListings: ListingWithSeller[] = [];
    for (const listing of listings) {
      const seller = activeSellerMap.get(listing.sellerId);
      if (seller) {
        activeListings.push({ ...listing, sellerJobId: seller.jobId, sellerBoothIdx: seller.boothIdx });
      }
    }

    if (activeListings.length === 0) {
      return success({ itemName, itemType, listings: [], count: 0 });
    }

    const rap = (rapItem as RapRecord)?.rap;
    const sortedListings = sortListingsByRapPriority(activeListings, rap);
    const result = sortedListings.slice(0, 30);

    return success({ itemName, itemType, rap: rap ?? null, listings: result, count: result.length });
  } catch (error) {
    console.error('Error finding active sellers:', error);
    return serverError('Failed to find active sellers');
  }
};

function sortListingsByRapPriority(listings: ListingWithSeller[], rap: number | undefined): ListingWithSeller[] {
  if (!rap) return listings.sort((a, b) => a.cost - b.cost);

  const minIdeal = rap * 0.95;
  const maxIdeal = rap * 1.3;

  return listings.sort((a, b) => {
    const aInRange = a.cost >= minIdeal && a.cost <= maxIdeal;
    const bInRange = b.cost >= minIdeal && b.cost <= maxIdeal;

    if (aInRange && !bInRange) return -1;
    if (!aInRange && bInRange) return 1;
    return a.cost - b.cost;
  });
}
