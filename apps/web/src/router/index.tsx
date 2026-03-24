import { createBrowserRouter, Navigate } from 'react-router-dom';
import { ProtectedRoute } from './ProtectedRoute';
import { MainLayout } from '../layouts/MainLayout';
import { Dashboard } from '../components/Dashboard';
import { Settings } from '../components/Settings';
import { PingMonitor } from '../components/PingMonitor';
import { PingLogs } from '../components/PingLogs';
import { ImageManager } from '../components/ImageManager';
import { Md5Calculator } from '../components/Md5Calculator';
import { LoginPage } from '../pages/LoginPage';

export const router = createBrowserRouter([
  {
    path: '/login',
    element: <LoginPage />
  },
  {
    path: '/',
    element: (
      <ProtectedRoute>
        <MainLayout />
      </ProtectedRoute>
    ),
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <Dashboard /> },
      { path: 'ping', element: <PingMonitor /> },
      { path: 'ping-logs', element: <PingLogs /> },
      { path: 'images', element: <ImageManager /> },
      { path: 'md5', element: <Md5Calculator /> },
      { path: 'settings', element: <Settings /> }
    ]
  },
  {
    path: '*',
    element: <Navigate to="/dashboard" replace />
  }
]);
