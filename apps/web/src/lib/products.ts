import { supabase } from './supabase';

export type ProductCategory = {
  id: string;
  name: string;
};

export type Product = {
  id: string;
  name: string;
  sortOrder: number;
};

export async function fetchProducts(): Promise<Product[]> {
  const { data, error } = await supabase
    .from('products')
    .select('id,name,sort_order,created_at')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((x: any) => ({
    id: String(x.id),
    name: String(x.name ?? ''),
    sortOrder: Number.isFinite(Number(x.sort_order)) ? Number(x.sort_order) : 0,
  }));
}

export async function createProduct(payload: { name: string }): Promise<string> {
  const trimmed = payload.name.trim();
  if (!trimmed) throw new Error('产品名称不能为空');

  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  const userId = authData.user?.id;
  if (!userId) throw new Error('当前未登录，无法创建产品');

  const { data: maxRow, error: maxErr } = await supabase
    .from('products')
    .select('sort_order')
    .eq('user_id', userId)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (maxErr) throw maxErr;
  const nextSort = Number.isFinite(Number((maxRow as any)?.sort_order))
    ? Number((maxRow as any).sort_order) + 1
    : 0;

  const { data, error } = await supabase
    .from('products')
    .insert({ user_id: userId, name: trimmed, sort_order: nextSort })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

export async function updateProduct(payload: { id: string; name: string }): Promise<void> {
  const trimmed = payload.name.trim();
  if (!trimmed) throw new Error('产品名称不能为空');
  const { error } = await supabase
    .from('products')
    .update({ name: trimmed })
    .eq('id', payload.id);
  if (error) throw error;
}

export async function deleteProduct(productId: string): Promise<void> {
  const { error } = await supabase
    .from('products')
    .delete()
    .eq('id', productId);
  if (error) throw error;
}

export async function moveProduct(payload: { productId: string; direction: 'up' | 'down' }): Promise<void> {
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  const userId = authData.user?.id;
  if (!userId) throw new Error('当前未登录，无法排序产品');

  const { data, error } = await supabase
    .from('products')
    .select('id,sort_order,created_at')
    .eq('user_id', userId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;

  const rows = (data ?? []).map((x: any) => ({
    id: String(x.id),
    sortOrder: Number.isFinite(Number(x.sort_order)) ? Number(x.sort_order) : 0,
  }));
  const idx = rows.findIndex((r) => r.id === payload.productId);
  if (idx < 0) throw new Error('未找到产品');
  const target = payload.direction === 'up' ? idx - 1 : idx + 1;
  if (target < 0 || target >= rows.length) return;

  const curr = rows[idx];
  const next = rows[target];
  const { error: e1 } = await supabase.from('products').update({ sort_order: next.sortOrder }).eq('id', curr.id);
  if (e1) throw e1;
  const { error: e2 } = await supabase.from('products').update({ sort_order: curr.sortOrder }).eq('id', next.id);
  if (e2) throw e2;
}

