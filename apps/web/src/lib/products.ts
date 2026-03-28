import { supabase } from './supabase';

export type ProductCategory = {
  id: string;
  name: string;
};

export type Product = {
  id: string;
  name: string;
};

export async function fetchProducts(): Promise<Product[]> {
  const { data, error } = await supabase
    .from('products')
    .select('id,name')
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as Product[];
}

export async function createProduct(payload: { name: string }): Promise<string> {
  const trimmed = payload.name.trim();
  if (!trimmed) throw new Error('产品名称不能为空');

  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  const userId = authData.user?.id;
  if (!userId) throw new Error('当前未登录，无法创建产品');

  const { data, error } = await supabase
    .from('products')
    .insert({ user_id: userId, name: trimmed })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

