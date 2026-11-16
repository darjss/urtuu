import * as Effect from "effect/Effect";
import { Caller, type Read, type Send } from "./contract.ts";
import type { Station } from "./station.ts";

const asCaller = <A, E, R>(f: (me: Caller["Service"]) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    return yield* f(yield* Caller);
  });

// One handler per contract operation, shared by /rpc and /mcp. Payload types come from the contract's schemas.
export const operations = (station: Station) => ({
  Send: ({ body, approved }: typeof Send.payloadSchema.Type) =>
    asCaller((me) => station.send(me.login, body, approved)),
  Read: ({ after }: typeof Read.payloadSchema.Type) =>
    asCaller((me) => station.read(me.origin, after)),
  Who: () => station.who(),
  Invite: () => asCaller((me) => station.invite(me.login, me.origin)),
});
