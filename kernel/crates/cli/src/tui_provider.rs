//! TUI 的 Provider 服务（`/provider`）：列表、预设、保存与删除都交给 platform 的
//! `provider_config.json` 读写（与 Node、App 同一个文件），TUI 自己不做 IO。
use std::sync::Arc;

use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use nibi_kernel_platform::{
    Platform, ProviderDraft as PlatformDraft, ProviderPreset as PlatformPreset,
    ProviderSummary as PlatformSummary,
};
use nibi_kernel_tui::{ProviderDraft, ProviderInfo, ProviderPreset, Providers, SavedProvider};

pub(crate) struct PlatformProviders {
    pub(crate) platform: Arc<Platform>,
}

fn info(summary: PlatformSummary) -> ProviderInfo {
    ProviderInfo {
        id: summary.id,
        name: summary.name,
        base_url: summary.base_url,
        protocol: summary.protocol,
        models: summary.models,
        has_key: summary.has_key,
        account: summary.account,
        personal: summary.personal,
        enabled: summary.enabled,
        template: summary.template,
    }
}

fn preset(preset: PlatformPreset) -> ProviderPreset {
    ProviderPreset {
        id: preset.id,
        name: preset.name,
        base_url: preset.base_url,
        protocol: preset.protocol,
        models: preset.models,
    }
}

fn platform_draft(draft: ProviderDraft) -> PlatformDraft {
    PlatformDraft {
        provider_id: draft.provider,
        name: draft.name,
        base_url: draft.base_url,
        protocol: draft.protocol,
        models: draft.models,
        api_key: draft.api_key,
        template: draft.template,
        enabled: draft.enabled,
    }
}

impl Providers for PlatformProviders {
    fn list(&self) -> BoxFuture<'static, Result<Vec<ProviderInfo>, String>> {
        let platform = self.platform.clone();
        async move {
            platform
                .provider_list()
                .await
                .map(|items| items.into_iter().map(info).collect())
        }
        .boxed()
    }

    fn presets(&self) -> BoxFuture<'static, Result<Vec<ProviderPreset>, String>> {
        let platform = self.platform.clone();
        async move {
            platform
                .provider_presets()
                .await
                .map(|items| items.into_iter().map(preset).collect())
        }
        .boxed()
    }

    fn save(&self, draft: ProviderDraft) -> BoxFuture<'static, Result<SavedProvider, String>> {
        let platform = self.platform.clone();
        let wanted = draft.clone();
        async move {
            let id = platform.save_provider(platform_draft(draft)).await?;
            Ok(SavedProvider {
                id,
                name: wanted.name,
                config: platform
                    .provider_config_file()
                    .as_path()
                    .display()
                    .to_string(),
            })
        }
        .boxed()
    }

    fn remove(&self, id: String) -> BoxFuture<'static, Result<String, String>> {
        let platform = self.platform.clone();
        async move {
            platform.remove_provider(&id).await?;
            Ok(platform
                .provider_config_file()
                .as_path()
                .display()
                .to_string())
        }
        .boxed()
    }
}
