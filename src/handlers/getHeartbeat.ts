import { APIGatewayProxyHandler } from 'aws-lambda';
import { buildResponse } from '../utils/response';
import { db } from '../utils/db';
import { RouteConfig } from '../types/route';

export const route: RouteConfig = {
  method: 'GET',
  path: '/heartbeat',
  timeout: 3,
  memory: 128,
};

export const handler: APIGatewayProxyHandler = async () => {
  return buildResponse(200, {
    success: true,
    message: 'API is running',
    timestamp: new Date().toISOString(),
    totalRequests: (await db.increment('METRICS', 'HEARTBEAT', 'requestCount', 1))?.requestCount || 0,
  });
};
