import * as Context from "effect/Context";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

// The contract every surface derives from: /rpc serves it as is, /mcp reuses its schemas as tools.

export const Login = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,38}$/, { message: "a lowercase GitHub login" }),
  ),
);

const Body = Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)));
const Id = Schema.String;

export const Message = Schema.Struct({
  id: Id,
  thread: Id,
  from: Login,
  to: Login,
  body: Schema.String,
  approved: Schema.Boolean,
  sentAt: Schema.String,
});
export type Message = typeof Message.Type;

export class UrtuuError extends Schema.TaggedError<UrtuuError>()("UrtuuError", {
  message: Schema.String,
}) {}

export const Ask = Rpc.make("Ask", {
  payload: { to: Login, body: Body },
  success: Schema.Struct({ thread: Id }),
  error: UrtuuError,
});

export const Inbox = Rpc.make("Inbox", { success: Schema.Array(Message) });

export const Reply = Rpc.make("Reply", {
  payload: { thread: Id, body: Body, approved: Schema.Boolean },
  success: Message,
  error: UrtuuError,
});

export const Thread = Rpc.make("Thread", {
  payload: { thread: Id, seen: Schema.optional(Schema.Int) },
  success: Schema.Array(Message),
  error: UrtuuError,
});

export const Invite = Rpc.make("Invite", { success: Schema.Struct({ command: Schema.String }) });

export const Urtuu = RpcGroup.make(Ask, Inbox, Reply, Thread, Invite);

// Who is calling. The Worker resolves it from the bearer token before any surface runs.
export class Caller extends Context.Service<Caller, { login: string; origin: string }>()(
  "urtuu/Caller",
) {}
