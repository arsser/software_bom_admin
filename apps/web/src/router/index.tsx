import { createBrowserRouter, Navigate } from 'react-router-dom';
import { ProtectedRoute } from './ProtectedRoute';
import { MainLayout } from '../layouts/MainLayout';
import { Dashboard } from '../components/Dashboard';
import { Settings } from '../components/Settings';
import { Md5Calculator } from '../components/Md5Calculator';
import { BomMaster } from '../components/BomMaster';
import { BomDetail } from '../components/BomDetail';
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
      { path: 'md5', element: <Md5Calculator /> },
      { path: 'bom', element: <BomMaster /> },
      { path: 'bom/new', element: <BomDetail /> },
      { path: 'bom/:batchId', element: <BomDetail /> },
      { path: 'settings', element: <Settings /> }
    ]
  },
  {
    path: '*',
    element: <Navigate to="/dashboard" replace />
  }
]);
