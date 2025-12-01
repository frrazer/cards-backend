import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    UpdateCommand,
    DeleteCommand,
    QueryCommand,
    BatchGetCommand,
    BatchWriteCommand,
    TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const TABLE_NAME = process.env.TABLE_NAME;
if (!TABLE_NAME) {
    throw new Error('TABLE_NAME environment variable is required');
}

export const db = {
    get: async (pk: string, sk: string) => {
        const command = new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk, sk },
        });
        const response = await docClient.send(command);
        return response.Item;
    },

    put: async (item: Record<string, unknown>) => {
        const command = new PutCommand({
            TableName: TABLE_NAME,
            Item: item,
        });
        await docClient.send(command);
        return item;
    },

    update: async (pk: string, sk: string, updates: Record<string, unknown>) => {
        const keys = Object.keys(updates);
        if (keys.length === 0) {
            throw new Error('Update requires at least one field to update');
        }

        const updateExpressions: string[] = [];
        const expressionAttributeNames: Record<string, string> = {};
        const expressionAttributeValues: Record<string, unknown> = {};

        keys.forEach((key, index) => {
            const attrName = `#attr${index}`;
            const attrValue = `:val${index}`;
            updateExpressions.push(`${attrName} = ${attrValue}`);
            expressionAttributeNames[attrName] = key;
            expressionAttributeValues[attrValue] = updates[key];
        });

        const command = new UpdateCommand({
            TableName: TABLE_NAME,
            Key: { pk, sk },
            UpdateExpression: `SET ${updateExpressions.join(', ')}`,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
            ReturnValues: 'ALL_NEW',
        });

        const response = await docClient.send(command);
        return response.Attributes;
    },

    increment: async (pk: string, sk: string, field: string, amount = 1) => {
        const command = new UpdateCommand({
            TableName: TABLE_NAME,
            Key: { pk, sk },
            UpdateExpression: `ADD #field :amount`,
            ExpressionAttributeNames: {
                '#field': field,
            },
            ExpressionAttributeValues: {
                ':amount': amount,
            },
            ReturnValues: 'ALL_NEW',
        });

        const response = await docClient.send(command);
        return response.Attributes;
    },

    delete: async (pk: string, sk: string) => {
        const command = new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { pk, sk },
        });
        await docClient.send(command);
    },

    query: async (
        pk: string,
        options?: {
            skBeginsWith?: string;
            skBetween?: [string, string]; // [start, end]
            skGreaterThan?: string;
            skGreaterThanOrEqual?: string;
            skLessThan?: string;
            skLessThanOrEqual?: string;
            limit?: number;
            scanIndexForward?: boolean;
            exclusiveStartKey?: Record<string, unknown>;
        },
    ) => {
        let keyConditionExpression = 'pk = :pk';
        const expressionAttributeValues: Record<string, unknown> = { ':pk': pk };

        if (options?.skBeginsWith) {
            keyConditionExpression += ' AND begins_with(sk, :skPrefix)';
            expressionAttributeValues[':skPrefix'] = options.skBeginsWith;
        } else if (options?.skBetween) {
            keyConditionExpression += ' AND sk BETWEEN :skStart AND :skEnd';
            expressionAttributeValues[':skStart'] = options.skBetween[0];
            expressionAttributeValues[':skEnd'] = options.skBetween[1];
        } else if (options?.skGreaterThan) {
            keyConditionExpression += ' AND sk > :skValue';
            expressionAttributeValues[':skValue'] = options.skGreaterThan;
        } else if (options?.skGreaterThanOrEqual) {
            keyConditionExpression += ' AND sk >= :skValue';
            expressionAttributeValues[':skValue'] = options.skGreaterThanOrEqual;
        } else if (options?.skLessThan) {
            keyConditionExpression += ' AND sk < :skValue';
            expressionAttributeValues[':skValue'] = options.skLessThan;
        } else if (options?.skLessThanOrEqual) {
            keyConditionExpression += ' AND sk <= :skValue';
            expressionAttributeValues[':skValue'] = options.skLessThanOrEqual;
        }

        const command = new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: keyConditionExpression,
            ExpressionAttributeValues: expressionAttributeValues,
            Limit: options?.limit,
            ScanIndexForward: options?.scanIndexForward ?? true,
            ExclusiveStartKey: options?.exclusiveStartKey,
        });
        const response = await docClient.send(command);
        return {
            items: response.Items || [],
            lastEvaluatedKey: response.LastEvaluatedKey,
        };
    },

    batchGet: async (keys: Array<{ pk: string; sk: string }>) => {
        if (keys.length === 0) return [];
        if (keys.length > 100) {
            throw new Error('BatchGet supports maximum 100 items. Use multiple calls or implement chunking.');
        }

        const command = new BatchGetCommand({
            RequestItems: {
                [TABLE_NAME]: {
                    Keys: keys,
                },
            },
        });
        const response = await docClient.send(command);
        return response.Responses?.[TABLE_NAME] || [];
    },

    batchPut: async (items: Array<Record<string, unknown>>) => {
        if (items.length === 0) return;
        if (items.length > 25) {
            const chunks: Array<Array<Record<string, unknown>>> = [];
            for (let i = 0; i < items.length; i += 25) {
                chunks.push(items.slice(i, i + 25));
            }

            await Promise.all(
                chunks.map((chunk) =>
                    docClient.send(
                        new BatchWriteCommand({
                            RequestItems: {
                                [TABLE_NAME]: chunk.map((item) => ({
                                    PutRequest: { Item: item },
                                })),
                            },
                        }),
                    ),
                ),
            );
            return;
        }

        const command = new BatchWriteCommand({
            RequestItems: {
                [TABLE_NAME]: items.map((item) => ({
                    PutRequest: { Item: item },
                })),
            },
        });
        await docClient.send(command);
    },

    batchDelete: async (keys: Array<{ pk: string; sk: string }>) => {
        if (keys.length === 0) return;
        if (keys.length > 25) {
            const chunks: Array<Array<{ pk: string; sk: string }>> = [];
            for (let i = 0; i < keys.length; i += 25) {
                chunks.push(keys.slice(i, i + 25));
            }

            await Promise.all(
                chunks.map((chunk) =>
                    docClient.send(
                        new BatchWriteCommand({
                            RequestItems: {
                                [TABLE_NAME]: chunk.map((key) => ({
                                    DeleteRequest: { Key: key },
                                })),
                            },
                        }),
                    ),
                ),
            );
            return;
        }

        const command = new BatchWriteCommand({
            RequestItems: {
                [TABLE_NAME]: keys.map((key) => ({
                    DeleteRequest: { Key: key },
                })),
            },
        });
        await docClient.send(command);
    },

    conditionalPut: async (
        item: Record<string, unknown>,
        expectedVersion?: number,
    ): Promise<{ success: boolean; error?: string }> => {
        try {
            const command = new PutCommand({
                TableName: TABLE_NAME,
                Item: item,
                ConditionExpression:
                    expectedVersion !== undefined ? '#version = :expectedVersion' : 'attribute_not_exists(pk)',
                ExpressionAttributeNames: expectedVersion !== undefined ? { '#version': 'version' } : undefined,
                ExpressionAttributeValues:
                    expectedVersion !== undefined ? { ':expectedVersion': expectedVersion } : undefined,
            });
            await docClient.send(command);
            return { success: true };
        } catch (error: unknown) {
            if (error instanceof Error && 'name' in error && error.name === 'ConditionalCheckFailedException') {
                return { success: false, error: 'Version mismatch or item already exists' };
            }
            throw new Error('Unknown error occurred');
        }
    },

    transactWrite: async (
        operations: Array<{
            type: 'Put' | 'Update' | 'Delete' | 'ConditionCheck';
            pk: string;
            sk: string;
            item?: Record<string, unknown>;
            updates?: Record<string, unknown>;
            condition?: string;
            conditionValues?: Record<string, unknown>;
        }>,
    ) => {
        const transactItems = operations.map((op) => {
            switch (op.type) {
                case 'Put':
                    return {
                        Put: {
                            TableName: TABLE_NAME,
                            Item: { pk: op.pk, sk: op.sk, ...op.item },
                            ConditionExpression: op.condition,
                            ExpressionAttributeValues: op.conditionValues,
                        },
                    };
                case 'Update': {
                    const keys = Object.keys(op.updates || {});
                    const updateExpressions: string[] = [];
                    const expressionAttributeNames: Record<string, string> = {};
                    const expressionAttributeValues: Record<string, unknown> = { ...op.conditionValues };

                    keys.forEach((key, index) => {
                        const attrName = `#attr${index}`;
                        const attrValue = `:val${index}`;
                        updateExpressions.push(`${attrName} = ${attrValue}`);
                        expressionAttributeNames[attrName] = key;
                        expressionAttributeValues[attrValue] = op.updates?.[key];
                    });

                    return {
                        Update: {
                            TableName: TABLE_NAME,
                            Key: { pk: op.pk, sk: op.sk },
                            UpdateExpression: `SET ${updateExpressions.join(', ')}`,
                            ConditionExpression: op.condition,
                            ExpressionAttributeNames:
                                Object.keys(expressionAttributeNames).length > 0 ? expressionAttributeNames : undefined,
                            ExpressionAttributeValues: expressionAttributeValues,
                        },
                    };
                }
                case 'Delete':
                    return {
                        Delete: {
                            TableName: TABLE_NAME,
                            Key: { pk: op.pk, sk: op.sk },
                            ConditionExpression: op.condition,
                            ExpressionAttributeValues: op.conditionValues,
                        },
                    };
                case 'ConditionCheck':
                    return {
                        ConditionCheck: {
                            TableName: TABLE_NAME,
                            Key: { pk: op.pk, sk: op.sk },
                            ConditionExpression: op.condition ?? '',
                            ExpressionAttributeValues: op.conditionValues,
                        },
                    };
                default:
                    throw new Error(`Unknown transaction type: ${(op as { type: string }).type}`);
            }
        });

        const command = new TransactWriteCommand({
            TransactItems: transactItems,
        });
        await docClient.send(command);
    },
};
