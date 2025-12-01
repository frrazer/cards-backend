import { APIGatewayProxyHandler } from 'aws-lambda';
import { buildResponse } from '../utils/response';
import { checkAuth, getUnauthorizedResponse } from '../utils/auth';
import { db } from '../utils/db';
import { InventoryCard, UserInventory } from '../types/inventory';

/**
 * @route GET /user/inventory/{userId}
 * @timeout 3
 * @memory 128
 * @description Retrieves a user's inventory
 */
export const handler: APIGatewayProxyHandler = async (event) => {
    if (!checkAuth(event)) {
        console.log('Authentication failed for getUserInventory');
        return getUnauthorizedResponse();
    }

    const userId = event.pathParameters?.userId;

    if (!userId) {
        return buildResponse(400, {
            success: false,
            error: 'Bad Request',
            message: 'userId is required in path parameters',
        });
    }

    try {
        const item = await db.get(`USER#${userId}`, 'INVENTORY');

        if (!item) {
            const emptyInventory: UserInventory = {
                userId,
                packs: {},
                cards: [],
            };

            return buildResponse(200, {
                success: true,
                data: emptyInventory,
            });
        }

        const inventory: UserInventory = {
            userId: item.userId as string,
            packs: (item.packs as Record<string, number>) || {},
            cards: (item.cards as Array<InventoryCard>) || [],
            version: (item.version as number) || 0,
        };

        return buildResponse(200, {
            success: true,
            data: inventory,
        });
    } catch (error) {
        console.error('Error fetching user inventory:', error);
        return buildResponse(500, {
            success: false,
            error: 'Internal Server Error',
            message: 'Failed to fetch user inventory',
        });
    }
};
