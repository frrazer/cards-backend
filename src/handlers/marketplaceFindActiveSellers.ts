import { APIGatewayProxyHandler } from 'aws-lambda';
import { badRequest, success, serverError } from '../utils/response';
import { db } from '../utils/db';
import { cached, cachedBatch, TTL } from '../utils/cache';
import { MarketplaceListing, RapRecord } from '../types/inventory';
import { RouteConfig } from '../types/route';

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

export const route: RouteConfig = {
  method: 'GET',
  path: '/marketplace/find-sellers',
  timeout: 10,
  memory: 256,
};

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
    const rapPromise = cached(`rap:${itemType}:${itemName}`, TTL.RAP, async () => {
      const rapItem = await db.get(`RAP#${itemType.toUpperCase()}#${itemName}`, 'CURRENT');
      return (rapItem as RapRecord)?.rap;
    });

    const listingsPromise = cached(`listings:${itemType}:${itemName}`, TTL.LISTINGS_INDEX, async () => {
      const result = await db.query(`ITEM_LISTINGS#${itemType.toUpperCase()}#${itemName}`, { limit: 500 });
      return result.items as unknown as MarketplaceListing[];
    });

    const [rap, listings] = await Promise.all([rapPromise, listingsPromise]);

    if (!listings || listings.length === 0) {
      return success({ itemName, itemType, listings: [], count: 0 });
    }

    // Get active seller statuses with batch caching
    const sellerIds = [...new Set(listings.map(l => l.sellerId))];
    const sellerCacheKeys = sellerIds.map(id => `seller:${id}`);

    const sellerMap = await cachedBatch<ActiveSeller | null>(sellerCacheKeys, TTL.ACTIVE_SELLERS, async missingKeys => {
      const missingIds = missingKeys.map(k => k.replace('seller:', ''));
      const sellerKeys = missingIds.map(id => ({ pk: `ACTIVE_SELLER#${id}`, sk: 'STATUS' }));
      const records = await db.batchGet(sellerKeys);

      const result = new Map<string, ActiveSeller | null>();
      const recordMap = new Map(
        records.map(r => [(r as unknown as ActiveSeller).userId, r as unknown as ActiveSeller]),
      );

      for (const id of missingIds) {
        result.set(`seller:${id}`, recordMap.get(id) || null);
      }
      return result;
    });

    const now = Date.now();
    const activeListings: ListingWithSeller[] = [];

    for (const listing of listings) {
      const seller = sellerMap.get(`seller:${listing.sellerId}`);
      if (seller?.active && now - new Date(seller.lastUpdated).getTime() < ACTIVE_SELLER_TIMEOUT_MS) {
        activeListings.push({ ...listing, sellerJobId: seller.jobId, sellerBoothIdx: seller.boothIdx });
      }
    }

    if (activeListings.length === 0) {
      return success({ itemName, itemType, listings: [], count: 0 });
    }

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
