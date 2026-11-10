//! 付费插件执行期门禁的公共接口。
//!
//! 插件发现层在会话创建时决定“哪些插件能加载”；这里的门禁回答“已经加载的付费能力，
//! 这一次调用还能不能用”。工具表因此保持不变：到期不删工具、续费不加工具，调用时按
//! 当前 license 判断。实现（读凭据、验签、缓存）在 `nibi-platform`。

/// 执行付费能力前的授权检查。
pub trait PaidPluginGate: Send + Sync {
    /// 这个插件是否属于需要会员的集合。非付费插件返回 false，调用方可跳过后续检查。
    fn is_paid(&self, plugin: &str) -> bool;

    /// 允许执行返回 `Ok(())`；拒绝时返回给用户看的原因（作为工具错误结果，不进系统提示词）。
    fn check(&self, plugin: &str) -> Result<(), String>;

    /// 插件加载后登记付费插件名。缺省不做（嵌入方可以只实现 check）。
    fn register(&self, _plugin: &str) {}
}
