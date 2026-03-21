export interface User {
  username: string;
  role: 'admin' | 'viewer';
  avatarUrl?: string;
}

export enum AppRoute {
  DASHBOARD = 'dashboard',
  PING = 'ping',
  IMAGE_MANAGER = 'images',
  SETTINGS = 'settings',
  LOGIN = 'login'
}
