import { APIGatewayProxyResult } from 'aws-lambda';
import { conflict, serverError } from './response';

interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  conflictMessage?: string;
  errorMessage?: string;
}

export async function withRetry<T extends APIGatewayProxyResult>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 5,
    baseDelayMs = 50,
    conflictMessage = 'Operation failed due to concurrent modification. Please retry.',
    errorMessage = 'Operation failed',
  } = options;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'TransactionCanceledException') {
        console.log(`Transaction conflict on attempt ${attempt + 1}, retrying...`);
        if (attempt === maxRetries - 1) {
          return conflict(conflictMessage) as T;
        }
        await new Promise(resolve => setTimeout(resolve, baseDelayMs * (attempt + 1)));
        continue;
      }

      console.error('Error in operation:', error);
      return serverError(errorMessage) as T;
    }
  }

  return serverError('Max retries exceeded') as T;
}
