---
name: owed
description: 多代理任务图的验收账本。使用 owed 派发 worktree、收集实测和独立评审证据、解释拒收与债务，并在合并前检查验收条件。
---

# owed：No receipt, not done.

1. 用 `owed_status`（CLI `owed status`）看 ready 与待办队列。依赖必须有合并记录才能派发；口头“完成”不是收据。
2. 用 `owed_dispatch` 派发 ready 节点。将结果的 `subagents` 对象传给 subagents/dsa：`agent: worker`，`cwd` 必须为 slot worktree，`isolation: none`，`task` 为完整 packet。owed 已创建隔离 worktree，不再套一层隔离。
3. writer 只改 packet 的 writes 范围，完成工作后 commit，保持 worktree 干净。在该 worktree 中执行 `owed submit <node>` 或 `owed_submit`；父代理代提交时显式使用 slot 的 `writer:<node>#<attempt>`。
4. 用 `owed_attest`（CLI `owed attest <node>`）让 executor 实测。先处理原失败的归因重跑，再处理当前候选。读取日志与拒收原因，修复后 commit、submit、attest。
5. 启动全新、独立的 reviewer，交付当前 diff、packet、验收卡和失败证据。reviewer 不得是该节点任何一次尝试的 writer。用 `owed_review` 指定独立 `reviewer:id`、rank、verdict 和 note；闭包变更用 `closure-review`，rank 至少 2。收到新裁决后阅读并用 `ack_rulings` 确认其 seq。
6. 父代理检查收据与实际变更，再用 `owed_merge`。它检查合并树、不变量和 trunk CAS；review ok 或候选 accepted 均不能替代 merge guard。合并后用 `owed_report` 汇报证据、免除及剩余债务。

`owed_why` / `owed why <node>` 的卡片逐项列出 key 与证据：✔ 实测或评审、⚠ 免、✘ 拒收、⊥ 待观察、⊤ 冲突、⏸ 缓判、封。E 是有证据的通过，W 是 owner 免除，D 是剩余债务。还要检查“未测改动”和 ΔO⁻（被削弱/移除的义务）；没有测试覆盖不能说成已验证。

status 的 pending 按解除者分组：parent+writer 负责派发、提交、修复；executor 负责 attest；reviewer 负责独立判断；owner 负责风险和降级。按照队列解决具体义务，不要靠重复调用 merge 碰运气。

不可破坏的规则：

- 不编辑 closure 文件来让检查通过；executor 从 base 固定检查闭包。必要的真实闭包修改必须显式接受 closure-review。
- 不自评，不把 writer 换一个 reviewer 名字伪装独立，不伪造 executor 证据。
- 代理绝不使用 `--i-am-owner`。`owed_waive`、`owed_defer`、降级 `owed_plan` 必须交给人的 UI 确认；无 UI 时停止该决策并报告。
- 父代理可用 `owed_plan` 的文件路径更新计划；降级只能 owner 确认，不能静默削弱验收条件。
- 负观察只能按规则清除。执行失败需对原 key/commit/base 归因：再失败解除旧封；转绿则成为冲突，需 owner 明确承担对应 seq 风险。
- rank r 的判断封只能由原 reviewer 以至少 r 的 ok，或更高 rank 的 reviewer 清除。同 rank 的另一 reviewer 不能清封。owner 免除也必须引用 `accept_risk`。
- 不直接编辑 ledger、blob 或 closure 来绕过拒收。defer 只是允许指定合并保留不变量债务，不是通过；不变量不可 waive。
