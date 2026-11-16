import type * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Login, type Message, UrtuuError } from "./contract.ts";

const RECENT = 20;
const PAGE = 100;
// /watch checks every 2s for about 90s, then the client's loop asks again.
const WATCH_STEP = "2 seconds";
const WATCH_STEPS = 45;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Agent-only messages in a row before the channel pauses for a human (an approved message resumes it).
const AGENT_RUN_LIMIT = 6;

const MessageRow = Schema.Struct({
  id: Schema.Number,
  from_login: Schema.String,
  body: Schema.String,
  approved: Schema.Number,
  created_at: Schema.Number,
});
const LoginRow = Schema.Struct({ login: Schema.String });
const InviteRow = Schema.Struct({ invited_by: Schema.String });

const toMessage = (row: typeof MessageRow.Type): Message => ({
  id: row.id,
  from: row.from_login,
  body: row.body,
  approved: row.approved === 1,
  sentAt: new Date(row.created_at).toISOString(),
});

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const randomHex = (bytes: number) => hex(crypto.getRandomValues(new Uint8Array(bytes)));
const sha256 = (text: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
    Effect.map((digest) => hex(new Uint8Array(digest))),
  );

// The command an agent runs in the background to wait for the next message from someone else.
export const watchCommand = (origin: string, after: number) =>
  `until curl -fsS -m 120 -H "authorization: Bearer $(cat ~/.config/urtuu/token)" "${origin}/watch?after=${after}" | grep .; do sleep 5; done`;

export const makeStation = (db: Cloudflare.D1.QueryDatabaseClient) => {
  // Every row read goes through a Schema, so a drifted column fails loudly instead of lying to the types.
  const rows = <A, I>(schema: Schema.Codec<A, I>, sql: string, ...binds: Array<unknown>) =>
    db
      .prepare(sql)
      .bind(...binds)
      .all()
      .pipe(
        Effect.flatMap((result) =>
          Schema.decodeUnknownEffect(Schema.Array(schema))(result.results),
        ),
        Effect.orDie,
      );
  const run = (sql: string, ...binds: Array<unknown>) =>
    db
      .prepare(sql)
      .bind(...binds)
      .run()
      .pipe(Effect.asVoid);

  const after = (id: number) =>
    rows(MessageRow, "SELECT * FROM messages WHERE id > ? ORDER BY id LIMIT ?", id, PAGE);

  return {
    send: Effect.fn("Station.send")(function* (login: string, body: string, approved: boolean) {
      const tail = yield* rows(
        MessageRow,
        "SELECT * FROM messages ORDER BY id DESC LIMIT ?",
        AGENT_RUN_LIMIT,
      );
      if (!approved && tail.length === AGENT_RUN_LIMIT && tail.every((m) => m.approved === 0)) {
        return yield* new UrtuuError({
          message: `The channel is paused after ${AGENT_RUN_LIMIT} agent-only messages in a row. Show your human where it stands; send with approved true once they weigh in.`,
        });
      }
      const [row] = yield* rows(
        MessageRow,
        "INSERT INTO messages (from_login, body, approved, created_at) VALUES (?, ?, ?, ?) RETURNING *",
        login,
        body,
        approved ? 1 : 0,
        Date.now(),
      );
      if (!row) return yield* Effect.die("INSERT returned no row");
      return toMessage(row);
    }),

    read: Effect.fn("Station.read")(function* (origin: string, from?: number) {
      const found =
        from === undefined
          ? (yield* rows(MessageRow, "SELECT * FROM messages ORDER BY id DESC LIMIT ?", RECENT))
              .slice()
              .reverse()
          : yield* after(from);
      const last = found.at(-1)?.id ?? from ?? 0;
      return { messages: found.map(toMessage), watch: watchCommand(origin, last) };
    }),

    // Long-polls for messages from anyone but the caller. Empty after ~90s, so the client asks again.
    watch: Effect.fn("Station.watch")(function* (login: string, from: number) {
      for (let step = 0; step < WATCH_STEPS; step++) {
        const found = yield* after(from);
        if (found.some((m) => m.from_login !== login)) return found.map(toMessage);
        yield* Effect.sleep(WATCH_STEP);
      }
      return [];
    }),

    who: Effect.fn("Station.who")(function* () {
      const members = yield* rows(LoginRow, "SELECT DISTINCT login FROM tokens ORDER BY login");
      return { members: members.map((m) => m.login) };
    }),

    invite: Effect.fn("Station.invite")(function* (by: string, origin: string) {
      const code = randomHex(16);
      yield* run(
        "INSERT INTO invites (code_hash, invited_by, created_at) VALUES (?, ?, ?)",
        yield* sha256(code),
        by,
        Date.now(),
      );
      return { command: `curl -fsSL ${origin}/join.sh | sh -s ${code}` };
    }),

    join: Effect.fn("Station.join")(function* (code: string, rawLogin: string) {
      const login = yield* Schema.decodeUnknownEffect(Login)(rawLogin.trim().toLowerCase()).pipe(
        Effect.mapError(
          () =>
            new UrtuuError({
              message: `"${rawLogin}" is not a GitHub login. Run gh auth login, or git config --global github.user <login>.`,
            }),
        ),
      );
      const used = yield* rows(
        InviteRow,
        "DELETE FROM invites WHERE code_hash = ? AND created_at > ? RETURNING invited_by",
        yield* sha256(code),
        Date.now() - INVITE_TTL_MS,
      );
      if (used.length === 0) {
        return yield* new UrtuuError({
          message: "This invite is used or expired. Ask for a new one.",
        });
      }
      const token = `urtuu_${randomHex(32)}`;
      yield* run(
        "INSERT INTO tokens (token_hash, login, created_at) VALUES (?, ?, ?)",
        yield* sha256(token),
        login,
        Date.now(),
      );
      return { login, token };
    }),

    authenticate: Effect.fn("Station.authenticate")(function* (token: string) {
      const found = yield* rows(
        LoginRow,
        "SELECT login FROM tokens WHERE token_hash = ?",
        yield* sha256(token),
      );
      return found[0]?.login;
    }),
  };
};

export type Station = ReturnType<typeof makeStation>;
