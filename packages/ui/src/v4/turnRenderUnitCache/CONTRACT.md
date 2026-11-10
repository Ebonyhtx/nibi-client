# ui-turn-render-unit-cache

长会话渲染隔离的 turn 级缓存。按当前窗口保存 materialized render unit，未变化的 turn 返回同一
引用；时钟只让运行中的轮次失效；离开窗口的条目立即删除。

- 入口：`index.ts`；`contract.ts` 暴露缓存类。
- 不变量：缓存不是第二份消息状态（只存派生结果）；位置归一化每帧按当前窗口重算。
