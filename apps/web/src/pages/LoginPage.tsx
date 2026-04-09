import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { ShieldCheck, Lock, Mail, ArrowRight, AlertCircle } from 'lucide-react';

export const LoginPage: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const signIn = useAuthStore(state => state.signIn);
  const connectionError = useAuthStore(state => state.connectionError);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (connectionError) return;
    setError('');
    useAuthStore.setState({ connectionError: null });
    setLoading(true);

    try {
      await signIn(email, password);
      navigate('/dashboard');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '登录失败，请检查邮箱和密码';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const displayError = error || connectionError || null;
  const isBackendUnreachable = !!connectionError;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
      <div className="bg-white p-8 rounded-2xl shadow-xl border border-gray-100 max-w-md w-full space-y-8">
        <div className="text-center">
          <div className="w-16 h-16 bg-blue-600 rounded-xl mx-auto flex items-center justify-center text-white mb-4 shadow-lg shadow-blue-200">
            <ShieldCheck size={32} />
          </div>
          <h1 className="text-3xl font-bold text-slate-900">software bom admin</h1>
          <p className="text-slate-500 mt-2">登录以管理您的后台</p>
        </div>

        {displayError && (
          <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">
            <AlertCircle size={16} className="shrink-0" />
            <span>{displayError}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4" autoComplete="on" name="login">
          <div>
            <label htmlFor="username" className="block text-sm font-medium text-slate-700 mb-1">邮箱</label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
              <input
                id="username"
                name="username"
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isBackendUnreachable}
                className="w-full pl-10 pr-4 py-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all disabled:bg-gray-100 disabled:cursor-not-allowed"
                placeholder="your@email.com"
              />
            </div>
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-slate-700 mb-1">密码</label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
              <input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isBackendUnreachable}
                className="w-full pl-10 pr-4 py-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all disabled:bg-gray-100 disabled:cursor-not-allowed"
                placeholder="••••••••"
              />
            </div>
          </div>

          <div className="flex items-center">
            <input
              id="remember-me"
              name="remember-me"
              type="checkbox"
              disabled={isBackendUnreachable}
              className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
            />
            <label htmlFor="remember-me" className="ml-2 block text-sm text-slate-600 cursor-pointer">
              记住我
            </label>
          </div>

          <button
            type="submit"
            disabled={loading || isBackendUnreachable}
            className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-all flex items-center justify-center gap-2 group"
          >
            {loading ? '登录中...' : isBackendUnreachable ? '后端不可用，无法登录' : '登录'}
            {!loading && !isBackendUnreachable && <ArrowRight size={18} className="group-hover:translate-x-1 transition-transform" />}
          </button>
        </form>

        {(import.meta.env.VITE_APP_VERSION ?? '').length > 0 && (
          <div className="pt-4 border-t border-gray-50 text-[10px] text-slate-400 font-mono text-center space-y-1">
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
    </div>
  );
};
