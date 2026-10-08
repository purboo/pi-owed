# pi-dag

多 agent 项目的验收账本与合并门禁，构建在 pi-durable-subagents（`../pi-conductor`）之上。

## 阅读顺序与文档状态

| 文档 | 状态 | 内容 |
|---|---|---|
| `ARCHITECTURE.md` | **现行（草案 a3）** | 三公理（史·守·判）、一式 `L ⊢ σ ⟺ O ⊆ E ∪ W`、功能推导、J1 检验、实现分期 |
| `formal/a3/CONTRACT.md` | **现行** | a3 语义契约 K1–K14，模型与正文都以它为准 |
| `formal/a3/REPORT-*.md` | **现行** | a3 的 TLC 检查结果（merge / evidence / auth） |
| `PRODUCT.md` | 现行（v0.3），部分待按 a3 同步 | 产品形态、回执卡、待决队列、dsa 配合、里程碑 |
| `research/selling-points.md` | 现行（v4） | 卖点、北极星指标、禁用说法、改口判据 |
| `research/j1-findings.md` | 研究材料 | J1 证据综合 |
| `formal/README.md`、`formal/*.tla` | **被 a3 取代** | a1/a2/a2.2 的模型；其中 a3/a21/fix 模式的 ✔ 经审查多为同义反复（`research/arch-a22-model-fidelity.md`） |
| `DESIGN.md` | **部分被取代**（v0.1） | 原始设计；§3、§5、§10、§12 被 PRODUCT v0.3 与 ARCHITECTURE a3 取代；§10 第 2 条（采信写者自测）作废；§12 的数字是父级自估，以 E1 为准 |
| `research/ARCHITECTURE-a1.md`、`ARCHITECTURE-a2.2.md`、`PRODUCT-v0.2.md`、`selling-points-v3-final.md` | 历史版本 | 供对照 |
| `research/arch-*.md`、`selling-*.md`、`j1-*.md`、`SYNTHESIS.md` 等 | 研究材料 | 各轮调研与对抗审查原文 |
| `research/review-app-parent-2026-10-08.md` | 外部评审 | app J1 父级的评审，已采纳 5 条（见 ARCHITECTURE a3 头注） |

## 形式化工具

`formal/tla2tools.jar` 不入库，用 `formal/fetch-tla.sh` 下载（TLC v1.8.0，Java 11+）。a3 检查脚本：`formal/a3/check.sh`。
