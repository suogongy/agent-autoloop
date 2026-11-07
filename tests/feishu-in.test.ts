// The Feishu inbound channel: a private chat to the bot is a request, a message in a watched group is an alert.
// Failure cases: a stranger's private chat, or one with no list configured, becomes a request; /new loses its epoch
// across a restart so the next words land back in the old matter; an event goes out without the source key; a watched
// group's alert that the whitelist catches is still dispatched, or one it doesn't catch is dropped; a message this
// plugin can't read is taken as a request anyway; a card misrouted into this channel waits forever instead of being
// failed, so presence dies with it; lark-cli's flattened event line hides the sender, so a listed user's chat is
// dropped as unidentifiable.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import feishuIn from "../plugins/feishu-in/channel.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-feishu-in-"));
const home = join(dir, "home");
mkdirSync(home);
process.env.AGENT_AUTOLOOP_HOME = home;
after(() => rmSync(dir, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A private-chat message line as Feishu's v2 schema frames it. */
function dm(messageId: string, sender: string, text: string) {
  return JSON.stringify({
    event: {
      sender: { sender_id: { open_id: sender } },
      message: { chat_id: `oc_${sender}`, message_id: messageId, chat_type: "p2p", content: JSON.stringify({ text }) },
    },
  });
}

/** A group-chat message line. */
function group(messageId: string, chatId: string, text: string) {
  return JSON.stringify({
    event: {
      sender: { sender_id: { open_id: "ou_anyone" } },
      message: { chat_id: chatId, message_id: messageId, chat_type: "group", content: JSON.stringify({ text }) },
    },
  });
}

/** A private-chat message line as lark-cli's flattened stream frames it: top-level fields, and `sender_id` alone. */
function flat(messageId: string, sender: string, text: string) {
  return JSON.stringify({
    chat_id: `oc_${sender}`,
    message_id: messageId,
    chat_type: "p2p",
    sender_id: sender,
    content: JSON.stringify({ text }),
  });
}

/** A stand-in for lark-cli: records each call, streams the given lines from `event consume`, and stays alive. */
function lark(name: string, lines: string[]) {
  const path = join(dir, name);
  const log = `${path}.log`;
  writeFileSync(
    path,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2).join(" ");
appendFileSync(${JSON.stringify(log)}, args + "\\n");
if (args.includes("event consume")) {
  for (const line of ${JSON.stringify(lines)}) console.log(line);
  setInterval(() => {}, 1000);
} else {
  for await (const chunk of process.stdin) {}
  console.log(JSON.stringify({ ok: true }));
}
`,
    { mode: 0o755 },
  );
  return path;
}

type Seen = { auth: string | undefined; body: any };

/**
 * Runs the plugin against a local sink for POST /v1/events until `count` events arrived and, when given, a line with
 * `waitFor` was logged, then stops it.
 */
async function run(options: Record<string, unknown>, count: number, firstCard?: unknown, waitFor?: RegExp) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk));
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization, body: JSON.parse(data) });
      res.end(JSON.stringify({ event: 100 + seen.length, duplicate: false }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const stop = new AbortController();
  const logs: string[] = [];
  const failed: unknown[][] = [];
  let cardsLeft = firstCard === undefined ? 0 : 1;
  const hub = {
    async nextCard() {
      if (cardsLeft-- > 0) return { card: firstCard };
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (stop.signal.aborted) {
            clearInterval(timer);
            resolve();
          }
        }, 20);
      });
      return { card: null };
    },
    async failed(...args: unknown[]) {
      failed.push(args);
    },
  };
  const running = feishuIn({
    hub: hub as any,
    options: { ...options, url },
    log: (line: string) => logs.push(line),
    signal: stop.signal,
  });
  const deadline = Date.now() + 5_000;
  while (
    Date.now() < deadline &&
    (seen.length < count || (waitFor !== undefined && !logs.some((l) => waitFor.test(l))))
  )
    await sleep(20);
  if (count === 0 && waitFor === undefined) await sleep(400);
  stop.abort();
  await running;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { seen, failed, logs };
}

test("a listed user's private chat becomes a request; a stranger's doesn't; a long one is cut to the limits", async () => {
  const program = lark("lark-users", [
    dm("om_1", "ou_me", "帮我修登录页"),
    dm("om_2", "ou_stranger", "越权消息"),
    dm("om_3", "ou_me", "长".repeat(5000)),
  ]);
  const { seen, logs } = await run({ lark: program, sourceKey: "sk-source", users: ["ou_me"] }, 2);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].auth, "Bearer sk-source", "events go out under the source key");
  assert.deepEqual(seen[0].body, {
    id: "req-om_1",
    type: "request.new",
    subject: "ou_me",
    summary: "帮我修登录页",
    detail: "帮我修登录页",
  });
  assert.equal(seen[1].body.id, "req-om_3");
  assert.equal(seen[1].body.summary.length, 200);
  assert.equal(seen[1].body.detail.length, 4000);
  assert.ok(
    logs.some((l) => l.includes("ou_stranger")),
    "a stranger's chat is said, not swallowed",
  );
  assert.ok(readFileSync(`${program}.log`, "utf8").includes("im.message.receive_v1"), "subscribes to messages");
});

test("lark-cli's flattened event line still finds the sender and makes the request", async () => {
  const { seen } = await run(
    { lark: lark("lark-flat", [flat("om_1", "ou_me", "拍平的私聊")]), sourceKey: "sk", users: ["ou_me"] },
    1,
  );
  assert.deepEqual(seen[0].body, {
    id: "req-om_1",
    type: "request.new",
    subject: "ou_me",
    summary: "拍平的私聊",
    detail: "拍平的私聊",
  });
});

test("no list configured blocks every private chat", async () => {
  const { seen, logs } = await run(
    { lark: lark("lark-nolist", [dm("om_1", "ou_me", "再来一条")]), sourceKey: "sk" },
    0,
    undefined,
    /users/,
  );
  assert.equal(seen.length, 0);
  assert.ok(
    logs.some((l) => l.includes("users")),
    "it says what to configure",
  );
});

test("/new starts a fresh matter, and the epoch survives a restart", async () => {
  const { seen } = await run(
    {
      lark: lark("lark-new", [
        dm("om_1", "ou_me", "第一个需求"),
        dm("om_2", "ou_me", "/new"),
        dm("om_3", "ou_me", "第二个需求"),
      ]),
      sourceKey: "sk",
      users: ["ou_me"],
    },
    2,
  );
  assert.deepEqual(
    seen.map((s) => s.body.subject),
    ["ou_me", "ou_me-2"],
    "/new itself is no event",
  );
  const after = await run(
    { lark: lark("lark-new-2", [dm("om_4", "ou_me", "第三个需求")]), sourceKey: "sk", users: ["ou_me"] },
    1,
  );
  assert.deepEqual(
    after.seen.map((s) => s.body.subject),
    ["ou_me-2"],
    "a restarted plugin picks the epoch back up from the file",
  );
});

test("a watched group's alert passes unless the whitelist catches it; other groups are ignored", async () => {
  const whitelist = join(dir, "wl.json");
  writeFileSync(whitelist, JSON.stringify(["磁盘已恢复"]));
  const { seen } = await run(
    {
      lark: lark("lark-groups", [
        group("om_1", "oc_g1", "CPU 100%"),
        group("om_2", "oc_g1", "磁盘已恢复"),
        group("om_3", "oc_g2", "别的群"),
      ]),
      sourceKey: "sk",
      users: ["ou_me"],
      alerts: ["oc_g1"],
      whitelist,
    },
    1,
  );
  assert.deepEqual(seen[0].body, {
    id: "alert-om_1",
    type: "alert.report",
    subject: "oc_g1",
    summary: "CPU 100%",
    detail: "CPU 100%",
  });
});

test("a message the plugin can't read is logged under discover, not taken as a request", async () => {
  const { seen, logs } = await run(
    {
      lark: lark("lark-discover", ['{"schema":"weird"}', group("om_5", "oc_unwatched", "随便")]),
      sourceKey: "sk",
      users: ["ou_me"],
      discover: true,
    },
    0,
    undefined,
    /oc_unwatched/,
  );
  assert.equal(seen.length, 0);
  assert.match(logs.join("\n"), /discover/);
  assert.match(logs.join("\n"), /oc_unwatched/);
});

test("a card misrouted into this channel is failed, not held", async () => {
  const { failed } = await run({ lark: lark("lark-card", []), sourceKey: "sk", users: ["ou_me"] }, 0, {
    id: 9,
    version: 1,
  });
  assert.equal(failed.length, 1);
  assert.equal(failed[0][0], 9);
  assert.equal(failed[0][1], 1);
});
