import { db } from './db';
import { MarketplaceListing } from '../types/inventory';

export async function getUserListings(userId: string): Promise<MarketplaceListing[]> {
  const userListingsResult = await db.query(`USER_LISTINGS#${userId}`);
  if (userListingsResult.items.length === 0) return [];

  const listingKeys = userListingsResult.items.map(item => {
    const sk = item.sk as string;
    return sk.startsWith('CARD#')
      ? { pk: `LISTING#CARD#${sk.replace('CARD#', '')}`, sk: 'LISTING' }
      : { pk: `LISTING#PACK#${sk.replace('PACK#', '')}`, sk: 'LISTING' };
  });

  const listingItems = await db.batchGet(listingKeys);
  return listingItems
    .map(item => item as unknown as MarketplaceListing)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

export const calculateNewRap = (currentRap: number | undefined, salePrice: number): number =>
  currentRap === undefined ? salePrice : currentRap + (salePrice - currentRap) / 10;
