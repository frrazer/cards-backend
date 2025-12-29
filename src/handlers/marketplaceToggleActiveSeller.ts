import { APIGatewayProxyHandler } from 'aws-lambda';
import { badRequest, success, serverError } from '../utils/response';
import { parseBody } from '../utils/request';
import { db } from '../utils/db';

interface ActiveSellerEntry {
  userId: string;
  active: boolean;
  jobId: string;
  boothIdx: number;
}

/**
 * @route POST /marketplace/sellers/toggle
 * @auth
 * @timeout 5
 * @memory 256
 */
export const handler: APIGatewayProxyHandler = async event => {
  const parsed = parseBody<ActiveSellerEntry[]>(event.body);
  if (!parsed.success) return parsed.response;

  const sellers = parsed.data;

  if (!Array.isArray(sellers) || sellers.length === 0) {
    return badRequest('Request body must be a non-empty array of seller entries');
  }

  for (const seller of sellers) {
    if (!seller.userId || typeof seller.active !== 'boolean' || !seller.jobId || seller.boothIdx === undefined) {
      return badRequest('Each entry must have userId, active (boolean), jobId, and boothIdx');
    }
  }

  try {
    const timestamp = new Date().toISOString();
    const items = sellers.map(seller => ({
      pk: `ACTIVE_SELLER#${seller.userId}`,
      sk: 'STATUS',
      userId: seller.userId,
      active: seller.active,
      jobId: seller.jobId,
      boothIdx: seller.boothIdx,
      lastUpdated: timestamp,
    }));

    await db.batchPut(items);

    return success({ updated: sellers.length, timestamp }, `Updated ${sellers.length} seller(s) status`);
  } catch (error) {
    console.error('Error updating seller status:', error);
    return serverError('Failed to update seller status');
  }
};
