import { RuntimeContext } from "alchemy/RuntimeContext";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import * as Layer from "effect/Layer";
import {
  Ask,
  Caller,
  dataRule,
  Inbox,
  Invite,
  Reply,
  Thread,
  toolDocs,
  UrtuuError,
  Who,
} from "./contract.ts";
import { operations } from "./operations.ts";
import type { Station } from "./station.ts";

// Remote MCP for agents without the local channel (no live push, no session address).
const dependencies = [Caller, RuntimeContext];

const Tools = Toolkit.make(
  Tool.make("ask", {
    description: toolDocs.ask,
    parameters: Ask.payloadSchema,
    success: Ask.successSchema,
    failure: UrtuuError,
    failureMode: "return",
    dependencies,
  }),
  Tool.make("inbox", {
    description: `${toolDocs.inbox} ${dataRule}`,
    success: Inbox.successSchema,
    dependencies,
  }),
  Tool.make("reply", {
    description: toolDocs.reply,
    parameters: Reply.payloadSchema,
    success: Reply.successSchema,
    failure: UrtuuError,
    failureMode: "return",
    dependencies,
  }),
  Tool.make("thread", {
    description: `${toolDocs.thread} ${dataRule}`,
    parameters: Thread.payloadSchema,
    success: Thread.successSchema,
    failure: UrtuuError,
    failureMode: "return",
    dependencies,
  }),
  Tool.make("who", { description: toolDocs.who, success: Who.successSchema, dependencies }),
  Tool.make("invite", {
    description: toolDocs.invite,
    success: Invite.successSchema,
    dependencies,
  }),
);

export const mcpLayer = (station: Station) => {
  const ops = operations(station);
  return McpServer.layerHttpRequestScoped({
    name: "urtuu",
    version: "0.2.0",
    path: "/mcp",
    protocols: [McpProtocol.v2026_07_28],
    instructions: `urtuu lets you coordinate with teammates' agents, addressed by GitHub login. Load the urtuu skill before your first ask or reply. ${dataRule}`,
    registrations: McpServer.toolkit(Tools).pipe(
      Layer.provide(
        Tools.toLayer({
          ask: ops.Ask,
          inbox: ops.Inbox,
          reply: ops.Reply,
          thread: ops.Thread,
          who: ops.Who,
          invite: ops.Invite,
        }),
      ),
    ),
  });
};
