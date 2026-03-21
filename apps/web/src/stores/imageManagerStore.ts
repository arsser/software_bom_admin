import { create } from 'zustand';
import { supabase } from '../lib/supabase';

export interface DownloadedImage {
  id: string;
  user_id: string;
  original_url: string;
  storage_path: string;
  file_name: string | null;
  file_size: number | null;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  status: 'pending' | 'downloading' | 'completed' | 'failed';
  error_message: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface ImageManagerState {
  images: DownloadedImage[];
  loading: boolean;
  error: string | null;
  total: number;
  currentPage: number;
  pageSize: number;

  fetchImages: (page?: number, size?: number) => Promise<void>;
  downloadImage: (url: string) => Promise<{ data: DownloadedImage | null; error: string | null }>;
  deleteImage: (id: string) => Promise<boolean>;
  updateDescription: (id: string, description: string) => Promise<boolean>;
  getPublicUrl: (storagePath: string) => string;
  clearError: () => void;
}

const BUCKET_NAME = 'downloaded-images';

export const useImageManagerStore = create<ImageManagerState>((set, get) => ({
  images: [],
  loading: false,
  error: null,
  total: 0,
  currentPage: 1,
  pageSize: 20,

  fetchImages: async (page = 1, size = 20) => {
    set({ loading: true, error: null, currentPage: page, pageSize: size });

    try {
      const from = (page - 1) * size;
      const to = from + size - 1;

      // Get total count
      const { count } = await supabase
        .from('downloaded_images')
        .select('*', { count: 'exact', head: true });

      // Get paginated data
      const { data, error } = await supabase
        .from('downloaded_images')
        .select('*')
        .order('created_at', { ascending: false })
        .range(from, to);

      if (error) throw error;

      set({
        images: data || [],
        total: count || 0,
        loading: false
      });
    } catch (err: any) {
      set({ error: err.message || '加载图片列表失败', loading: false });
    }
  },

  downloadImage: async (url: string) => {
    const state = get();
    // Note: Don't set store error here; return error to caller for modal display

    try {
      // Get session for authorization header
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) {
        throw new Error(`获取会话失败: ${sessionError.message}`);
      }
      if (!session) {
        throw new Error('未登录，请先登录');
      }

      // Call Edge Function to download and store image (bypasses CORS)
      console.log('[ImageManager] 调用 Edge Function:', url);
      const response = await supabase.functions.invoke('download-image', {
        body: { url }
      });

      console.log('[ImageManager] Edge Function 响应:', response);

      // Handle SDK-level errors (network, 404, auth, etc.)
      if (response.error) {
        const error = response.error;
        let errorMessage = error.message || '调用失败';

        if (error instanceof Error && 'context' in error) {
          const httpError = error as any;
          const status = httpError.context?.status;
          const statusText = httpError.context?.statusText;

          // Try to get detailed error from response body
          try {
            const body = await httpError.context.json();
            if (body && body.error) {
              errorMessage = body.details ? `${body.error} (${body.details})` : body.error;
            } else if (status) {
              errorMessage = `HTTP ${status}: ${statusText || '未知错误'}`;
            }
          } catch {
            // If body is not JSON or already consumed
            if (status) {
              errorMessage = `HTTP ${status}: ${statusText || '请求未授权'}`;
            }
          }
        }

        if (errorMessage.includes('404')) {
          throw new Error('Edge Function 未部署或路径错误。请先在 apps/supabase 下执行 pnpm exec supabase start，再在 deploy/production 下运行 pnpm run init-storage');
        } else if (errorMessage.includes('401')) {
          throw new Error('认证失败 (401): 请检查 Supabase 服务是否正常启动或尝试重新登录。');
        }

        throw new Error(`Edge Function 调用失败: ${errorMessage}`);
      }

      // Check response data
      if (!response.data) {
        throw new Error('Edge Function 返回空数据');
      }

      // Handle application-level errors (returned by Edge Function)
      if (!response.data.success) {
        const error = response.data.error || '未知错误';
        const details = response.data.details || '';
        const errorMessage = details ? `${error}\n详情: ${details}` : error;
        throw new Error(errorMessage);
      }

      // Refresh list
      await state.fetchImages(state.currentPage, state.pageSize);

      return { data: response.data.data, error: null };
    } catch (err: any) {
      console.error('[ImageManager] 下载失败:', err);
      const errorMessage = err.message || '下载图片时发生未知错误';
      return { data: null, error: errorMessage };
    }
  },

  deleteImage: async (id: string) => {
    const state = get();

    try {
      // Get the image record first
      const { data: image, error: fetchError } = await supabase
        .from('downloaded_images')
        .select('storage_path')
        .eq('id', id)
        .single();

      if (fetchError) throw fetchError;

      // Delete from storage if exists
      if (image?.storage_path) {
        await supabase.storage
          .from(BUCKET_NAME)
          .remove([image.storage_path]);
      }

      // Delete record
      const { error: deleteError } = await supabase
        .from('downloaded_images')
        .delete()
        .eq('id', id);

      if (deleteError) throw deleteError;

      // Refresh list
      await state.fetchImages(state.currentPage, state.pageSize);

      return true;
    } catch (err: any) {
      set({ error: err.message || '删除图片失败' });
      return false;
    }
  },

  updateDescription: async (id: string, description: string) => {
    try {
      const { error } = await supabase
        .from('downloaded_images')
        .update({ description })
        .eq('id', id);

      if (error) throw error;

      // Update local state
      set((state) => ({
        images: state.images.map((img) =>
          img.id === id ? { ...img, description } : img
        )
      }));

      return true;
    } catch (err: any) {
      console.error('[ImageManager] 更新描述失败:', err);
      return false;
    }
  },

  getPublicUrl: (storagePath: string) => {
    if (!storagePath) return '';
    const { data } = supabase.storage.from(BUCKET_NAME).getPublicUrl(storagePath);
    return data.publicUrl;
  },

  clearError: () => {
    set({ error: null });
  }
}));
