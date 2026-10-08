| 性质 | a3 | a4 |
|---|---|---|
| AuthoritySound | HOLDS / 1019 | VIOLATED / 89 |
| DecisionAuthority | HOLDS / 1019 | VIOLATED / 706 |
| NoWriterJudge | HOLDS / 1019 | HOLDS / 1955 |
| NoAuthorJudge | HOLDS / 1019 | HOLDS / 1955 |
| RelevantInvalidates | HOLDS / 1019 | HOLDS / 1955 |
| UnrelatedPreserves | HOLDS / 1019 | VIOLATED / 753 |
| StateRemainsDebt | HOLDS / 1019 | HOLDS / 1955 |
| ConflictDebt | HOLDS / 1019 | VIOLATED / 1084 |
| SamePrincipalSupersedes | HOLDS / 1019 | VIOLATED / 446 |
| RetroHonored | HOLDS / 1019 | VIOLATED / 953 |
| FuturePreserves | HOLDS / 1019 | VIOLATED / 1207 |
| AllSafety | HOLDS / 1019 | VIOLATED / 89 |
| GoodProgress | HOLDS / 1019 | HOLDS / 1955 |
| Finished | HOLDS / 1019 | HOLDS / 1955 |
| NothingMerged | VIOLATED / 69 | VIOLATED / 69 |
| NothingDeferredMerged | VIOLATED / 197 | VIOLATED / 209 |
| NothingParentWaived | VIOLATED / 242 | VIOLATED / 294 |
| NothingCrossWaived | HOLDS / 1019 | HOLDS / 1955 |
| NothingSpeechWaived | HOLDS / 1019 | HOLDS / 1955 |
| NothingRevivedWaived | HOLDS / 1019 | VIOLATED / 1476 |

| 消融 | 相对 a4 翻转的性质 |
|---|---|
| a4-noAuth | UnrelatedPreserves: VIOLATED→HOLDS；StateRemainsDebt: HOLDS→VIOLATED；FuturePreserves: VIOLATED→HOLDS |
| a4-noInformed | AuthoritySound: VIOLATED→HOLDS；DecisionAuthority: VIOLATED→HOLDS；SamePrincipalSupersedes: VIOLATED→HOLDS；RetroHonored: VIOLATED→HOLDS |
| a4-noRecused | NoWriterJudge: HOLDS→VIOLATED；NoAuthorJudge: HOLDS→VIOLATED |
| a4-noRel1 | 无翻转 |
| a4-noRel2 | AuthoritySound: VIOLATED→HOLDS；DecisionAuthority: VIOLATED→HOLDS；SamePrincipalSupersedes: VIOLATED→HOLDS；RetroHonored: VIOLATED→HOLDS |
| a4-noRel3 | 无翻转 |

| free 检查 | 结果 | distinct states | 实际 TLC rc |
|---|---|---:|---:|
| a4 AllSafety -free2 | VIOLATED | 8812 | 12 |
| a22 AuthoritySound -sanity2 | VIOLATED | 11802 | 12 |
| a22 DecisionAuthority -sanity2 | VIOLATED | 8765 | 12 |
| a22 NoWriterJudge -sanity2 | VIOLATED | 10028 | 12 |
| a4 NothingMerged -witness2 | VIOLATED | 30372 | 12 |
| a4 AllSafety -free3 | VIOLATED | 34642 | 12 |
