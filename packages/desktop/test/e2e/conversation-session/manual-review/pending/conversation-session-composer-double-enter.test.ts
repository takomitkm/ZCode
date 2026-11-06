// CST06/CST08：提交进行中第二次 Enter 的防残留回归（manual-review/pending）。
//
// 【完全改造契约】（full-handoff 分支，取代方案A的过渡契约）：
//   1. （本轮先不做）提交受理后立即清空 = 乐观交接；其实现依赖草稿事务 claim，
//      真实 E2E 上 claim 抛错阻塞发送，需单独定位，故本轮保留既有「结算后清空」。
//   2. 本次提交在途（pending）期间，裸 Enter 与 Ctrl/⌘+Enter 一律 no-op——不重复提交、
//      不落成 Lexical 换行（"发送暂不可用"不再被解释成"换行"）；Shift+Enter 与
//      用户自定义换行键照常换行；IME 组合、候选确认不受影响。
//
// 确定性：复用 composer-settlement 用例的 MessagePort 探针，把真实 sendText 命令
// 暂扣在本地，使「pending 渲染完成之后、结算之前」的窗口变成可稳定进入的状态；
// 回执（unknown/accepted）全部由 Host/CLI 真实产生。
//
// 红绿预期：方案A构建（只吞"正文未变"的 Enter）上，CST06 红（受理后正文仍可见）、
// CST08 红（B 被追加换行）；完全改造构建上两例全绿。
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
  wires: string[];
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
        wires: [],
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
        if (probe.wires.length < 40 && !probe.wires.some((w) => w.startsWith(wire.slice(0, 60)))) {
          probe.wires.push(wire.slice(0, 160));
        }
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
      wires: value.wires,
    };
  });
}
async function pressEnter() {
  await $(input).click();
  await browser.keys("Enter");
}
/** 传输层在 ACK 未达时会原样重发同一命令；「只提交一次」必须按去重后的 commandId 计数。 */
function distinctCommandIds(result: Awaited<ReturnType<typeof probe>>) {
  return new Set(result.commands.map((command) => command.commandId)).size;
}
/** 等「受理即清空」落地并完成 pending 重渲染，再按第二次 Enter；固定事件顺序而非毫秒竞速。 */
async function waitPendingWindow(_marker?: string) {
  // 乐观交接契约：提交受理后编辑器立即清空（正文已进冻结快照/提交事务）。
  await waitForV4ComposerText("", "提交受理后编辑器应立即清空（乐观交接契约）");
  // 等 setPending 的重渲染落地（submitDisabled 真正生效）。
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
    await waitPendingWindow(marker);
    // 第二次物理 Enter：pending 中应被 no-op——不重复提交、不插换行。
    await pressEnter();
    await browser.execute(() => window.__composerDoubleEnterProbe!.release());
    await waitComplete();
    await waitForV4ComposerText("", "第二次 Enter 不得残留已发送正文或换行");
    const result = await probe();
    expect(result.enters).toBe(2);
    expect(distinctCommandIds(result)).toBe(1);
    expect(new Set(result.accepted).size).toBe(1);
  });

  it("CST08 提交进行中续写新草稿并按 Enter：不误发、不换行、草稿原样保留（完全改造契约）", async function () {
    this.timeout(90_000);
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await installProbe(true);
    await setV4ComposerText("E2E_COMPOSER_SETTLEMENT_DRAFT_B_A");
    await pressEnter();
    await browser.waitUntil(async () => (await probe()).commands.length >= 1, {
      timeout: 15_000,
      timeoutMsg: "没有截获待释放的首发命令",
    });
    await waitPendingWindow("E2E_COMPOSER_SETTLEMENT_DRAFT_B_A");
    // 完全改造契约：pending 中对「新续写的草稿」按 Enter = no-op——不提交、
    // 不插换行、不清空；B 一字不动，等旧消息结算后仍可由用户自行发送。
    // （方案A过渡契约「追加恰好一个换行」已由完全改造取代。）
    await setV4ComposerText("B draft during pending");
    await pressEnter();
    await browser.execute(() => window.__composerDoubleEnterProbe!.release());
    await waitComplete();
    await waitForV4ComposerText("B draft during pending", "新草稿不得被换行污染、清空或丢失");
    const result = await probe();
    expect(result.enters).toBe(2);
    expect(distinctCommandIds(result)).toBe(1);
    expect(new Set(result.accepted).size).toBe(1);
  });
});
