import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/worker.ts";

export default Alchemy.Stack(
  "urtuu",
  {
    providers: Cloudflare.providers(),
    // `alchemy dev` runs fully local; deploys keep state in Cloudflare.
    state: Layer.unwrap(
      AlchemyContext.pipe(
        Effect.map(({ dev }) => (dev ? Alchemy.localState() : Cloudflare.state())),
      ),
    ),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    return { url: api.url.as<string>() };
  }),
);
