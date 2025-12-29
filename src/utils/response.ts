import { APIGatewayProxyResult } from 'aws-lambda';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export const buildResponse = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
  statusCode,
  headers: HEADERS,
  body: JSON.stringify(body),
});

export const success = <T>(data: T, message?: string): APIGatewayProxyResult =>
  buildResponse(200, { success: true, message, data });

export const badRequest = (message: string): APIGatewayProxyResult =>
  buildResponse(400, { success: false, error: 'Bad Request', message });

export const forbidden = (message: string): APIGatewayProxyResult =>
  buildResponse(403, { success: false, error: 'Forbidden', message });

export const notFound = (message: string): APIGatewayProxyResult =>
  buildResponse(404, { success: false, error: 'Not Found', message });

export const conflict = (message: string): APIGatewayProxyResult =>
  buildResponse(409, { success: false, error: 'Conflict', message });

export const serverError = (message: string): APIGatewayProxyResult =>
  buildResponse(500, { success: false, error: 'Internal Server Error', message });
