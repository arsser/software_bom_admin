import { supabase } from './supabase';

export const ARTIFACTORY_SETTINGS_KEY = 'artifactory_config';

export type ArtifactoryConfig = {
  artifactoryBaseUrl?: string;
  artifactoryApiKey?: string;
  artifactoryExtBaseUrl?: string;
  artifactoryExtApiKey?: string;
};

export async function fetchArtifactorySettings(): Promise<ArtifactoryConfig | null> {
  const { data, error } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', ARTIFACTORY_SETTINGS_KEY)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    console.error('fetchArtifactorySettings:', error.message);
    return null;
  }

  const value = (data?.value ?? {}) as ArtifactoryConfig;
  return {
    artifactoryBaseUrl: value.artifactoryBaseUrl ?? '',
    artifactoryApiKey: value.artifactoryApiKey ?? '',
    artifactoryExtBaseUrl: value.artifactoryExtBaseUrl ?? '',
    artifactoryExtApiKey: value.artifactoryExtApiKey ?? '',
  };
}

export async function saveArtifactorySettings(config: ArtifactoryConfig): Promise<void> {
  const { error } = await supabase.from('system_settings').upsert(
    {
      key: ARTIFACTORY_SETTINGS_KEY,
      value: {
        artifactoryBaseUrl: config.artifactoryBaseUrl?.trim() ?? '',
        artifactoryApiKey: config.artifactoryApiKey ?? '',
        artifactoryExtBaseUrl: config.artifactoryExtBaseUrl?.trim() ?? '',
        artifactoryExtApiKey: config.artifactoryExtApiKey ?? '',
      },
    },
    { onConflict: 'key' },
  );
  if (error) throw error;
}
