import * as Effect from "effect/Effect";
import { type Ask, Caller, type Reply, type Thread } from "./contract.ts";
import type { Station } from "./station.ts";

// One handler per contract operation, shared by /rpc and /mcp. Payload types come from the contract's schemas.
export const operations = (station: Station) => ({
  Ask: ({ to, body }: typeof Ask.payloadSchema.Type) =>
    Effect.gen(function* () {
      const caller = yield* Caller;
      return yield* station.ask(caller.login, to, body);
    }),
  Inbox: () =>
    Effect.gen(function* () {
      const caller = yield* Caller;
      return yield* station.inbox(caller.login);
    }),
  Reply: ({ thread, body, approved }: typeof Reply.payloadSchema.Type) =>
    Effect.gen(function* () {
      const caller = yield* Caller;
      return yield* station.reply(caller.login, thread, body, approved);
    }),
  Thread: ({ thread, seen }: typeof Thread.payloadSchema.Type) =>
    Effect.gen(function* () {
      const caller = yield* Caller;
      return yield* station.thread(caller.login, thread, seen);
    }),
  Invite: () =>
    Effect.gen(function* () {
      const caller = yield* Caller;
      return yield* station.invite(caller.login, caller.origin);
    }),
});
