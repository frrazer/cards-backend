import { APIGatewayProxyResult } from 'aws-lambda';
import { badRequest } from './response';

type ParseResult<T> = { success: true; data: T } | { success: false; response: APIGatewayProxyResult };

export function parseBody<T>(body: string | null): ParseResult<T> {
  if (!body) {
    return { success: false, response: badRequest('Request body is required') };
  }

  try {
    return { success: true, data: JSON.parse(body) as T };
  } catch {
    return { success: false, response: badRequest('Invalid JSON in request body') };
  }
}
