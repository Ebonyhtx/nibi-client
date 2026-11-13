//! 上下文里各类清单的来源（docs/specs/rust-cli/context.md §4）。
//!
//! 每一步把“现在可用的”与“已经告诉过模型的”比较，只发增量 attachment：
//! 延迟工具（`deferred_tools_delta`）、agent 类型（`agent_listing_delta`）、skill（`skill_listing`）。
//! 清单内容由对应能力提供（延迟工具：query / tools；agent：agents；skill：ext），runtime 组装；
//! context 只算增量、渲染文本。

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::message::Message;
use crate::orchestration::{ContextRequest, OrchestrationError};

/// 清单里的一项。`name` 用来算增量；`line` 是渲染进提示词的整行，
/// 例如 agent 的 `- Explore: … (Tools: …)`、skill 的 `- name: description`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListingEntry {
    pub name: String,
    pub line: String,
}

/// 这一步可用的清单。为空表示没有可宣布的内容（对应能力还没接入时也是空）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Listings {
    /// 经 ToolSearch 按需加载、只宣布名字的工具。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deferred_tools: Vec<ListingEntry>,
    /// Agent 工具可用的子代理类型。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<ListingEntry>,
    /// Skill 工具可用的 skill。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<ListingEntry>,
}

#[async_trait]
pub trait ListingSource: Send + Sync {
    async fn listings(&self, request: &ContextRequest) -> Result<Listings, OrchestrationError>;

    /// 带历史的清单：有的清单取决于对话里发生过的事（例如 `paths` 条件 skill 在触及匹配的文件后才出现，
    /// docs/specs/rust-cli/ext.md §2.6）。`history` 是最近一次压缩边界之后的部分。缺省忽略历史。
    async fn listings_for(
        &self,
        request: &ContextRequest,
        _history: &[Message],
    ) -> Result<Listings, OrchestrationError> {
        self.listings(request).await
    }

    /// 已连接的 MCP 服务器给出的 instructions（`mcp_instructions_delta`，ext.md §3.6）：
    /// `name` 是服务器名，`line` 是渲染好的整段（`## <server>\n<instructions>`）。缺省没有。
    async fn mcp_instructions(
        &self,
        _request: &ContextRequest,
    ) -> Result<Vec<ListingEntry>, OrchestrationError> {
        Ok(Vec::new())
    }

    /// 这次会话调用过的 skill（压缩后带回，docs/specs/rust-cli/compact.md §3.4）：`history` 是全部历史（含之前的压缩
    /// 边界之前的部分），最近调用的在前，同名只留最近一次。缺省没有。
    async fn invoked_skills(
        &self,
        _request: &ContextRequest,
        _history: &[Message],
    ) -> Result<Vec<InvokedSkill>, OrchestrationError> {
        Ok(Vec::new())
    }

    /// 人类输入中间写的 `/<名字>` 里对得上可调用 skill 的名字（`skill_mention`，docs/specs/rust-cli/ext.md §2.8、
    /// context.md §4.4），同一个 skill 一次、按出现的顺序。`input` 是这条输入的文字。不是人类键入的输入
    /// （`-p`、stream-json）返回空。缺省没有。
    async fn skill_mentions(
        &self,
        _request: &ContextRequest,
        _input: &str,
    ) -> Result<Vec<String>, OrchestrationError> {
        Ok(Vec::new())
    }
}

/// 调用过的一个 skill：名字、来源路径（`<来源>:<名字>`）与调用时展开的正文。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvokedSkill {
    pub name: String,
    pub path: String,
    pub content: String,
}

/// 一个 skill 在 Composer 引用面板里的样子（`skills/referenceCatalog` 的条目，与 Host 的
/// `nibiSkillReferenceCatalogEntrySchema` 同形）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillReference {
    /// 稳定行身份：`glm:<scope>:<path>`（Host 的 UI 按 `glm:` 前缀过滤 provider，沿用 Node 的写法）。
    pub id: String,
    pub name: String,
    pub description: String,
    pub path: String,
    pub scope: SkillReferenceScope,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_name: Option<String>,
}

/// 引用面板的 scope（封闭三值，Host 严格校验）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillReferenceScope {
    Workspace,
    User,
    Plugin,
}

impl SkillReferenceScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Workspace => "workspace",
            Self::User => "user",
            Self::Plugin => "plugin",
        }
    }
}

/// 插件在 Composer `@` 面板里的身份（`plugins/referenceCatalog` 的条目，Host 的
/// `nibiPluginReferenceCatalogEntrySchema`）。
///
/// 身份与能力字段是 identifiers-only：`plugin_id` 是规范身份（`<manifest.name>@<marketplace>`），
/// `skill_qualified_names` / `mcp_server_names` / `subagent_names` 是「声明」的能力名，与 live 发现取交集后
/// 才注入。`display` 是商店 listing 的可变展示投影，不参与身份、权限或 runtime reminder。
/// `root_path` 只给 runtime 做 provenance 回溯，不进协议。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PluginReference {
    pub plugin_id: String,
    pub name: String,
    pub marketplace: String,
    /// 目录冻结时刻的启用态；disabled 条目保留给 `disabled_in_session` 诊断，不可被引用。
    pub enabled: bool,
    /// 与本条共享 manifest name 的其他**启用**插件：非空即 V1 fail-closed 冲突。
    pub conflicting_plugin_ids: Vec<String>,
    pub skill_qualified_names: Vec<String>,
    pub mcp_server_names: Vec<String>,
    pub subagent_names: Vec<String>,
    pub display: PluginDisplay,
    pub root_path: String,
    /// 商店 listing 的分类（只有 `plugins/referenceCatalogWithCategory` 投影它）。
    pub category: Option<String>,
}

/// 商店 listing 里与 Picker 展示相关的部分（icon/本地化显示名/描述）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PluginDisplay {
    pub icon: Option<String>,
    pub display_name: Option<String>,
    pub display_name_i18n: std::collections::BTreeMap<String, String>,
    /// 插件 manifest 的描述（安装态）或目录条目的描述（未安装）。
    pub description: Option<String>,
    pub description_i18n: std::collections::BTreeMap<String, String>,
}

impl PluginDisplay {
    pub fn is_empty(&self) -> bool {
        self.icon.is_none()
            && self.display_name.is_none()
            && self.display_name_i18n.is_empty()
            && self.description.is_none()
            && self.description_i18n.is_empty()
    }
}

/// 官方市场目录里的一条（未安装也有）：推荐插件的安装前解析与 Picker 展示都用它。
///
/// 字段与 Host 的 `nibiPluginStoreListingSchema` 对齐；缺失的键不下发（Host 按降级矩阵处理）。
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginListing {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub display_name_i18n: std::collections::BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub description_i18n: std::collections::BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publisher_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub privacy_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terms_of_service: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hero_image: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub example_prompts: Vec<String>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub example_prompts_i18n: std::collections::BTreeMap<String, Vec<String>>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub requires_paid_plan: bool,
}

/// 目录里的一条：稳定 ID + manifest 名 + marketplace + 展示投影。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MarketplaceListing {
    pub plugin_id: String,
    pub plugin_name: String,
    pub marketplace: String,
    pub listing: PluginListing,
}

impl MarketplaceListing {
    /// 这一条对 Picker 有用的展示字段（图标/显示名/描述）。
    pub fn display(&self) -> PluginDisplay {
        PluginDisplay {
            icon: self.listing.icon.clone(),
            display_name: self.listing.display_name.clone(),
            display_name_i18n: self.listing.display_name_i18n.clone(),
            description: None,
            description_i18n: self.listing.description_i18n.clone(),
        }
    }
}

/// 推荐插件安装前解析用的事实（Node `plugins/resolveSuggestedReference` 的数据面）：
/// `entry` 是「已发现（含停用/冲突）」，`listing` 是「官方目录里有、本机还没装」。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SuggestedPluginFacts {
    pub entry: Option<PluginReference>,
    pub listing: Option<MarketplaceListing>,
}
