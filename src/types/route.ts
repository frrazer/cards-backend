export interface RouteConfig {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'ANY';
  path: string;
  auth?: boolean;
  timeout?: number;
  memory?: number;
  description?: string;
}
