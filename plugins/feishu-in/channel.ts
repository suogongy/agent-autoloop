// Feishu inbound: turns private chats to the bot and messages in watched group chats into hub events, so a text in a
// private chat is a request and an alert push is an alert. Emission goes over the same local HTTP as any outside
// source — the hub never learns Feishu's name, and dedupes by source id, so resends and restarts stay safe. This
// plugin never delivers cards; it polls the hub once a minute only so presence stays online, and reports any
// misrouted card failed so it never piles up.
//   "feishu-in": { "key": "…", "lark": "<lark-cli 绝对路径或租户 wrapper>",
//                  "url": "http://127.0.0.1:3350", "sourceKey": "<feishu-in 来源密钥>",
//                  "users": ["ou_名单内的人"], "alerts": ["oc_告警群chat_id"],
//                  "whitelist": "<白名单json绝对路径>", "discover": true } in config.json
// A private chat only becomes a request when its sender is in `users`; with no list nothing is taken, so configuring
// the plugin never opens the door to the whole tenant. `/new` from a listed user is no event: it bumps that user's
// epoch in $AGENT_AUTOLOOP_HOME/feishu-in-epochs.json, so the next words carry a fresh subject — a fresh matter, and
// with `resume` on the rule, a fresh session. The whitelist file is a JSON array of strings; an alert whose text
// contains any entry is dropped. It is re-read on every alert, so editing it takes effect at once without a restart.
// A missing or broken file filters nothing.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChannelContext } from "../../host/channels.ts";
import { eachLine } from "../../host/lines.ts";
import { commandLine } from "../../host/command.ts";

/** Feishu sends some values as JSON in a string, which may be empty. */
function safeJson(text: unknown): any {
  if (typeof text !== "string" || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Pulls the message out of whatever shape this lark-cli version streams. */
function messageOf(raw: any): { chatId: string; messageId: string; chatType: string; text: string } | null {
  const event = raw?.event?.message ?? raw?.message ?? raw?.event ?? raw;
  const chatId = event?.chat_id ?? raw?.chat_id;
  const messageId = event?.message_id ?? raw?.message_id;
  if (typeof chatId !== "string" || typeof messageId !== "string") return null;
  const chatType = event?.chat_type ?? raw?.chat_type ?? "";
  const content = event?.content ?? raw?.content;
  const message = safeJson(content);
  const text = typeof message?.text === "string" ? message.text : typeof content === "string" ? content : "";
  return { chatId, messageId, chatType, text: text.trim() };
}

/** The sender's open id, again from whatever shape this version streams. A miss means "not on the list". */
function senderOf(raw: any): string | null {
  const sender = raw?.event?.sender ?? raw?.sender;
  const id = sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? sender?.open_id ?? sender?.id;
  return typeof id === "string" && id ? id : typeof sender === "string" && sender ? sender : null;
}

/** A wait that a stop cuts short, so shutdown doesn't linger in a sleep. */
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export default async function feishuIn({ hub, options, log, signal }: ChannelContext) {
  const program = (options.lark as string | undefined) ?? "lark-cli";
  const hubUrl = String(options.url ?? "").replace(/\/$/, "");
  const sourceKey = options.sourceKey as string | undefined;
  const users = Array.isArray(options.users)
    ? (options.users as unknown[]).filter((u): u is string => typeof u === "string")
    : [];
  const alerts = Array.isArray(options.alerts)
    ? (options.alerts as unknown[]).filter((id): id is string => typeof id === "string")
    : [];
  const discover = options.discover === true;
  if (!hubUrl || !sourceKey) throw new Error("feishu-in 通道要在 config.json 写 url 和 sourceKey（来源密钥）");
  const epochsFile = join(process.env.AGENT_AUTOLOOP_HOME || ".", "feishu-in-epochs.json");

  /** One matter per user until they say `/new`: the epoch rides in the subject, so it also survives a restart. */
  const epochs = (): Record<string, number> => {
    try {
      const parsed = JSON.parse(readFileSync(epochsFile, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };
  const subjectOf = (sender: string) => {
    const epoch = epochs()[sender] ?? 1;
    return epoch === 1 ? sender : `${sender}-${epoch}`;
  };

  const emit = async (body: Record<string, unknown>) => {
    const reply = await fetch(`${hubUrl}/v1/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sourceKey}` },
      body: JSON.stringify(body),
      signal,
    });
    if (!reply.ok) throw new Error(`发事件没成：${reply.status} ${await reply.text().catch(() => "")}`.slice(0, 300));
    return (await reply.json()) as { event: number; duplicate: boolean };
  };

  const whitelistOf = (): string[] => {
    const file = options.whitelist;
    if (typeof file !== "string" || !existsSync(file)) return [];
    try {
      const listed = JSON.parse(readFileSync(file, "utf8"));
      return Array.isArray(listed) ? listed.filter((word): word is string => typeof word === "string") : [];
    } catch (error) {
      // A broken filter must not silently swallow alerts: say so and pass everything through.
      log(`whitelist ${file} 读不了（${error}），本次不过滤`);
      return [];
    }
  };

  const handle = async (line: string) => {
    let raw: any;
    try {
      raw = JSON.parse(line);
    } catch {
      log(`读不懂一行（${line.slice(0, 120)}）`);
      return;
    }
    const message = messageOf(raw);
    if (!message) {
      if (discover) log(`discover：${line.slice(0, 300)}`);
      return;
    }
    const { chatId, messageId, chatType, text } = message;
    // Requests come from listed users' private chats; alerts only from watched groups.
    if (chatType === "p2p") {
      if (!text) return;
      if (!users.length) {
        log(`config 的 users 没配名单，私聊一律不收（要收就写 users: ["ou_…"]）：${text.slice(0, 60)}`);
        return;
      }
      const sender = senderOf(raw);
      if (!sender || !users.includes(sender)) {
        log(`私聊来自${sender ? `不在名单的 ${sender}` : "认不出发送者"}，没收：${text.slice(0, 60)}`);
        return;
      }
      if (text === "/new") {
        const next = (epochs()[sender] ?? 1) + 1;
        try {
          writeFileSync(epochsFile, JSON.stringify({ ...epochs(), [sender]: next }));
        } catch (error) {
          log(`写 ${epochsFile} 没成（${error}），本次轮换重启后不记得`);
        }
        log(`${sender} 开新会话：下一条消息的 subject 是 ${next === 1 ? sender : `${sender}-${next}`}`);
        return;
      }
      const made = await emit({
        id: `req-${messageId}`,
        type: "request.new",
        subject: subjectOf(sender),
        summary: text.slice(0, 200),
        detail: text.slice(0, 4000),
      });
      log(
        `私聊消息 → 事件 ${made.event}${made.duplicate ? "（重复，已略）" : ""}（subject ${subjectOf(sender)}）：${text.slice(0, 60)}`,
      );
    } else if (alerts.includes(chatId)) {
      if (!text) return;
      if (whitelistOf().some((word) => text.toLowerCase().includes(word.toLowerCase()))) {
        log(`告警命中白名单，不派：${text.slice(0, 80)}`);
        return;
      }
      const made = await emit({
        id: `alert-${messageId}`,
        type: "alert.report",
        subject: chatId,
        summary: text.slice(0, 200),
        detail: text.slice(0, 4000),
      });
      log(`告警 → 事件 ${made.event}${made.duplicate ? "（重复，已略）" : ""}：${text.slice(0, 60)}`);
    } else if (discover) {
      log(`discover chat_id=${chatId} chat_type=${chatType || "?"}：${text.slice(0, 120) || line.slice(0, 200)}`);
    }
  };

  /** Presence without pulling work: a stray misrouted card is reported failed so it never waits on this channel. */
  const heartbeat = async () => {
    while (!signal.aborted) {
      try {
        const { card } = await hub.nextCard(1);
        if (card) await hub.failed(card.id, card.version, "feishu-in 只收消息不投卡片");
      } catch (error) {
        log(`连不上中台：${error}`);
      }
      await sleep(60_000, signal);
    }
  };

  const listen = async () => {
    while (!signal.aborted) {
      const consume = spawn(...commandLine([program, "event", "consume", "im.message.receive_v1", "--as", "bot"]), {
        stdio: ["pipe", "pipe", "pipe"],
      });
      consume.on("error", (error) => log(`收消息进程跑不起来：${error}`));
      const stop = () => consume.kill();
      signal.addEventListener("abort", stop);
      eachLine(consume.stderr!, log);
      eachLine(consume.stdout!, (line) => void handle(line).catch((error) => log(`消息没处理成：${error}`)));
      await new Promise((resolve) => consume.on("close", resolve));
      signal.removeEventListener("abort", stop);
      if (!signal.aborted) {
        log("收消息进程停了；10 秒后再起（后台没订阅 im.message.receive_v1 时会一直这样）");
        await sleep(10_000, signal);
      }
    }
  };

  await Promise.all([heartbeat(), listen()]);
}
