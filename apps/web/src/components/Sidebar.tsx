import { useNavigate, useLocation } from 'react-router-dom';
import { LayoutDashboard, Settings, LogOut, Database, ChevronLeft, ChevronRight, Globe2, FileText, Image as ImageIcon } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';

interface SidebarProps {
  collapsed?: boolean;
  onToggle?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ collapsed = false, onToggle }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAuthStore(state => state.user);
  const signOut = useAuthStore(state => state.signOut);

  const navItems = [
    { path: '/dashboard', label: '仪表盘', icon: LayoutDashboard },
    { path: '/ping', label: '域名监测', icon: Globe2 },
    { path: '/ping-logs', label: '监测日志', icon: FileText },
    { path: '/images', label: '图片管理', icon: ImageIcon },
    { path: '/settings', label: '系统设置', icon: Settings },
  ];

  const handleLogout = async () => {
    await signOut();
    navigate('/login');
  };

  // Get user display name from email
  const displayName = user?.email?.split('@')[0] || 'User';

  return (
    <div className={`${collapsed ? 'w-20' : 'w-64'} bg-white border-r border-gray-200 flex flex-col h-full sticky top-0 transition-all duration-300 relative`}>
      {/* Toggle Button */}
      <button
        onClick={onToggle}
        className="absolute -right-3 top-6 w-6 h-6 bg-white border border-gray-200 rounded-full flex items-center justify-center shadow-sm hover:shadow-md transition-shadow z-20 hover:bg-gray-50"
        aria-label={collapsed ? '展开侧边栏' : '收缩侧边栏'}
      >
        {collapsed ? (
          <ChevronRight size={14} className="text-slate-600" />
        ) : (
          <ChevronLeft size={14} className="text-slate-600" />
        )}
      </button>

      {/* Header & Logo */}
      <div className={`p-6 flex items-center ${collapsed ? 'justify-center' : 'gap-3'} border-b border-gray-100`}>
        <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white flex-shrink-0">
          <Database size={18} />
        </div>
        {!collapsed && (
          <span className="font-bold text-xl text-slate-800 tracking-tight whitespace-nowrap">Admin Starter</span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = location.pathname === item.path;
          return (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              className={`w-full flex items-center ${collapsed ? 'justify-center' : 'gap-3'} px-4 py-3 text-sm font-medium rounded-lg transition-all duration-200 ${
                isActive
                  ? 'bg-blue-50 text-blue-700 shadow-sm ring-1 ring-blue-100'
                  : 'text-slate-600 hover:bg-gray-50 hover:text-slate-900'
              }`}
              title={collapsed ? item.label : undefined}
            >
              <Icon size={18} className={isActive ? 'text-blue-600' : 'text-slate-400'} />
              {!collapsed && <span>{item.label}</span>}
            </button>
          );
        })}
      </nav>

      {/* Footer / User Profile / Logout */}
      <div className="p-4 border-t border-gray-100 space-y-4">
         {!collapsed && (
           <div className="flex items-center gap-3 px-2">
              <img
                  src={`https://ui-avatars.com/api/?name=${displayName}&background=random`}
                  alt="User"
                  className="w-9 h-9 rounded-full border border-gray-200 flex-shrink-0"
              />
              <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-slate-800 truncate">{displayName}</p>
                  <p className="text-xs text-slate-500 capitalize truncate">管理员</p>
              </div>
           </div>
         )}
         {collapsed && (
           <div className="flex justify-center">
             <img
                 src={`https://ui-avatars.com/api/?name=${displayName}&background=random`}
                 alt="User"
                 className="w-9 h-9 rounded-full border border-gray-200"
                 title={displayName}
             />
           </div>
         )}

        <button
          onClick={handleLogout}
          className={`w-full flex items-center ${collapsed ? 'justify-center' : 'gap-3'} px-4 py-3 text-sm font-medium text-red-600 hover:bg-red-50 rounded-lg transition-colors`}
          title={collapsed ? '退出登录' : undefined}
        >
          <LogOut size={18} />
          {!collapsed && <span>退出登录</span>}
        </button>
      </div>

      {(import.meta.env.VITE_APP_VERSION ?? '').length > 0 && !collapsed && (
        <div className="px-4 py-2 border-t border-gray-100 bg-gray-50 text-[9px] text-gray-400 font-mono text-left space-y-0.5">
          <div className="truncate" title={`Version: ${import.meta.env.VITE_APP_VERSION}${import.meta.env.VITE_APP_GIT_SHA ? ` (${import.meta.env.VITE_APP_GIT_SHA})` : ''}`}>
            version: {import.meta.env.VITE_APP_VERSION}
            {import.meta.env.VITE_APP_GIT_SHA && ` (${import.meta.env.VITE_APP_GIT_SHA})`}
          </div>
          <div className="truncate" title={`Build Time: ${import.meta.env.VITE_APP_BUILD_TIME || 'Unknown'}`}>
            build at: {import.meta.env.VITE_APP_BUILD_TIME || 'unknown'}
          </div>
        </div>
      )}
    </div>
  );
};
