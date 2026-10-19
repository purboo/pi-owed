import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import { createHash } from 'node:crypto';

// PR2/R-028-61/64: exact sites, not files or whole functions, are the exception boundary.
type Class = 'help/usage' | 'comment' | 'Git commit message' | 'executable argv' | 'diagnostic example' | 'historical text' | 'Git-derived status addition' | 'operation refusal' | 'cycle-blocked remedy';
type Site = { file: string; fn: string; literal: string; comment: boolean };
type Registered = [file: string, fn: string, kind: Class, reason: string, literal: string];
const acts = /\bowed\s+(?:start|decide|answer|init|plan|rule|edit|amend|dispatch|submit|rebase|attest|review|waive|defer|abandon|resume|approve|evidence|merge|adopt|status|idle|why|report|brief|verify|sweep|escape|decoy|gc|drive|help|version)\b|\bowed\s+\$\{/;
function enclosing(node: ts.Node): string {
  let name = '<module>';
  for (let p: ts.Node | undefined = node; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) name = p.name.text;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) name = p.name.text;
    if (ts.isMethodDeclaration(p) && p.name && p.parent && ts.isClassDeclaration(p.parent)) name = `${p.parent.name?.text ?? '<class>'}.${p.name.getText()}`;
  }
  return name;
}
function unparenthesized(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}
function literalText(node: ts.Expression): string | undefined {
  const expression = unparenthesized(node);
  return ts.isStringLiteralLike(expression) ? expression.text : undefined;
}
function plusParts(node: ts.Expression): ts.Expression[] {
  const expression = unparenthesized(node);
  return ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken
    ? [...plusParts(expression.left), ...plusParts(expression.right)] : [expression];
}
function inventory(file: string, source: string): Site[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), sites: Site[] = [], comments = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      // R-028-68: inline only literal spans; still visit expressions for nested sites.
      const text = ts.isTemplateExpression(node) ? node.head.text + node.templateSpans.map(s => (literalText(s.expression) ?? '${}') + s.literal.text).join('') : node.text;
      if (acts.test(text) || /\bowed\s+\$\{/.test(node.getText(sf))) sites.push({ file, fn: enclosing(node), literal: node.getText(sf), comment: false });
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      let parent = node.parent;
      while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
      // Scan only the outer '+' chain; existing literal sites retain their original digests.
      if (!ts.isBinaryExpression(parent) || parent.operatorToken.kind !== ts.SyntaxKind.PlusToken) {
        const parts = plusParts(node).map(literalText);
        if (parts.some(p => p !== undefined) && !parts.some(p => p !== undefined && acts.test(p)) && acts.test(parts.map(p => p ?? '${}').join(''))) {
          sites.push({ file, fn: enclosing(node), literal: node.getText(sf), comment: false });
        }
      }
    }
    for (const range of [...(ts.getLeadingCommentRanges(source, node.pos) ?? []), ...(ts.getTrailingCommentRanges(source, node.end) ?? [])]) {
      if (comments.has(range.pos)) continue;
      comments.add(range.pos);
      const literal = source.slice(range.pos, range.end);
      if (acts.test(literal)) sites.push({ file, fn: enclosing(node), literal, comment: true });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}
// Exact raw-source digests keep the inventory compact without allowing a whole file/function.
const digest = (literal: string): string => createHash('sha256').update(literal).digest('hex');
const at = (file: string, fn: string, kind: Class, reason: string, literals: string[]): Registered[] => literals.map(literal => [file, fn, kind, reason, literal]);
const registered: Registered[] = [
  ...at('src/answer.ts', 'rulingDeliveryWarnings', 'cycle-blocked remedy', 'R-028-64: views.oneLine has other callers; needs -> views -> needs.', ['c755286339b655ec6008549ca5bc9fc371efb94b4af1c4e74b2266aa0d6d362d', '0733c972e32508b7edd7ac6726c7f52e1b1e70d6f814dfc0589f3858087cbffd', '461bda46a50609e8923b7485a99c49bf6aa6ed1d5518330d0911c59e7de6dc90']),
  ...at('src/cli.ts', 'HELP', 'help/usage', 'CLI grammar and examples.', ['3fe65ea697f458a41b38afe12f44c525ddb668578c65afd30dcd0e97af8ade93']),
  ...at('src/cli.ts', 'main', 'historical text', 'Runtime version label, not an act.', ['8d2a0da087698b1c2364c3c7775ef339a80779374bf20887c92c1699030a9e56']),
  ...at('src/cli.ts', 'main', 'comment', 'Source commentary only.', ['f512c3053e124bcb1d3bfe911409b51eb80a0d81d2c62f44b6551efa2b414707', 'd1356cf0fadf27be887f3f5a63579e6aef0b53d52179e3a651c63269fed967dd', '0cc59866549a3b0037f60fb70c6b26ca393013004592d6347485d40b2a76fcf9']),
  ...at('src/cli.ts', 'main', 'help/usage', 'R-028-61: agent submit instructions.', ['8beef719f1119e332edddddb73e4eaca8f35a6e65a372e482dfdf7c56580e854']),
  ...at('src/cli.ts', 'main', 'Git commit message', 'Label passed to git.buildMerge.', ['15e8d3b405ff169c9c755a44ca18c0c6190c271e70de7f7c41558160db7d36a9']),
  ...at('src/drive-bg.ts', '<module>', 'comment', 'Source commentary only.', ['463f35dde092ccf01d3ae179500e87911a5c3bf6d6397c6fc440b3abecea073f', 'd4b88a35502ca479b6fc83d3e6cef4ba2b94b1ba96ca162a517ade0d3ea72091', '21563d7156b3ce0411960bad0a86077bee68a0dab285d8ed1fd9fd452c71ad2b']),
  ...at('src/drive-bg.ts', 'driveStart', 'comment', 'Source commentary only.', ['e3784eee0d3a9f63240cf50a548fafabeb76ca345e2b5f995e147f3cde0d04b7']),
  ...at('src/drive-bg.ts', 'driveStart', 'help/usage', 'R-028-61: pre-State initialization guidance.', ['4160635a8fc5a73bc449efcbb8864468e0d2a9301e3a9242ca7629345759878b']),
  ...at('src/drive-bg.ts', 'driveStart', 'operation refusal', 'R-028-61: inline synchronous refusal.', ['c69183f7ee5538101bebe77e2b1ce09b757e9e366722b2c8e37b80a93a1f4f7b', '0503a55a3da16b2cda8cb7111cd6655b5eecf005fdb636b48a0ad4a2ff2be539']),
  ...at('src/drive-bg.ts', 'driveStatus', 'comment', 'Source commentary only.', ['fb18aa709d09ad6a2e19dd11e15689526a9406f81cc4055d4e0e2208b4cde2d2']),
  ...at('src/drive-bg.ts', 'driveStop', 'comment', 'Source commentary only.', ['e83d4cb68da19737131e4636c921f57bd5d13b0a622defb28b8fc1cab6d012a2']),
  ...at('src/drive-bg.ts', 'plainNeed', 'historical text', 'R-028-61: old log lines without a need field only.', ['736c230b9e6ca8ac895fd482c267cd4ff5ffb4b7437e3f1fa40502741b29c81d', 'f9fdd6c52c99a5ee7a17beecd3ac675c23a39ee444ceb21519a92bb829700dce', '7abc5d8da3836c79794c2ac5f189ccfae456e41be2544a793279fa2441bd2344', 'a6353e9aa96f59832649904ca745e5479858854313c6826d08c8af402313b672', '83fbd77e534df34502308f53735e221e3dbf087b425241ada9a5e8088ba59384', '93a474f66eba2a01fcd65fb06832242609fada7f6ca8bb804f247174d5752f13', '83fbd77e534df34502308f53735e221e3dbf087b425241ada9a5e8088ba59384', '0cc5612b17a8711a96b3684e99f38d5f3563a3e735feb26bf0b167ef53399dea']),
  ...at('src/drive-bg.ts', 'Follower.message', 'comment', 'Source commentary only.', ['5e2772e64003a1e0fc4ca6a5504416c86522284e03d2b59c68b2fe89a013d423']),
  ...at('src/drive-bg.ts', 'Follower.message', 'diagnostic example', 'Log heading and inspection links.', ['689ec7e10610a17c3fa643c67844e90c9f27a50939a0e75d714e6758066c3e6d', 'c27e1ca2528084f25006f25a89aee7a5b2e73a8b2efa29130f274dd389c935f6']),
  ...at('src/drive-run.ts', '<module>', 'comment', 'Source commentary only.', ['5bdd23390b313d74bcc534df49badd6c4bd76bd515a7c6220fa58cd35a5dcb9e', '046abd510f8ff1f358f3f4ff793a147a13f0282dbb0c70a5180c46ec5d7693c3', 'ffc459fca7af884ce8820ebdb16bbdff7b67e67f0e2d729d2e46a5d7ec9bed4d', 'e6f09c55ec8a87ab9e99a41b0d466f79d49626b5fb14d2c335ff2716e7d6414d', 'e1fb2d7b40cee45988f4925c9ce2516397c4eeb6ab3a4042f0d1f15c4b7e0995', '0039bd0cfe8d500a984cefa872a178ef12a204f4c99b6e372731a4d4f512f307']),
  ...at('src/drive-run.ts', 'acquireDriveLock', 'operation refusal', 'R-028-61: inline synchronous refusal.', ['360bbcd4a9bd07fceba854177c4d91c0373748f8d9de29149d6f484a70ad9d1b', '1448121cb54c2654cba71149210b352a93befec79e3a835b6b93090a1f4fc516']),
  ...at('src/drive-run.ts', 'IDLE_WAIT_TEXT', 'diagnostic example', 'Static staying-driver stop instruction.', ['919873db393fcb2f4fce5fce2d63a7c509e4d01c38f033c094ff9f949fc3af6c']),
  ...at('src/drive-run.ts', 'reportText', 'comment', 'Source commentary only.', ['aefb4f725ea853859e9b7d536f177b374e12a14f5e2b6bfdde8a00106cba35cb']),
  ...at('src/drive-run.ts', 'reportText', 'cycle-blocked remedy', 'R-028-64: shared executor/view formatters; needs -> drive-run -> needs.', ['af938077de5061e9a03876e922a18aa05b2e3fba0ddf5c514b09eb227eaea0f4']),
  ...at('src/drive-run.ts', 'Driver.attest', 'comment', 'Source commentary only.', ['e2c19b0987718ab1dbbd9aadd5544e2dc0f1e79cc3b6e7010fdbc192fc67d770']),
  ...at('src/drive-run.ts', 'Driver.attest', 'diagnostic example', 'Executor compatibility and observed exit diagnostics.', ['3623ce6d2eff7c1e77642b10b8aa51e324794fd028a34025486ff46e60372877', '5e5eef79cfbdd649086ffa4076c118d91164233c8494da7dfc6d0e8b58c2443c']),
  ...at('src/drive-run.ts', 'Driver.remeasureFirst', 'comment', 'Source commentary only.', ['5fac72f2747cfdb8dedb160fd964075f4cb56639734e5545ac97b020db056375']),
  ...at('src/drive-run.ts', 'drive', 'comment', 'Source commentary only.', ['08f7bedf67fb07c782147e6d98a853136f44c389b30b448ae3ffe84e5bfa3154']),
  ...at('src/drive-run.ts', 'driveLoop', 'comment', 'Source commentary only.', ['b82348f7f8c163fdbd40c9ae841ea8e1cd134a7f72aa6ace98d99216d9c0f99b', '032aa7d0c2b0e1d1ce6cf4376663b8c312d001b194215e516afc3f68c2067bac']),
  ...at('src/drive.ts', '<module>', 'comment', 'Source commentary only.', ['20fc9a452a26244b9fe2c4dd466aadc11cd1cbc7d5dcce83314e43efde5e329a', '2a991ae3d5c53b8b59f6dfec6eee01abc2932674d192f25c266617d984405a47']),
  ...at('src/drive.ts', 'setupNotices', 'cycle-blocked remedy', 'R-028-64: setupSignature has other callers; needs -> remeasure-on -> needs.', ['eb38aabf0733b89d3b374aa9dd83b00d3a9e25a9a9e9c548247adff6279231d1']),
  ...at('src/drive.ts', 'runName', 'historical text', 'Runtime agent identity label, not an act.', ['8f3631803b96925096dde4045e0b1998e68d4359f86b2e826fb31c4c28d17e76']),
  ...at('src/drive.ts', 'WRITER_INTERRUPTED', 'help/usage', 'R-028-61: agent instructions, not a state remedy.', ['6147ab4ee37b64609969c82db4adb0cb0d8231475419c9eaf070a6c3211e6e3b']),
  ...at('src/drive.ts', 'submitMessage', 'help/usage', 'R-028-61: agent instructions, not a state remedy.', ['ba621f9bbfd504b63a5463531fcf5238db6bc07091cdf6082b666d1f021ecd47']),
  ...at('src/drive.ts', 'planChangedMessage', 'help/usage', 'R-028-61: agent instructions, not a state remedy.', ['8175da6e643ba580e52e7f2b43ef3d0ed5c46208dcdc678b9051f6e43d30eea5']),
  ...at('src/drive.ts', 'verdictMessage', 'comment', 'Source commentary only.', ['18a23fa9d5ada51bbaddd62e1283cd4ab97e365f75a8e869af8befde0011befc']),
  ...at('src/drive.ts', 'verdictMessage', 'help/usage', 'R-028-61: reviewer instructions, not a parent/owner selector.', ['aac2df3c10aa72572bc51eb8fb9162ef8f13ad6d4bd4b5213f9b4de2619e203a']),
  ...at('src/drive.ts', 'reviewerInterrupted', 'help/usage', 'R-028-61: agent instructions.', ['929cfe69add24a3bb512e63fc6881b7f418b5a7bbe52d43206c95f2bfb923677']),
  ...at('src/drive.ts', 'repairMessage', 'comment', 'Source commentary only.', ['fb4f7d248f524e8c54123d7b782a977589d11beac6aa6dd77c6dacc2ef0b950f']),
  ...at('src/drive.ts', 'repairFollowUp', 'help/usage', 'R-028-61: writer repair packet.', ['144ec6e631e811fcc5f29a7e709fd5d0aa28f2d46e43f4ab6da12550a857c3a3']),
  ...at('src/drive.ts', 'rebaseMessage', 'help/usage', 'R-028-61: writer rebase packet.', ['891de0726068140e5fd04a9d2a577c976acb98856c45592b40c46fa34a19e01c']),
  ...at('src/drive.ts', 'unruledBlocks', 'comment', 'Source commentary only.', ['354e0aa43e43ec29ace4f72fd3f389e08b7059dc0594f66ea45bbd27485ba4e9']),
  ...at('src/drive.ts', 'resubmitFollowUp', 'help/usage', 'R-028-61: writer packet.', ['7351ff94930c19c9f508f787c7c3b27885173d13fe2013f1d59dbcb03099be45']),
  ...at('src/drive.ts', 'rulingFollowUp', 'help/usage', 'R-028-61: writer packet.', ['5f80d3ac5227ebc6be1d3765881ea827f5125be219994e41353cc17059b6f908', 'bce20da4ddd14ba01894d31c598cc95f24888d407b8a7a43a9a80924ee772bcf']),
  ...at('src/drive.ts', 'environmentText', 'cycle-blocked remedy', 'R-028-64: clip has other callers; needs -> drive -> needs.', ['57ab6ad4c49b7735298491282716c4f786db7cd3a6879c93475d005b699980e6']),
  ...at('src/drive.ts', 'slotAction', 'help/usage', 'R-028-61: writer packet and exact legacy packet fragment matching.', ['bfffe7c9e730ee06d45ab981c15ec39c5278fcb5955009a19931591996975ecf', '6b3a86ace0ec38b9e79e44f5baa61364fcc8f059ac4c14b8b632a7fd72b193f1', '9f20a409083db31151f015a88af3532a57fbdefa1c98964d8f19d0d1592ea303', 'c9b2e5d7dd58e5ea267f9043e6050153e8a1cfd68d58513c9a052c95262822f4']),
  ...at('src/drive.ts', 'slotAction', 'comment', 'Source commentary only.', ['cb4c66ee5578575a42e9e734f28032600fc82d4a5a38a3f9509ee09573dc4dda']),
  ...at('src/drive.ts', 'slotAction', 'historical text', 'R-028-42: persisted halt cause retains its historical tail.', ['2301efdd66a0dad4496b1c2942eecd556282a2785a368b964d3af989eed9fa31']),
  ...at('src/drive.ts', 'askingText', 'comment', 'Source commentary only.', ['7b2ac918b8de5a774bc099306aaf042fea4c081e0d40a6a62d4f06294ad8a97c']),
  ...at('src/drive.ts', 'askingText', 'help/usage', 'Runner question response instructions, not needs membership.', ['6d6621c8b0d60e9a6342807fbd3e6ab1e2961ff2896908f981caeb40162744f6', '6e0ee127b29d272310e8f96745b5afd1f5790005fe5c1126f23e553303053b03']),
  ...at('src/errors.ts', '<module>', 'comment', 'Source commentary only.', ['c338bfaed9c7cf3ca7c8f5e648195d765348945781a37bf7cd6af7b8e3ef2966']),
  ...at('src/ext-worker.ts', 'restartLine', 'historical text', 'Runtime version label, not an act.', ['8cd742bda80567c1ac0b9fec423f1ec9eb1e8d428f510418272ac7890326798f']),
  ...at('src/ext-worker.ts', 'toolWorker', 'historical text', 'Runtime version label, not an act.', ['61f7b1dbfbc986fa6a6b9162952997f0dae61949ef4bb279e9e57f2748367cb9']),
  ...at('src/ext-worker.ts', '<module>', 'historical text', 'Runtime version label, not an act.', ['1b316d25a7fbd3f4e194a96cd03e664cd352ccdd21097df8bfc294e0674832e0', '9c631f066169ac4b333c91cdffa27c4b133390fffe53eca5bd7db28112bfe019']),
  ...at('src/extension.ts', 'owed', 'help/usage', 'R-028-61: tool descriptions and initialization instructions.', ['8649c82175e5bb1826a81d07258bafa2270412b92eccf4b3a835479d9796f7fd', '5abf05bdc16c991b74e05e1c5e11ee93bb9dee3eb70277239dad89760bfbf3e5', 'cede56f83c009c193bc97a3fb60d653367cc60051b65ae93c45383fdb3e97efd', '59091a6d1f531a789677a38710f5e2991631b00bc2a2d836e520db269be72dbf', '60e2fd9e14a7406636f8b935dd3d748e46dbc58b6c6ae3f255316bdf6ea618b6', 'b425504b5c0b4c258b4bf8c15803c83fe7446fe48fff0794bfff74c4aefca888', 'fdef57da8950d440789a7ad483e9852ae2f72ed3443d0b7d4373534e6f5c60ce']),
  ...at('src/extension.ts', 'owed', 'diagnostic example', 'Genesis completion/failure event labels.', ['1e2951465f04db608e957fdf6675ca8a8929ab41d4d53a1a9024a4343e25a89f', 'b73ec9f11e0ba36a00a5155d291a80bbbcf6616ad06ccc9dde16f4f33a04c6e6']),
  ...at('src/extension.ts', 'owed', 'Git commit message', 'Label passed to git.buildMerge.', ['dda87601474a0aaa8f7ec2df84beda0185841c06b724883a201da223dbd0514e']),
  ...at('src/ledger.ts', '<module>', 'comment', 'Source commentary only.', ['1921fadc3f2adbe525604af96ce12a21d6fa8899b117bb4a3ba398eed547bb72']),
  ...at('src/ledger.ts', 'Ledger.rawPlanCache', 'comment', 'Source commentary only.', ['9a26c31e187e2d9a852e0e6b5fe8d61bc6f7e24d3ca18dd89a15bca63d69de8a']),
  ...at('src/ledger.ts', 'Ledger.readSnapshot', 'comment', 'Source commentary only.', ['c44c989d72141a05b84395f338f9f7ef0ec0720898eb1fe43bfeab0ae9c89e24']),
  ...at('src/metrics.ts', 'renderMetrics', 'diagnostic example', 'Counterfactual inspection link.', ['9828420f6e0abeb9124021b9ad87733d525131e3fe4c4fa0dce5ce6393bae073']),
  ...at('src/ops.ts', 'attestTrunkText', 'cycle-blocked remedy', 'R-028-64: remeasureText/view helpers have other callers; needs -> ops/views -> needs.', ['5ace2bb11771821e8fdb0950a266f8f2482e1ac3d40bf8c6c59b876723922b9f']),
  ...at('src/ops.ts', 'DRIVER_CLAIM', 'help/usage', 'Identity restriction, not a resolving command.', ['728c2d4dbc7237139c429961e76483f623b2fd376f4883c08604d4d068ad909a']),
  ...at('src/ops.ts', 'inited', 'help/usage', 'R-028-61: pre-State initialization guidance.', ['4160635a8fc5a73bc449efcbb8864468e0d2a9301e3a9242ca7629345759878b']),
  ...at('src/ops.ts', 'automaticRemeasureHints', 'cycle-blocked remedy', 'R-028-64: oneLine and shared rendering; needs -> views -> needs.', ['18805f7b11e768684094a3bf3b779d3f499965f8403764ccb894fddd83e89b66']),
  ...at('src/ops.ts', 'initPreview', 'operation refusal', 'R-028-61: inline synchronous refusal.', ['3072a020f6c7c821d196e7a33b5f46dd279e23e16418b8e7936193da9f3d2563']),
  ...at('src/ops.ts', 'genesisIncompleteText', 'cycle-blocked remedy', 'R-028-64(2): kept with measurement result rendering in ops; needs -> ops -> needs.', ['c7661456d6c900cd95e65fce5c518ebebe2af824db3ecd21d92a7c645d798f03']),
  ...at('src/ops.ts', 'attestGenesis', 'diagnostic example', 'Busy measurement status inspection.', ['59db3022486751408f7ab854dbb7415b691fafe5e26accff2292ee2e3322ca05']),
  ...at('src/ops.ts', 'attestTrunk', 'diagnostic example', 'Busy measurement status inspection.', ['ebe81012fbd9f8e84bb20114e423e63abd557560d6394cfb0eccb6abd85ce16d']),
  ...at('src/ops.ts', 'readPlan', 'comment', 'Source commentary only.', ['75d9cd034b1ef09e60d2594380890283b9b640cb6fe7f457415969c49e2a2548']),
  ...at('src/ops.ts', 'start', 'help/usage', 'R-028-61: pre-State invocation/setup guidance.', ['dc3bd9c09f6f6c3c8d623fb3b82adc9461d2b5dcf07339f52278f49870e0862c', '7a7bdf3a3a748b95dbba9e2bd5c3226818b1b3d8dab841253b7c296a294d06c2', '37542fcf8c5abc3714fd87a1486eaf890e9919befa51d0d014f9da43ba4584c0', 'd03009e6faec21a9b21f92fc9fbbe19bd93ce512f591f37e94554f0001573eff', '26402f2a0cd43b811eb213523fcab7e79d71ef132a7bb760017a19ea0583ae71', '137a87471d31064e373cd0075d502bd39e350a5ad8b89d57648b5123d9b78e69', '37dfa389a60795af4de2843fa263550b2d76e4fa70babe659ea74fe70400d76a', '3e74f10f1fd082a809b82d12f57fcdfe46dc51735ab4d75461abf32c86016425', 'bdcb10d2a87ff300d100e934b0c83fb6edaa2fd3d204041587e18d1675f25a4a', '3370031f10150a4eed3a43bba78459e3ecd10d5b56e29fb55f880395a8bb7085']),
  ...at('src/ops.ts', 'startText', 'help/usage', 'Startup result usage instructions.', ['6e0cff0bf2a1e50651de831b3ec5ef7cf90203f4e3cf7a594a6060eeff9ed698', 'b95b4d58aa90aaf228a6366a08ec114840ad80cd22453366d80e8cb1942ed5b8']),
  ...at('src/ops.ts', '<module>', 'comment', 'Source commentary only.', ['3b81dd4473a20a777fa00c60ee63a34f86c04db49af61d417eec0bb56643b7e1', 'cdb2fbd5519fb3ebd9faa94e4e97a74a18c307d0424fd192313d6c585320bcb0', 'e40d10694c9cf44510c41fdd723f11e0c735a96f1df7563b68e3b0415e4307e7', '547a4932d3b713d26ef155fcbe07515d531ca5697318140fbfaed2910d40666e']),
  ...at('src/ops.ts', 'amendLimitText', 'help/usage', 'R-0291-4: AC1 successful amend receipt guidance; not needs selection.', ['5e8ef112db1bc85a74cb2d4539a3849149a888d11dd33dcf500aac5d459f5be3']),
  ...at('src/ops.ts', 'amendPaths', 'operation refusal', 'R-028-61: inline synchronous refusal.', ['d7ce7fcfd08952b673883ccf6433d28b47651746eed288cababab101c8cf3214']),
  ...at('src/ops.ts', 'amendSource', 'operation refusal', 'R-028-61: inline synchronous refusal.', ['bb0dd7d830ece521d8839f50c98fc30fcd10f21b71f684021461d1a4ff8eada6']),
  ...at('src/ops.ts', 'amendEdit', 'operation refusal', 'R-028-61: inline synchronous refusal.', ['a7f82766cf2324cc0b6b6e05219337902b2a308453006c30d7e63249eee475f8']),
  ...at('src/ops.ts', 'amendPreview', 'comment', 'Source commentary only.', ['ba37ecd526dc1f8cf0bf7f67e1d203d17d7ce48a5ada077ec350081cfc270b61']),
  ...at('src/ops.ts', 'amend', 'comment', 'Source commentary only.', ['793f01c3bcd91b61ee03899812ceea1a78b394f7a073f09745a198273f9419e6', 'c09435cb32d24c9759eb05d1530fd6e2c40f8a1af9c85977163bd97d13d42ec6']),
  ...at('src/ops.ts', 'prepareEdit', 'operation refusal', 'R-028-61: inline synchronous refusal.', ['a7f82766cf2324cc0b6b6e05219337902b2a308453006c30d7e63249eee475f8']),
  ...at('src/ops.ts', 'decide', 'operation refusal', 'R-028-61: inline synchronous refusal.', ['cc064b648d9db9682164e162aeabc8ffb17e591b02b09ec34b0b1bf8cb2c8501']),
  ...at('src/ops.ts', 'decide', 'Git commit message', 'Label passed to git.buildMerge.', ['15e8d3b405ff169c9c755a44ca18c0c6190c271e70de7f7c41558160db7d36a9']),
  ...at('src/ops.ts', 'readyDispatchNode', 'operation refusal', 'R-028-61: inline synchronous refusal.', ['55e2a8ff05da956d156986e7e5e25c5404ff15c5f7739a28c090fe2f05ed5f32']),
  ...at('src/ops.ts', 'remeasureMerge', 'Git commit message', 'Label passed to git.buildMerge.', ['facc0d2660e13d56989bc2e5b4733de416c079e3bd4bfd48e3f21c87e778becd']),
  ...at('src/ops.ts', 'remeasureMerge', 'operation refusal', 'R-028-61: inline synchronous refusal.', ['42158c0db8eb59987a9d3e2b0930fb2a4a16a99e8031107fe9324df54ff4ab8f']),
  ...at('src/ops.ts', 'attestBusyText', 'cycle-blocked remedy', 'R-028-64: heldBy has other callers; needs -> ops -> needs.', ['5d2fc112940085e61c49af6a4021b6d42fd2722bbbc9854aeb12059e2c78bc18']),
  ...at('src/ops.ts', 'waive', 'Git commit message', 'Label passed to git.buildMerge.', ['facc0d2660e13d56989bc2e5b4733de416c079e3bd4bfd48e3f21c87e778becd']),
  ...at('src/ops.ts', 'rebaseInternal', 'cycle-blocked remedy', 'R-028-64: async mutation and shared ops helpers; needs -> ops -> needs.', ['1954eba7fa5f51bda9d844705cdd19a12838dd376a4a1da2e5544641dda75fe3']),
  ...at('src/ops.ts', 'merge', 'Git commit message', 'Label passed to git.buildMerge.', ['facc0d2660e13d56989bc2e5b4733de416c079e3bd4bfd48e3f21c87e778becd']),
  ...at('src/ops.ts', 'merge', 'operation refusal', 'R-028-61: inline synchronous refusal and its immediate reasons.', ['42158c0db8eb59987a9d3e2b0930fb2a4a16a99e8031107fe9324df54ff4ab8f', '337a84a26b8a8a4de2cec88abdd008a4ac6022e8c9a408d934c7594ae66b288c']),
  ...at('src/ops.ts', 'batchMembers', 'operation refusal', 'R-028-61: inline synchronous refusal.', ['826d034073e8752464d8380849de83a0168c336aa7cdb55dd4bb1f997e452ec4']),
  ...at('src/ops.ts', 'incompleteBatchText', 'comment', 'Source commentary only.', ['b310be1b7eb094d92e39fbbb986f2d1252e095cfb4eb20e2fa78cff7b28ffe75']),
  ...at('src/ops.ts', 'mergeBatch', 'comment', 'Source commentary only.', ['9056b9d168d84a03554e9095e674b530561546e1ccc4c0a9bcbe839624a93080']),
  ...at('src/ops.ts', 'mergeBatch', 'operation refusal', 'R-028-61: inline synchronous refusal.', ['246ea921e61f0f179ab2a2e143e3c5c21ee59d87de8acd95064ad51761c04c42', 'f8396a290676343d397b9eaa50368d95558f3df082ba1c773abcb703534c0808', '41a6b77ca15da343ccd22450b0748d0eee902efb29d89e384986a662acede80c']),
  ...at('src/ops.ts', 'mergeBatch', 'Git commit message', 'Label passed to git.buildMerge.', ['92f00d137a23d42abfffbe0e748f9723d1e1882126925a32544b61e99b8d3ea4']),
  ...at('src/ops.ts', 'mergeTreeBreakLead', 'cycle-blocked remedy', 'R-028-64: shared op renderer and helpers; needs -> ops -> needs.', ['429ca3c5828338d0d188a3379919699fb9b3d79ea8bd5dd43a516341facb7540']),
  ...at('src/ops.ts', 'adoptable', 'operation refusal', 'R-028-61: inline synchronous refusal.', ['e4551df6561953dc12e62e0fe55f9d9d230ad8431435475647af8f6b03149f70', '0c2322262f544cc8d0436580d6e58527424e249a3ef9b436de633a6f7645eb97', '7c410a7b81e3ae587c0bc032e05a14b430ff80c2a276f2fb99bcdb9eb23af0a2']),
  ...at('src/ops.ts', 'adoptHeld', 'operation refusal', 'R-028-61: inline synchronous refusal.', ['7ac14789a9f34bf0138366fe03ff62ab1cd3edc2487ddbb1e028e561c504ae48', '7bd2e5cbe8e22be3213af19c76c7083b6a325be1f10299dcc34a70c910336a22', 'f3d8f1ad98f39fab724faf9ee5df70329fa06c79961ed286920a5ad5fbd2aaa6']),
  ...at('src/ops.ts', 'summaryStatusView', 'Git commit message', 'Label passed to git.buildMerge.', ['76099f6ae0ce17c59dbc77ace6b3cebbc560c9d7f09eabc8fd615c84ac887ff8']),
  ...at('src/ops.ts', 'summaryStatusView', 'Git-derived status addition', 'R-028-18: Git-derived additions after pure needs.', ['50780412d51b6639b266f7a627a3ef5be3f2088d21486ac99a0ea9b4ad2fd4cf', '3cf40da278c8325fee04c92bbaf295b909da7c0e54f6704996ebde62e613a307', 'e249fbc7ea16826d08de195d4bc6698655dff2294662bef37d040bced7d886d3']),
  ...at('src/ops.ts', 'currentTrunkRedChecks', 'Git commit message', 'Label passed to git.buildMerge.', ['76099f6ae0ce17c59dbc77ace6b3cebbc560c9d7f09eabc8fd615c84ac887ff8']),
  ...at('src/ops.ts', 'hintedMergeChecks', 'Git commit message', 'Label passed to git.buildMerge.', ['76099f6ae0ce17c59dbc77ace6b3cebbc560c9d7f09eabc8fd615c84ac887ff8']),
  ...at('src/ops.ts', 'reportCounterfactual', 'help/usage', 'R-028-61: pre-State initialization guidance.', ['4160635a8fc5a73bc449efcbb8864468e0d2a9301e3a9242ca7629345759878b']),
  ...at('src/plan.ts', 'checklessWarnings', 'comment', 'Source commentary only.', ['33404493d488e042a98fbf1e81c99d44a8c448bccb52effd07b95a053ca2db79']),
  ...at('src/plan.ts', 'loopWarnings', 'comment', 'Source commentary only.', ['ab66d69082bd57385de65da8b0682ae9f390b52634120f79fb45cb2c587b27b0']),
  ...at('src/plan.ts', '<module>', 'comment', 'Source commentary only.', ['5bb2f96a05a2543948096f954f24bcbed8c575939a332b0a30f120dc24f12415']),
  ...at('src/planlint.ts', 'lintPlanCost', 'diagnostic example', 'Cost report inspection hint.', ['a437bf5801294cf68bda53b0d74624c6629801a8dffa1baf28ca92c0d9c02c24']),
  ...at('src/reducer.ts', 'flakyBlockText', 'cycle-blocked remedy', 'R-028-64: reducer -> needs -> reducer.', ['3d5b70a0b9d0484b89dd9c83b5954d7cd751c4825bef719750a5b90d0e7891ec']),
  ...at('src/reducer.ts', 'item', 'cycle-blocked remedy', 'R-028-64: reducer -> needs -> reducer.', ['52415c8e74448af73934554df2d810b0123697fe4a25cff647980424a8fa6757']),
  ...at('src/reducer.ts', 'trunkParkNotices', 'cycle-blocked remedy', 'R-028-64: reducer -> needs -> reducer.', ['cc207ffefbf88b7e6e20471b015cde8b489193e28b070facf009069495492104', 'b350a769d70d5e7b44b475aaf903d309980cf31f401d69a59ea72418946a39f3']),
  ...at('src/reducer.ts', 'sharedParkNotices', 'cycle-blocked remedy', 'R-028-64: reducer -> needs -> reducer.', ['408824777e57ad2db7078f2f04a8b2af79ac839531e67a8dcb21e4fadf293916']),
  ...at('src/reducer.ts', 'projectId', 'help/usage', 'R-028-61: pre-State initialization guidance.', ['4160635a8fc5a73bc449efcbb8864468e0d2a9301e3a9242ca7629345759878b']),
  ...at('src/reducer.ts', 'validateDraft', 'operation refusal', 'Existing synchronous draft-validation refusal.', ['0e93f2e94ecbd6b3c4dcafe5fda983f4b06fbf3934c521fea2335a9531a31f6e', 'd68065af0b2a6a21800b6a80fb14473f389e0083643be2bb6aeaeb6331135493']),
  ...at('src/reducer.ts', 'invariantRedText', 'cycle-blocked remedy', 'R-028-64: reducer -> needs -> reducer.', ['2a2778497f5896a958a4c17b6e826fc447f8be9a31044fd043980221e11a63c1']),
  ...at('src/sweep.ts', 'sweep', 'help/usage', 'R-028-61: pre-State initialization guidance.', ['4160635a8fc5a73bc449efcbb8864468e0d2a9301e3a9242ca7629345759878b']),
  ...at('src/sweep.ts', 'sweep', 'historical text', 'Observed first-parent merge range and bisect results, not commands.', ['b1564406f11eb07e941b79aedb0a96ac134b17b33dd5815a961027bba9110800', '385a3e0e7967d08d136dcdc00f70d02d385ddbff0a243bfd97b83b89ed46f2b1']),
  ...at('src/types.ts', '<module>', 'comment', 'Source commentary only.', ['27e2c5013cbdc09194793d1039c8a2a071b543ac277ca75d097010442b39e991']),
  ...at('src/views.ts', '<module>', 'comment', 'Source commentary only.', ['14132f53ac25fc205d2b903d8670b138704a2a3907cd94fb6bd1867f9c81e4d7', 'f25652220050254c068908574aa280983b96597b67de648289154ce010e6765b', '1575d195e88247207c30bde56d94e09b3e5ee31b392c4b2111c59827a144bdb0', '6dc53361814cf9742b29ded434973c4c3cd24bc723728dc68da7b88941e89bae', '47be29b393412f2bf1ec00d393aecbcae738087e86ad400e78e305c76e0f72f2']),
  ...at('src/views.ts', 'driftText', 'cycle-blocked remedy', 'R-028-64: plural has other callers; needs -> views -> needs.', ['b1af6e4186502b80d89081659edda15fa071a53a455ec05a8e262d4eae73aa8f', '0324fb8156b0747fdbf3d7503f51144047e819dfa6471c560ef7233f31f74421', '4b0c4ad4710fd43cc7abde14066f7d678aa70803e1e3c96b539ee8877d536fe8']),
  ...at('src/views.ts', 'waiverText', 'historical text', 'Recorded waiver/evidence scope explanation, not need selection.', ['e5221fb1530361d77e6bcaa02d2ad2d06d4f5ddd6a2c509e608cb363bbb4672f', 'e24a9c1e92405be39a2524f9824d272a9fd9bb620ee1265b0a83ca10bc7c062a']),
  ...at('src/views.ts', 'acceptedText', 'historical text', 'Recorded merge-key waiver scope explanation.', ['54d50838f9ab309b68dbe88482387f6101d87b5d606b2c6112dc067c38b40dc2']),
  ...at('src/views.ts', 'renderWhy', 'comment', 'Source commentary only.', ['5cf9c49964defe61b5342aac89d7f4569c23868ce6b81027971eb0d4ea618ba3']),
  ...at('src/views.ts', 'renderWhy', 'diagnostic example', 'Merge-check details and full evidence inspection links.', ['498049138987a30964b44d9c9753a9ada70c5d089da20ea0a4975be50f30ba4c', 'a6fc857e4b502b2d8b25669598ed5d493ae481f126f45b5a658cf897f767cc0f']),
  ...at('src/views.ts', 'conflictLines', 'diagnostic example', 'Unknown Git probe inspection retry.', ['44c68684423bcef33a1d14cfa42c61260a1b38596401fafa57ce771101594ba0']),
  ...at('src/views.ts', 'renderStatus', 'diagnostic example', 'Full status and evidence inspection links.', ['ed588000c85568aba90bb6ad276c5f04a9d16898d987ce33ab4e893fd90cc077']),
  ...at('src/views.ts', 'renderStatusBrief', 'diagnostic example', 'Status and evidence inspection links.', ['8aa7ee117f262e26f7eb380f031c63ce7af7329201c3adf29ea15880a80bfe0d']),
  ...at('src/views.ts', 'housekeepingText', 'Git-derived status addition', 'GC1: housekeeping hint (contract 0.29).', ['8a2ccacc707ae5b3a6c7349c51bbfa0b83550b250368e35c0b3355e022ce9eb0']),
  ...at('src/views.ts', 'renderGc', 'comment', 'Source commentary only.', ['17e3d1051e45e75be1fff0d533fb0d4463e0030bce209ff72bd8769c6c5e6a90']),
  ...at('src/views.ts', 'reusedHint', 'diagnostic example', 'R-028-41/44/64: merge-failure diagnostic only.', ['fff5994c96094b2d21bfe525cb52d38f53536353edd30308970a87b7ea2b9b5a', 'a8d60ce20e2d297f7306ca9dbd6304603db7d4fdd34a0176d937cc5664caae4c']),
  ...at('src/views.ts', 'mergeFailureHints', 'diagnostic example', 'R-028-41/44/64: merge-failure diagnostic only.', ['de125e105acd6f1dbd650f0d1c0204d372d06ef71b2a45e1bd123478bc6986d3']),
  ...at('src/views.ts', 'dispatchPacket', 'comment', 'Source commentary only.', ['ba1b9b6f5230acf988a07db0ac58f6a8ceabdf5a932dc53442ed27282d46dc12']),
  ...at('src/views.ts', 'DRIVER_ATTESTS', 'help/usage', 'R-028-61: agent instructions.', ['8c61e8b5c785d82102d490c803366bb141df0e45519845bdbee458408f9fa45f']),
  ...at('src/views.ts', 'SKIP_ATTEST', 'help/usage', 'R-028-61: agent instructions.', ['25b57acb6916d2f3b485cf3cfe8e9ee19fbf0491f695fab42baf7982f65b4f3c']),
  ...at('src/views.ts', 'dispatchLines', 'help/usage', 'R-028-61: agent instructions.', ['a8bedf8baf8b8170d224fd5bacb5de1e839a0fe0d98c316cee69533e7cc5cf92']),
  ...at('src/views.ts', 'manualRequired', 'comment', 'Source commentary only.', ['5f61a2773f1a127f84ef667fae63280200b37c55b2bb2efb249685a8065ca28b']),
  ...at('src/views.ts', 'manualRequired', 'help/usage', 'R-028-61: reviewer instruction for owner approval.', ['a0c867c6f50ee3af113370859ca4da49357bf8f8cbe180c551f53dd94638f7ae']),
  ...at('src/views.ts', 'reviewPacket', 'help/usage', 'R-028-61: reviewer packet instructions.', ['20fecaa21601b23763a00b9bf64a2391bf0d7ad1d00e85a19aaac996e57a181f', '864338e012ea04b6a949c5257ab11bb72947e28db1727a36fe21a4d4dd18e25a', '6b7d54343413e30590505ae465af2d08a287eb9a3b212dff4cb2716c527573db']),
  ...at('src/watchdog.ts', 'idleText', 'diagnostic example', 'Status inspection link.', ['7b375814245c132deec2db71421a80f9a4fcb3113860c2a294d18814078d13e4']),
  ...at('src/watchdog.ts', 'idleNodes', 'diagnostic example', 'Inspection fallback when no authoritative command exists.', ['cb6c82dba45d7a04f8958f2b00327d9271f160ec538aad579c690f8d3bb3a982', 'e680fab4fca2fc3e0cae49f470e8798e5129dc2ab4717bd61f5dda46a23df2bb']),
  ...at('src/watchdog.ts', 'idle', 'help/usage', 'R-028-61: pre-State initialization guidance.', ['80c5cc33f3a2f8a211bab192fd00863512a4d349fe9b165f747e0a2580e0ae95', '377f94e990ed720ba3812a12de65007618dbc715873e7fc04fb8cb40be80af0d']),
];
function unregistered(sites: Site[], entries = registered): Site[] {
  const remaining = entries.map(([file, fn, kind, reason, literal]) => {
    assert.ok(kind && reason.trim(), `${file}/${fn}: each exception needs a class and reason`);
    return JSON.stringify([file, fn, literal, kind === 'comment']);
  });
  return sites.filter(site => {
    if (site.file === 'src/needs.ts') return false;
    const at = remaining.indexOf(JSON.stringify([site.file, site.fn, digest(site.literal), site.comment]));
    if (at < 0) return true;
    remaining.splice(at, 1);
    return false;
  });
}
async function sources(dir: string): Promise<Site[]> {
  const sites: Site[] = [];
  for (const entry of await readdir(resolve(dir), { withFileTypes: true })) {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) sites.push(...await sources(file));
    else if (entry.name.endsWith('.ts')) sites.push(...inventory(file, await readFile(resolve(file), 'utf8')));
  }
  return sites;
}
test('PR2: every resolving-command literal outside needs.ts has an exact classified site', async () => {
  const unknown = unregistered(await sources('src'));
  assert.deepEqual(unknown, [], `Unregistered owed command sites:\n${JSON.stringify(unknown, null, 2)}`);
});
test('PR2: negative fixtures reject new remedies even in registered functions, double quotes and embedded templates', () => {
  for (const source of [
    'export const remedy = (node: string) => `owed resume ${node}`;',
    'export function remedy() { return "owed resume a"; }',
    'export function remedy(node: string) { return `${node}: fix → owed decide ${node} --text "<ruling>"`; }',
    'export function remedy(node: string) { return `${node}: ${true ? "owed resume a" : "wait"}`; }',
    'export function remedy(act: string) { return `owed ${act} a`; }',
    'export function remedy() { return "\\x6fwed resume a"; }',
  ]) {
    const sites = inventory('src/views.ts', source);
    assert.ok(sites.length, source);
    assert.equal(unregistered(sites).length, sites.length, source);
    assert.equal(unregistered(sites.map(s => ({ ...s, file: 'src/needs.ts' }))).length, 0, source);
    const first = sites[0]!;
    const exact: Registered[] = [[first.file, first.fn, 'diagnostic example', 'Only this exact frozen diagnostic is registered.', digest(first.literal)]];
    assert.equal(unregistered([first, first], exact).length, 1, 'a copied site is not implicitly authorized');
    const registeredFunction = registered.find(([file, , kind]) => file === 'src/views.ts' && kind !== 'comment')![1];
    assert.equal(unregistered(sites.map(s => ({ ...s, fn: registeredFunction }))).length, sites.length, 'registration of a function does not authorize a new literal');
  }
});
const foldedRemedies: Record<string, string[]> = {
  'constant template spans': [
    '`${"owed"} resume ${node}`',
    '`${(("owed"))} resume ${node}`',
    '`${((`owed`))} resume ${node}`',
    '`${"ow"}${"ed"} resume ${node}`',
  ],
  'split concatenations': [
    '"ow" + "ed resume " + node',
    '"ow" + ("ed " + "resume ") + node',
    "'ow' + 'ed resume ' + node",
    '("owed ") + verb',
    'node + ("owed " + verb)',
    '"owed " + "re" + "sume " + node',
    '"ow" + "ed " + verb',
  ],
};
for (const [kind, expressions] of Object.entries(foldedRemedies)) test(`PR2/R-028-68: ${kind} cannot hide a remedy`, () => {
  for (const expression of expressions) {
    const source = `export function remedy(node: string, verb: string) { return ${expression}; }`;
    const sites = inventory('src/views.ts', source);
    assert.deepEqual(sites, [{ file: 'src/views.ts', fn: 'remedy', literal: expression, comment: false }], source);
    assert.deepEqual(unregistered(sites), sites, source);
    assert.deepEqual(unregistered(sites.map(s => ({ ...s, file: 'src/needs.ts' }))), [], source);
    const exact: Registered[] = [['src/views.ts', 'remedy', 'diagnostic example', 'Only this raw expression is registered.', digest(expression)]];
    assert.deepEqual(unregistered(sites, exact), [], 'the digest still names raw source, not folded text');
    assert.equal(unregistered([...sites, ...sites], exact).length, 1, 'a copied folded site is not authorized');
  }
});
test('PR2/R-028-68: concatenation keeps existing literal sites and ignores chains without literals', () => {
  for (const expression of ['"owed resume " + node', '"prefix" + ("owed resume " + node)', '("owed resume ") + node']) {
    const sites = inventory('src/views.ts', `export function remedy(node: string) { return ${expression}; }`);
    assert.deepEqual(sites.map(s => s.literal), ['"owed resume "'], expression);
  }
  for (const expression of ['node + verb', '1 + 2', '"hello " + node', 'prefix + ["ow", "ed"].join("")']) {
    assert.deepEqual(inventory('src/views.ts', `export function text() { return ${expression}; }`), [], expression);
  }
});
