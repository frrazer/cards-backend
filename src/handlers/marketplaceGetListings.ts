import { APIGatewayProxyHandler } from 'aws-lambda';
import { buildResponse } from '../utils/response';
import { db } from '../utils/db';
import { MarketplaceListing } from '../types/inventory';

interface CacheEntry {
  data: MarketplaceListing[];
  timestamp: number;
}

const CACHE_TTL_MS = 5000;
const cache = new Map<string, CacheEntry>();

const getCachedListings = (cacheKey: string): MarketplaceListing[] | null => {
  const entry = cache.get(cacheKey);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL_MS) {
    return entry.data;
  }
  return null;
};

const setCachedListings = (cacheKey: string, data: MarketplaceListing[]): void => {
  cache.set(cacheKey, { data, timestamp: Date.now() });
};

export const invalidateListingsCache = (cardName?: string, level?: number): void => {
  cache.delete('all');
  if (cardName && level !== undefined) cache.delete(`card:${cardName}:${level}`);
};

/**
 * @route GET /marketplace/listings
 * @timeout 5
 * @memory 256
 * @description Get 100 cheapest marketplace listings, optionally filtered by card name and level
 */
export const handler: APIGatewayProxyHandler = async event => {
  const cardName = event.queryStringParameters?.cardName;
  const levelParam = event.queryStringParameters?.level;

  if ((cardName && !levelParam) || (!cardName && levelParam)) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'Both cardName and level are required together, or neither',
    });
  }

  const level = levelParam ? parseInt(levelParam, 10) : undefined;
  if (levelParam && (level === undefined || isNaN(level) || level < 1)) {
    return buildResponse(400, {
      success: false,
      error: 'Bad Request',
      message: 'level must be a positive integer',
    });
  }

  const cacheKey = cardName ? `card:${cardName}:${level}` : 'all';

  const cachedData = getCachedListings(cacheKey);
  if (cachedData) {
    return buildResponse(200, {
      success: true,
      data: cachedData,
      cached: true,
    });
  }

  try {
    const pk = cardName ? `MARKET#${cardName}#${level}` : 'MARKET_ALL';
    const indexResult = await db.query(pk, { limit: 100, scanIndexForward: true });

    if (indexResult.items.length === 0) {
      setCachedListings(cacheKey, []);
      return buildResponse(200, {
        success: true,
        data: [],
        cached: false,
      });
    }

    const cardIds = indexResult.items.map(item => item.cardId as string);
    const listingKeys = cardIds.map(id => ({ pk: `LISTING#${id}`, sk: 'LISTING' }));

    const listingItems = await db.batchGet(listingKeys);
    const listings = listingItems.map(item => item as unknown as MarketplaceListing).sort((a, b) => a.cost - b.cost);

    setCachedListings(cacheKey, listings);

    return buildResponse(200, {
      success: true,
      data: listings,
      cached: false,
    });
  } catch (error) {
    console.error('Error fetching listings:', error);
    return buildResponse(500, {
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to fetch marketplace listings',
    });
  }
};
