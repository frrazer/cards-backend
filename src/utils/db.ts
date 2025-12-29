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
    return (
      await docClient.send(
        new GetCommand({
          TableName: TABLE_NAME,
          Key: { pk, sk },
        }),
      )
    ).Item;
  },

  put: async (item: Record<string, unknown>) => {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
      }),
    );
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

    return (
      await docClient.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk, sk },
          UpdateExpression: `SET ${updateExpressions.join(', ')}`,
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues,
          ReturnValues: 'ALL_NEW',
        }),
      )
    ).Attributes;
  },

  increment: async (pk: string, sk: string, field: string, amount = 1) => {
    return (
      await docClient.send(
        new UpdateCommand({
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
        }),
      )
    ).Attributes;
  },

  delete: async (pk: string, sk: string) => {
    await docClient.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { pk, sk },
      }),
    );
  },

  query: async (
    pk: string,
    options?: {
      skBeginsWith?: string;
      skBetween?: [string, string];
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

    const response = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: keyConditionExpression,
        ExpressionAttributeValues: expressionAttributeValues,
        Limit: options?.limit,
        ScanIndexForward: options?.scanIndexForward ?? true,
        ExclusiveStartKey: options?.exclusiveStartKey,
      }),
    );
    return {
      items: response.Items || [],
      lastEvaluatedKey: response.LastEvaluatedKey,
    };
  },

  batchGet: async (keys: Array<{ pk: string; sk: string }>) => {
    if (keys.length === 0) return [];

    const chunks: Array<Array<{ pk: string; sk: string }>> = [];
    for (let i = 0; i < keys.length; i += 100) {
      chunks.push(keys.slice(i, i + 100));
    }

    const results = await Promise.all(
      chunks.map(chunk => docClient.send(new BatchGetCommand({ RequestItems: { [TABLE_NAME]: { Keys: chunk } } }))),
    );

    return results.flatMap(r => r.Responses?.[TABLE_NAME] || []);
  },

  batchPut: async (items: Array<Record<string, unknown>>) => {
    if (items.length === 0) return;
    if (items.length > 25) {
      const chunks: Array<Array<Record<string, unknown>>> = [];
      for (let i = 0; i < items.length; i += 25) {
        chunks.push(items.slice(i, i + 25));
      }

      await Promise.all(
        chunks.map(chunk =>
          docClient.send(
            new BatchWriteCommand({
              RequestItems: {
                [TABLE_NAME]: chunk.map(item => ({
                  PutRequest: { Item: item },
                })),
              },
            }),
          ),
        ),
      );
      return;
    }

    await docClient.send(
      new BatchWriteCommand({
        RequestItems: {
          [TABLE_NAME]: items.map(item => ({
            PutRequest: { Item: item },
          })),
        },
      }),
    );
  },

  batchDelete: async (keys: Array<{ pk: string; sk: string }>) => {
    if (keys.length === 0) return;
    if (keys.length > 25) {
      const chunks: Array<Array<{ pk: string; sk: string }>> = [];
      for (let i = 0; i < keys.length; i += 25) {
        chunks.push(keys.slice(i, i + 25));
      }

      await Promise.all(
        chunks.map(chunk =>
          docClient.send(
            new BatchWriteCommand({
              RequestItems: {
                [TABLE_NAME]: chunk.map(key => ({
                  DeleteRequest: { Key: key },
                })),
              },
            }),
          ),
        ),
      );
      return;
    }

    await docClient.send(
      new BatchWriteCommand({
        RequestItems: {
          [TABLE_NAME]: keys.map(key => ({
            DeleteRequest: { Key: key },
          })),
        },
      }),
    );
  },

  conditionalPut: async (
    item: Record<string, unknown>,
    expectedVersion?: number,
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      await docClient.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: item,
          ConditionExpression:
            expectedVersion !== undefined ? '#version = :expectedVersion' : 'attribute_not_exists(pk)',
          ExpressionAttributeNames: expectedVersion !== undefined ? { '#version': 'version' } : undefined,
          ExpressionAttributeValues:
            expectedVersion !== undefined ? { ':expectedVersion': expectedVersion } : undefined,
        }),
      );
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
      increments?: Record<string, number>;
      condition?: string;
      conditionNames?: Record<string, string>;
      conditionValues?: Record<string, unknown>;
    }>,
  ) => {
    const transactItems = operations.map(op => {
      switch (op.type) {
        case 'Put':
          return {
            Put: {
              TableName: TABLE_NAME,
              Item: { pk: op.pk, sk: op.sk, ...op.item },
              ConditionExpression: op.condition,
              ExpressionAttributeNames: op.conditionNames,
              ExpressionAttributeValues: op.conditionValues,
            },
          };
        case 'Update': {
          const setKeys = Object.keys(op.updates || {});
          const addKeys = Object.keys(op.increments || {});
          const updateExpressions: string[] = [];
          const addExpressions: string[] = [];
          const expressionAttributeNames: Record<string, string> = { ...op.conditionNames };
          const expressionAttributeValues: Record<string, unknown> = { ...op.conditionValues };

          setKeys.forEach((key, index) => {
            const attrName = `#attr${index}`;
            const attrValue = `:val${index}`;
            updateExpressions.push(`${attrName} = ${attrValue}`);
            expressionAttributeNames[attrName] = key;
            expressionAttributeValues[attrValue] = op.updates?.[key];
          });

          addKeys.forEach((key, index) => {
            const attrName = `#add${index}`;
            const attrValue = `:add${index}`;
            addExpressions.push(`${attrName} ${attrValue}`);
            expressionAttributeNames[attrName] = key;
            expressionAttributeValues[attrValue] = op.increments?.[key];
          });

          const expressionParts: string[] = [];
          if (updateExpressions.length > 0) {
            expressionParts.push(`SET ${updateExpressions.join(', ')}`);
          }
          if (addExpressions.length > 0) {
            expressionParts.push(`ADD ${addExpressions.join(', ')}`);
          }

          return {
            Update: {
              TableName: TABLE_NAME,
              Key: { pk: op.pk, sk: op.sk },
              UpdateExpression: expressionParts.join(' '),
              ConditionExpression: op.condition,
              ExpressionAttributeNames:
                Object.keys(expressionAttributeNames).length > 0 ? expressionAttributeNames : undefined,
              ExpressionAttributeValues:
                Object.keys(expressionAttributeValues).length > 0 ? expressionAttributeValues : undefined,
            },
          };
        }
        case 'Delete':
          return {
            Delete: {
              TableName: TABLE_NAME,
              Key: { pk: op.pk, sk: op.sk },
              ConditionExpression: op.condition,
              ExpressionAttributeNames: op.conditionNames,
              ExpressionAttributeValues: op.conditionValues,
            },
          };
        case 'ConditionCheck':
          return {
            ConditionCheck: {
              TableName: TABLE_NAME,
              Key: { pk: op.pk, sk: op.sk },
              ConditionExpression: op.condition ?? '',
              ExpressionAttributeNames: op.conditionNames,
              ExpressionAttributeValues: op.conditionValues,
            },
          };
        default:
          throw new Error(`Unknown transaction type: ${(op as { type: string }).type}`);
      }
    });

    await docClient.send(
      new TransactWriteCommand({
        TransactItems: transactItems,
      }),
    );
  },
};
