import { create } from 'zustand';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

const CONNECTION_ERROR_MSG =
  '无法连接后端服务，请检查网络或 app-config.js 中的 Supabase 地址是否可访问。';

function isConnectionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const msg = (err as Error).message?.toLowerCase() ?? '';
  return (
    msg.includes('fetch') ||
    msg.includes('network') ||
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('load failed') ||
    (err as { code?: string }).code === 'ECONNABORTED'
  );
}

interface AuthState {
  session: Session | null;
  user: User | null;
  loading: boolean;
  connectionError: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  initialize: () => Promise<void>;
  clearConnectionError: () => void;
}

const INIT_TIMEOUT_MS = 12_000;

export const useAuthStore = create<AuthState>((set, _get) => ({
  session: null,
  user: null,
  loading: true,
  connectionError: null,

  signIn: async (email, password) => {
    set({ connectionError: null });
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password
      });
      if (error) throw error;
      set({ session: data.session, user: data.user, connectionError: null });
    } catch (err: unknown) {
      if (isConnectionError(err)) {
        set({ connectionError: CONNECTION_ERROR_MSG });
        throw new Error(CONNECTION_ERROR_MSG);
      }
      throw err;
    }
  },

  signOut: async () => {
    try {
      await supabase.auth.signOut();
    } catch {
      // 离线时也允许登出本地状态
    }
    set({ session: null, user: null, connectionError: null });
  },

  initialize: async () => {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), INIT_TIMEOUT_MS)
    );
    try {
      const { data: { session } } = await Promise.race([
        supabase.auth.getSession(),
        timeout
      ]);
      set({ session, user: session?.user ?? null, loading: false, connectionError: null });

      supabase.auth.onAuthStateChange((_event, session) => {
        set({ session, user: session?.user ?? null });
      });
    } catch (err: unknown) {
      const message = isConnectionError(err) || (err as Error).message === 'Timeout'
        ? CONNECTION_ERROR_MSG
        : (err as Error).message ?? '初始化失败';
      set({ session: null, user: null, loading: false, connectionError: message });
    }
  },

  clearConnectionError: () => set({ connectionError: null }),
}));
