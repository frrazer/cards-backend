import { APIGatewayProxyHandler } from 'aws-lambda';
import { success, serverError } from '../utils/response';
import { db } from '../utils/db';
import { cached, TTL } from '../utils/cache';
import { RapRecord, RapHistoryEntry, ItemRapData, MarketplaceHistoryResponse } from '../types/inventory';
import { RouteConfig } from '../types/route';

const getDateString = (date: Date): string => date.toISOString().split('T')[0];

const getDaysBetween = (startDate: string, endDate: string): string[] => {
  const dates: string[] = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  start.setDate(start.getDate() + 1);

  while (start <= end) {
    dates.push(getDateString(start));
    start.setDate(start.getDate() + 1);
  }
  return dates;
};

export const route: RouteConfig = {
  method: 'GET',
  path: '/marketplace/history',
  timeout: 10,
  memory: 256,
};

export const handler: APIGatewayProxyHandler = async () => {
  try {
    return success(await cached('marketplace:history', TTL.HISTORY, fetchMarketplaceHistory));
  } catch (error) {
    console.error('Error fetching marketplace history:', error);
    return serverError('Failed to fetch marketplace history');
  }
};

async function fetchMarketplaceHistory(): Promise<MarketplaceHistoryResponse> {
  const registryResult = await db.query('RAP_REGISTRY');
  const registryItems = registryResult.items;

  if (registryItems.length === 0) {
    return { cards: {}, packs: {} };
  }

  // Batch get all current RAP records
  const rapKeys = registryItems.map(item => ({
    pk: `RAP#${(item.itemType as string).toUpperCase()}#${item.itemName as string}`,
    sk: 'CURRENT',
  }));
  const rapRecords = await db.batchGet(rapKeys);

  const rapMap = new Map<string, RapRecord & { pk: string }>();
  for (const record of rapRecords) {
    rapMap.set(record.pk as string, record as RapRecord & { pk: string });
  }

  const today = getDateString(new Date());

  // Build list of all history queries needed - then batch them
  const historyQueries = registryItems
    .map(item => {
      const itemType = item.itemType as string;
      const itemName = item.itemName as string;
      return `RAP#${itemType.toUpperCase()}#${itemName}`;
    })
    .filter(pk => rapMap.has(pk));

  // Execute all history queries in parallel (fixes N+1)
  const historyResults = await Promise.all(
    historyQueries.map(pk => db.query(pk, { skBeginsWith: 'HISTORY#' }).then(r => ({ pk, items: r.items }))),
  );

  const historyMap = new Map<string, RapHistoryEntry[]>();
  for (const { pk, items } of historyResults) {
    historyMap.set(
      pk,
      items.map(item => ({
        date: (item.sk as string).replace('HISTORY#', ''),
        rap: item.rap as number,
      })),
    );
  }

  const response: MarketplaceHistoryResponse = { cards: {}, packs: {} };
  const snapshotItems: Array<Record<string, unknown>> = [];
  const updateOperations: Array<{ pk: string; updates: Record<string, unknown> }> = [];

  for (const regItem of registryItems) {
    const itemType = regItem.itemType as 'card' | 'pack';
    const itemName = regItem.itemName as string;
    const pk = `RAP#${itemType.toUpperCase()}#${itemName}`;

    const rapRecord = rapMap.get(pk);
    if (!rapRecord) continue;

    const history = historyMap.get(pk) || [];
    const lastSnapshotDate = rapRecord.lastSnapshotDate as string | undefined;

    if (!lastSnapshotDate || lastSnapshotDate !== today) {
      const startDate = lastSnapshotDate || getDateString(new Date(rapRecord.lastUpdated));
      const missingDates = getDaysBetween(startDate, today);

      for (const date of missingDates) {
        if (!history.some(h => h.date === date)) {
          snapshotItems.push({ pk, sk: `HISTORY#${date}`, rap: rapRecord.rap, date });
          history.push({ date, rap: rapRecord.rap as number });
        }
      }

      updateOperations.push({ pk, updates: { lastSnapshotDate: today } });
    }

    history.sort((a, b) => a.date.localeCompare(b.date));

    const itemData: ItemRapData = { rap: rapRecord.rap as number, history };
    if (itemType === 'card') {
      response.cards[itemName] = itemData;
    } else {
      response.packs[itemName] = itemData;
    }
  }

  // Batch write snapshots and updates in parallel
  await Promise.all([
    snapshotItems.length > 0 ? db.batchPut(snapshotItems) : Promise.resolve(),
    updateOperations.length > 0
      ? Promise.all(updateOperations.map(op => db.update(op.pk, 'CURRENT', op.updates)))
      : Promise.resolve(),
  ]);

  return response;
}
