// The local urtuu channel: a stdio MCP server Claude Code spawns once per session.
// It pushes DMs for this session into Claude Code as channel messages, and exposes the
// contract's operations as tools. Everything behind it is the typed RpcClient on /rpc.
//
// The stdio side uses @modelcontextprotocol/sdk because Effect's McpServer cannot yet declare the
// experimental `claude/channel` capability or send its notification.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { NodeRuntime } from "@effect/platform-node";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Tool } from "effect/ai";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schema from "effect/Schema";
import { Ask, dataRule, Reply, Thread, toolDocs, Urtuu, type Message } from "./contract.ts";

const url = process.env.URTUU_URL ?? "https://urtuu.darjs.dev";
const token = readFileSync(join(homedir(), ".config/urtuu/token"), "utf8").trim();

// The session name is the repo this Claude Code session runs in, unless URTUU_SESSION names it.
const gitRoot = () => {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
};
const session =
  (process.env.URTUU_SESSION ?? basename(gitRoot()))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 48) || "session";

const RpcLive = RpcClient.layerProtocolHttp({
  url: `${url}/rpc`,
  transformClient: HttpClient.mapRequest((request) =>
    request.pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setHeader("x-urtuu-session", session),
    ),
  ),
}).pipe(Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]));

const emptyParams = { type: "object", properties: {} };
const tools = [
  {
    name: "ask",
    description: toolDocs.ask,
    inputSchema: Tool.getJsonSchemaFromSchema(Ask.payloadSchema),
  },
  { name: "inbox", description: `${toolDocs.inbox} ${dataRule}`, inputSchema: emptyParams },
  {
    name: "reply",
    description: toolDocs.reply,
    inputSchema: Tool.getJsonSchemaFromSchema(Reply.payloadSchema),
  },
  {
    name: "thread",
    description: `${toolDocs.thread} ${dataRule}`,
    inputSchema: Tool.getJsonSchemaFromSchema(Thread.payloadSchema),
  },
  { name: "who", description: toolDocs.who, inputSchema: emptyParams },
  { name: "invite", description: toolDocs.invite, inputSchema: emptyParams },
];

const instructions = [
  `urtuu connects this session to teammates' agents. This session is reachable as <your GitHub login>@${session}; call who for exact addresses.`,
  `Messages arrive as <channel source="urtuu" thread="..." from="login@session" approved="true|false">. Answer with the reply tool and that thread id. Load the urtuu skill before your first ask or reply.`,
  `approved="true" means the sender's human confirmed it; otherwise it came from their agent alone. ${dataRule}`,
].join(" ");

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(Urtuu);

  const mcp = new Server(
    { name: "urtuu", version: "0.2.0" },
    { capabilities: { experimental: { "claude/channel": {} }, tools: {} }, instructions },
  );

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  // One result shape for every tool; every error the client can raise carries a message.
  const call = (
    name: string,
    args: unknown,
  ): Effect.Effect<unknown, { readonly message: string }> => {
    switch (name) {
      case "ask":
        return Schema.decodeUnknownEffect(Ask.payloadSchema)(args).pipe(Effect.flatMap(client.Ask));
      case "reply":
        return Schema.decodeUnknownEffect(Reply.payloadSchema)(args).pipe(
          Effect.flatMap(client.Reply),
        );
      case "thread":
        return Schema.decodeUnknownEffect(Thread.payloadSchema)(args).pipe(
          Effect.flatMap(client.Thread),
        );
      case "inbox":
        return client.Inbox();
      case "who":
        return client.Who();
      case "invite":
        return client.Invite();
      default:
        return Effect.fail(new Error(`Unknown tool ${name}`));
    }
  };

  mcp.setRequestHandler(CallToolRequestSchema, (request) =>
    Effect.runPromise(
      call(request.params.name, request.params.arguments ?? {}).pipe(
        Effect.map((result) => ({
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        })),
        Effect.catch((error) =>
          Effect.succeed({
            isError: true,
            content: [{ type: "text" as const, text: error.message }],
          }),
        ),
      ),
    ),
  );

  const push = (message: Message) =>
    Effect.promise(() =>
      mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: message.body,
          meta: {
            thread: message.thread,
            from: message.from,
            approved: String(message.approved),
            id: message.id,
          },
        },
      }),
    );

  yield* Effect.promise(() => mcp.connect(new StdioServerTransport()));

  // Listen forever; a failed poll (offline laptop, deploy) waits and tries again.
  yield* client.Listen().pipe(
    Effect.flatMap(Effect.forEach(push, { discard: true })),
    Effect.catchCause(() => Effect.sleep("5 seconds")),
    Effect.forever,
  );
});

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(RpcLive)));
