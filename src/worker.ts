import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Schema from "effect/Schema";
import { Caller, Session, Urtuu } from "./contract.ts";
import { mcpLayer } from "./mcp.ts";
import { operations } from "./operations.ts";
import { makeStation } from "./station.ts";

export const Db = Cloudflare.D1.Database("Db", { migrations: "./migrations" });

const JoinForm = Schema.Struct({ code: Schema.String, login: Schema.String });

const unauthorized = HttpServerResponse.text("Missing or unknown urtuu token.\n", { status: 401 });

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.url,
    compatibility: { date: "2026-11-01" },
    domain: "urtuu.darjs.dev",
    assets: "./public",
  },
  Effect.gen(function* () {
    const station = makeStation(yield* Cloudflare.D1.QueryDatabase(Db));
    const adminToken = yield* Config.Redacted("URTUU_ADMIN_TOKEN");
    const rpcHandlers = Urtuu.toLayer(operations(station));

    // Each surface is built per request: Workers can't share I/O across requests.
    const surface = (path: string) => {
      if (path === "/mcp") return Effect.flatten(HttpRouter.toHttpEffect(mcpLayer(station)));
      if (path === "/rpc")
        return Effect.flatten(RpcServer.toHttpEffect(Urtuu)).pipe(
          Effect.provide([rpcHandlers, RpcSerialization.layerJson]),
        );
      return undefined;
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.originalUrl);
        // RpcClient posts to `/rpc/`, so a trailing slash names the same route.
        const path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, "") : url.pathname;
        const route = `${request.method} ${path}`;

        if (route === "POST /join") {
          const form = yield* HttpServerRequest.schemaBodyUrlParams(JoinForm);
          const joined = yield* station.join(form.code, form.login);
          return HttpServerResponse.text(`${joined.login}\n${joined.token}\n`);
        }

        const token = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
        if (route === "POST /invite" && token !== "" && token === Redacted.value(adminToken)) {
          const invite = yield* station.invite("admin", url.origin);
          return HttpServerResponse.text(`${invite.command}\n`);
        }

        const login = token === "" ? undefined : yield* station.authenticate(token);
        if (login === undefined) return unauthorized;
        const session = Schema.decodeUnknownOption(Session)(request.headers["x-urtuu-session"]);
        const caller = Caller.of({
          login,
          session: Option.getOrUndefined(session),
          origin: url.origin,
        });

        const handler = surface(path);
        if (handler)
          return yield* handler.pipe(Effect.provideService(Caller, caller), Effect.scoped);

        if (route === "GET /unread") {
          const unread = yield* station.unread(login);
          if (unread.length === 0) return HttpServerResponse.empty();
          const from = unread.map((row) => `${row.n} from ${row.from_login}`).join(", ");
          return HttpServerResponse.text(
            `urtuu: unread ${from}. Read them with the urtuu inbox tool and tell your human; commitments wait for their yes.\n`,
          );
        }
        if (route === "POST /invite") {
          const invite = yield* station.invite(login, url.origin);
          return HttpServerResponse.text(`${invite.command}\n`);
        }
        return HttpServerResponse.text("Not found.\n", { status: 404 });
      }).pipe(
        Effect.catchTags({
          IllegalArgumentError: Effect.die,
          UrtuuError: (error) =>
            Effect.succeed(HttpServerResponse.text(`${error.message}\n`, { status: 400 })),
          SchemaError: () =>
            Effect.succeed(
              HttpServerResponse.text("Expected form fields code and login.\n", { status: 400 }),
            ),
        }),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding)),
) {}
