export interface User {
  username: string;
  role: 'admin' | 'viewer';
  avatarUrl?: string;
}

/** 历史路由枚举占位；当前路由以 react-router 路径为准 */
export enum AppRoute {
  DASHBOARD = 'dashboard',
  SETTINGS = 'settings',
  LOGIN = 'login',
}
