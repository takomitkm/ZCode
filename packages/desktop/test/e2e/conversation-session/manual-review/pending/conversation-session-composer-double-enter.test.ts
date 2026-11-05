// CST06/CST08：提交进行中第二次 Enter 的防残留回归（manual-review/pending）。
//
// 背景：普通发送路径在受理后不清空编辑器，要等发送链结算；期间 submitDisabled=true，
// LexicalChatInput 的 KEY_ENTER_COMMAND 处理链把 Enter 退回给 Lexical 默认行为（插换行），
// 该换行会把 contentRevision 顶过结算门禁的 cleanupRevision，导致「消息已发出但
// 正文+换行残留输入框」（详见 packages/ui/src/LexicalChatInput.tsx 主链注释与
// ConversationComposer.settleSubmittedContent 的 revision 门禁）。
//
// 确定性：复用 composer-settlement 用例的 MessagePort 探针，把真实 sendText 命令
// 暂扣在本地，使「pending 渲染完成之后、结算之前」的竞态窗口变成可稳定进入的状态，
// 再按第二次物理 Enter；不依赖毫秒级时间窗，也不伪造回执（unknown/accepted 全部由
// Host/CLI fixture 真实产生）。
//
// 预期（修复后）：第二次 Enter 被吞掉——不重复发送、不插换行；结算后编辑器为空。
// 旧行为（无补丁）：结算被 revision 门禁跳过，最终正文=已发送正文+换行 → 本用例红。
// 探针代码与 conversation-session-composer-settlement.test.ts 同源（case-local 约定）。
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  setV4ComposerText,
  waitForV4ComposerText,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

interface ComposerProbe {
  commands: Array<{ commandId: string; sessionId: string }>;
  unknown: string[];
  accepted: string[];
  enters: number;
  frames: Array<{ text: string; placeholder: string | null; sameEditor: boolean }>;
  release(): void;
  restore(): void;
}
declare global {
  interface Window {
    __composerDoubleEnterProbe?: ComposerProbe;
  }
}
const input = '[data-testid="v4-composer-input"]';
const evidence: unknown[] = [];

async function installProbe(hold: boolean) {
  await browser.execute(
    (hold, selector) => {
      const original = MessagePort.prototype.postMessage;
      const held: Array<() => void> = [];
      const listeners = new Map<MessagePort, (event: MessageEvent) => void>();
      const firstEditor = document.querySelector(selector);
      let submitted = false;
      let last = "";
      const decode = (data: unknown) => {
        const bytes =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : ArrayBuffer.isView(data)
              ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
              : null;
        return bytes ? new TextDecoder().decode(bytes) : "";
      };
      const probe: ComposerProbe = {
        commands: [],
        unknown: [],
        accepted: [],
        enters: 0,
        frames: [],
        release() {
          hold = false;
          held.splice(0).forEach((send) => send());
        },
        restore() {
          probe.release();
          observer.disconnect();
          for (const [port, listener] of listeners) port.removeEventListener("message", listener);
          MessagePort.prototype.postMessage = original;
          document.removeEventListener("keydown", onKey, true);
          delete window.__composerDoubleEnterProbe;
        },
      };
      const onKey = (event: KeyboardEvent) => {
        if (event.key === "Enter" && (event.target as Element)?.matches(selector)) {
          submitted = true;
          probe.enters++;
        }
      };
      document.addEventListener("keydown", onKey, true);
      const observer = new MutationObserver(() => {
        if (!submitted) return;
        const editor = document.querySelector<HTMLElement>(selector);
        if (!editor) return;
        const sample = {
          text: editor.innerText,
          placeholder:
            editor.parentElement?.querySelector<HTMLElement>('[aria-hidden="true"]')?.innerText ??
            null,
          sameEditor: editor === firstEditor,
        };
        const signature = JSON.stringify(sample);
        if (signature !== last) {
          last = signature;
          probe.frames.push(sample);
        }
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      // 只改变真实命令与查询的先后顺序；回执和投影全部由 Host/CLI 产生。
      MessagePort.prototype.postMessage = function (
        ...args: [unknown, (Transferable[] | StructuredSerializeOptions)?]
      ) {
        if (!listeners.has(this)) {
          const listener = (event: MessageEvent) => {
            const wire = decode(event.data);
            for (const command of probe.commands) {
              if (!wire.includes(command.commandId)) continue;
              if (wire.includes('"result":"unknown"')) probe.unknown.push(command.commandId);
              if (wire.includes('"status":"accepted"')) probe.accepted.push(command.commandId);
            }
          };
          listeners.set(this, listener);
          this.addEventListener("message", listener);
        }
        const wire = decode(args[0]);
        const forward = () => Reflect.apply(original, this, args);
        if (wire.includes("sendConversationCommandV4") && wire.includes('"type":"sendText"')) {
          const commandId = wire.match(/"commandId":"([^"]+)"/)?.[1];
          const sessionId = wire.match(/"sessionId":"([^"]+)"/)?.[1];
          if (!commandId || !sessionId) throw new Error("真实发送缺少命令或会话身份");
          probe.commands.push({ commandId, sessionId });
          if (hold) {
            held.push(forward);
            return;
          }
        }
        forward();
      };
      window.__composerDoubleEnterProbe = probe;
    },
    hold,
    input,
  );
}
async function probe() {
  return browser.execute(() => {
    const value = window.__composerDoubleEnterProbe!;
    return {
      commands: value.commands,
      unknown: value.unknown,
      accepted: value.accepted,
      enters: value.enters,
      frames: value.frames,
    };
  });
}
async function pressEnter() {
  await $(input).click();
  await browser.keys("Enter");
}
async function getComposerText() {
  return browser.execute(
    (selector) => document.querySelector<HTMLElement>(selector)?.innerText ?? "",
    input,
  );
}
/** 传输层在 ACK 未达时会原样重发同一命令；「只提交一次」必须按去重后的 commandId 计数。 */
function distinctCommandIds(result: Awaited<ReturnType<typeof probe>>) {
  return new Set(result.commands.map((command) => command.commandId)).size;
}
/** 暂扣发送后，等 pending 状态真实渲染到 DOM，再进入竞态窗口；不是靠固定毫秒碰运气。 */
async function waitPendingRendered(marker: string) {
  // 前置不变量：受理后、结算前，已发送正文仍在编辑器（方案 A 吞键版与旧行为一致；
  // 若将来引入提交即乐观清空，此前置需同步改为「编辑器为空」口径）。
  await waitForV4ComposerText(marker, "发送受理后正文应仍可见（竞态窗口前置）");
  // React 对 setPending 的重渲染约一帧；给足余量等 submitDisabled 真正生效。
  await browser.pause(500);
}
async function waitComplete() {
  await waitForV4Pane(
    (pane) =>
      pane.sessionId !== "draft" &&
      !pane.canStop &&
      pane.timelineText.includes("composer-settlement-ok"),
    "发送未进入已完成详情",
    45_000,
  );
}

describe("CST Composer 提交进行中的第二次 Enter", () => {
  before(async () => {
    await prepareV4ConversationE2E();
  });
  afterEach(async function () {
    if (await browser.execute(() => Boolean(window.__composerDoubleEnterProbe))) {
      evidence.push({
        case: this.currentTest?.title,
        ...(await probe()),
        pane: await getV4PaneSnapshot(),
      });
      await writeFile(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "composer-double-enter.json"),
        JSON.stringify(evidence, null, 2),
      );
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `composer-double-enter-${evidence.length}.png`),
      );
      await browser.execute(() => window.__composerDoubleEnterProbe?.restore());
    }
  });

  it("CST06 提交进行中第二次 Enter：不重复发送、结算后不残留正文或换行", async function () {
    this.timeout(90_000);
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await installProbe(true);
    const marker = "E2E_COMPOSER_SETTLEMENT_DOUBLE_ENTER_A";
    await setV4ComposerText(marker);
    await pressEnter();
    await browser.waitUntil(async () => (await probe()).commands.length === 1, {
      timeout: 15_000,
      timeoutMsg: "没有截获待释放的首发命令",
    });
    await waitPendingRendered(marker);
    // 第二次物理 Enter：旧行为在此插入换行并顶掉结算清空；修复后被吞掉。
    await pressEnter();
    await browser.execute(() => window.__composerDoubleEnterProbe!.release());
    await waitComplete();
    await waitForV4ComposerText("", "第二次 Enter 不得残留已发送正文或换行");
    const result = await probe();
    expect(result.enters).toBe(2);
    expect(distinctCommandIds(result)).toBe(1);
    expect(new Set(result.accepted).size).toBe(1);
  });

  it("CST08 提交进行中续写新草稿并按 Enter：追加一个换行、B 不误发、旧消息只结算一次", async function () {
    this.timeout(90_000);
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await installProbe(true);
    await setV4ComposerText("E2E_COMPOSER_SETTLEMENT_DRAFT_B_A");
    await pressEnter();
    await browser.waitUntil(async () => (await probe()).commands.length >= 1, {
      timeout: 15_000,
      timeoutMsg: "没有截获待释放的首发命令",
    });
    await waitPendingRendered("E2E_COMPOSER_SETTLEMENT_DRAFT_B_A");
    // 现行契约（方案 A 范围）：pending 中对「新续写的草稿」按 Enter 不提交，
    // 但保留 Lexical 换行语义——B 追加恰好一个换行；不得清空、不得误发 B。
    // 完整改造（忙碌 Enter=queue/steer/no-op）落地时本例需同步收紧为无操作。
    await setV4ComposerText("B draft during pending");
    await pressEnter();
    await browser.execute(() => window.__composerDoubleEnterProbe!.release());
    await waitComplete();
    await browser.waitUntil(
      async () => (await getComposerText()).trim() === "B draft during pending",
      { timeout: 10_000, timeoutMsg: "新草稿不得被清空或丢失" },
    );
    const draftText = await getComposerText();
    expect(draftText.endsWith("\n") && !draftText.endsWith("\n\n")).toBe(true);
    const result = await probe();
    expect(result.enters).toBe(2);
    expect(distinctCommandIds(result)).toBe(1);
    expect(new Set(result.accepted).size).toBe(1);
  });
});
