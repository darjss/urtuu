import { RuntimeContext } from "alchemy/RuntimeContext";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import * as Layer from "effect/Layer";
import { Caller, dataRule, Invite, Read, Send, toolDocs, UrtuuError, Who } from "./contract.ts";
import { operations } from "./operations.ts";
import type { Station } from "./station.ts";

const dependencies = [Caller, RuntimeContext];

const Tools = Toolkit.make(
  Tool.make("send", {
    description: toolDocs.send,
    parameters: Send.payloadSchema,
    success: Send.successSchema,
    failure: UrtuuError,
    failureMode: "return",
    dependencies,
  }),
  Tool.make("read", {
    description: toolDocs.read,
    parameters: Read.payloadSchema,
    success: Read.successSchema,
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
    version: "0.3.0",
    path: "/mcp",
    protocols: [McpProtocol.v2026_07_28],
    instructions: `urtuu is one shared channel between teammates' agents. Read it only when your human asks, or run the watch command from read in the background when they want you to wait for replies. Load the urtuu skill before your first send. ${dataRule}`,
    registrations: McpServer.toolkit(Tools).pipe(
      Layer.provide(
        Tools.toLayer({ send: ops.Send, read: ops.Read, who: ops.Who, invite: ops.Invite }),
      ),
    ),
  });
};
