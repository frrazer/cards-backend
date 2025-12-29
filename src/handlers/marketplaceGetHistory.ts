import { APIGatewayProxyHandler } from 'aws-lambda';
import { success, serverError } from '../utils/response';
import { db } from '../utils/db';
import { RapRecord, RapHistoryEntry, ItemRapData, MarketplaceHistoryResponse } from '../types/inventory';

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

/**
 * @route GET /marketplace/history
 * @timeout 10
 * @memory 256
 * @description Get RAP history for all cards and packs with marketplace activity
 */
export const handler: APIGatewayProxyHandler = async () => {
  try {
    const registryResult = await db.query('RAP_REGISTRY');
    const registryItems = registryResult.items;

    if (registryItems.length === 0) {
      return success({ cards: {}, packs: {} } satisfies MarketplaceHistoryResponse);
    }

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
    const response: MarketplaceHistoryResponse = { cards: {}, packs: {} };
    const snapshotOperations: Parameters<typeof db.transactWrite>[0] = [];
    const updateOperations: Array<{ pk: string; updates: Record<string, unknown> }> = [];

    for (const regItem of registryItems) {
      const itemType = regItem.itemType as 'card' | 'pack';
      const itemName = regItem.itemName as string;
      const pk = `RAP#${itemType.toUpperCase()}#${itemName}`;

      const rapRecord = rapMap.get(pk);
      if (!rapRecord) continue;

      const historyResult = await db.query(pk, { skBeginsWith: 'HISTORY#' });
      const history: RapHistoryEntry[] = historyResult.items.map(item => ({
        date: (item.sk as string).replace('HISTORY#', ''),
        rap: item.rap as number,
      }));

      const lastSnapshotDate = rapRecord.lastSnapshotDate as string | undefined;

      if (!lastSnapshotDate || lastSnapshotDate !== today) {
        const startDate = lastSnapshotDate || getDateString(new Date(rapRecord.lastUpdated));
        const missingDates = getDaysBetween(startDate, today);

        for (const date of missingDates) {
          if (!history.some(h => h.date === date)) {
            snapshotOperations.push({
              type: 'Put',
              pk,
              sk: `HISTORY#${date}`,
              item: { rap: rapRecord.rap, date },
            });
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

    if (snapshotOperations.length > 0) {
      const snapshotItems = snapshotOperations.map(op => ({ pk: op.pk, sk: op.sk, ...op.item }));
      await db.batchPut(snapshotItems);
    }

    if (updateOperations.length > 0) {
      await Promise.all(updateOperations.map(op => db.update(op.pk, 'CURRENT', op.updates)));
    }

    return success(response);
  } catch (error) {
    console.error('Error fetching marketplace history:', error);
    return serverError('Failed to fetch marketplace history');
  }
};
