import * as Effect from "effect/Effect";
import { type Ask, Caller, type Reply, type Thread } from "./contract.ts";
import type { Station } from "./station.ts";

const asCaller = <A, E, R>(f: (me: Caller["Service"]) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    return yield* f(yield* Caller);
  });

// One handler per contract operation, shared by /rpc and /mcp. Payload types come from the contract's schemas.
export const operations = (station: Station) => ({
  Ask: ({ to, body }: typeof Ask.payloadSchema.Type) => asCaller((me) => station.ask(me, to, body)),
  Inbox: () => asCaller((me) => station.inbox(me)),
  Reply: ({ thread, body, approved }: typeof Reply.payloadSchema.Type) =>
    asCaller((me) => station.reply(me, thread, body, approved)),
  Thread: ({ thread, seen }: typeof Thread.payloadSchema.Type) =>
    asCaller((me) => station.thread(me, thread, seen)),
  Who: () => station.who(),
  Invite: () => asCaller((me) => station.invite(me.login, me.origin)),
  Listen: () => asCaller((me) => station.listen(me)),
});
