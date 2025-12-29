import { APIGatewayProxyHandler } from 'aws-lambda';
import { badRequest, success, serverError } from '../utils/response';
import { db } from '../utils/db';
import { parseInventoryItem } from '../utils/inventory';
import { RouteConfig } from '../types/route';

export const route: RouteConfig = {
  method: 'GET',
  path: '/user/inventory/{userId}',
  timeout: 3,
  memory: 128,
};

export const handler: APIGatewayProxyHandler = async event => {
  const userId = event.pathParameters?.userId;

  if (!userId) {
    return badRequest('userId is required in path parameters');
  }

  try {
    const item = await db.get(`USER#${userId}`, 'INVENTORY');
    const inventory = parseInventoryItem(userId, item);

    return success({
      userId: inventory.userId,
      packs: inventory.packs,
      cards: inventory.cards,
      version: inventory.version,
    });
  } catch (error) {
    console.error('Error fetching user inventory:', error);
    return serverError('Failed to fetch user inventory');
  }
};
