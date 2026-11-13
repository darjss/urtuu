import type * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Login, type Message, UrtuuError } from "./contract.ts";

const WAIT_STEPS = 25;
const WAIT_STEP = "2 seconds";
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const MessageRow = Schema.Struct({
  id: Schema.String,
  thread_id: Schema.String,
  from_login: Schema.String,
  to_login: Schema.String,
  body: Schema.String,
  approved: Schema.Number,
  created_at: Schema.Number,
});
const LoginRow = Schema.Struct({ login: Schema.String });
const UnreadRow = Schema.Struct({ from_login: Schema.String, n: Schema.Number });
const InviteRow = Schema.Struct({ invited_by: Schema.String });

const toMessage = (row: typeof MessageRow.Type): Message => ({
  id: row.id,
  thread: row.thread_id,
  from: row.from_login,
  to: row.to_login,
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

  const thread = (id: string) =>
    rows(MessageRow, "SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at, id", id).pipe(
      Effect.map((all) => all.map(toMessage)),
    );

  const participant = Effect.fn("Station.participant")(function* (login: string, id: string) {
    const all = yield* thread(id);
    const first = all[0];
    if (!first || (first.from !== login && first.to !== login)) {
      return yield* new UrtuuError({ message: `No thread ${id} that includes ${login}.` });
    }
    return { first, all };
  });

  // A new thread's id is its first message's id.
  const send = Effect.fn("Station.send")(function* (
    thread: string | undefined,
    from: string,
    to: string,
    body: string,
    approved: boolean,
  ) {
    const now = Date.now();
    const id = randomHex(5);
    const message: Message = {
      id,
      thread: thread ?? id,
      from,
      to,
      body,
      approved,
      sentAt: new Date(now).toISOString(),
    };
    yield* run(
      "INSERT INTO messages (id, thread_id, from_login, to_login, body, approved, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      message.thread,
      from,
      to,
      body,
      approved ? 1 : 0,
      now,
    );
    return message;
  });

  const markRead = (login: string, messages: ReadonlyArray<Message>) => {
    const ids = messages.filter((m) => m.to === login).map((m) => m.id);
    return ids.length === 0
      ? Effect.void
      : run(
          `UPDATE messages SET read_at = ? WHERE read_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`,
          Date.now(),
          ...ids,
        );
  };

  return {
    ask: Effect.fn("Station.ask")(function* (from: string, to: string, body: string) {
      const members = yield* rows(LoginRow, "SELECT DISTINCT login FROM tokens ORDER BY login");
      if (!members.some((m) => m.login === to)) {
        const names = members.map((m) => m.login).join(", ");
        return yield* new UrtuuError({
          message: `${to} is not on this station. Members: ${names}.`,
        });
      }
      const message = yield* send(undefined, from, to, body, false);
      return { thread: message.thread };
    }),

    inbox: Effect.fn("Station.inbox")(function* (login: string) {
      const unread = yield* rows(
        MessageRow,
        "SELECT * FROM messages WHERE to_login = ? AND read_at IS NULL ORDER BY created_at, id",
        login,
      ).pipe(Effect.map((all) => all.map(toMessage)));
      yield* markRead(login, unread);
      return unread;
    }),

    reply: Effect.fn("Station.reply")(function* (
      login: string,
      id: string,
      body: string,
      approved: boolean,
    ) {
      const { first } = yield* participant(login, id);
      return yield* send(id, login, first.from === login ? first.to : first.from, body, approved);
    }),

    // Long-polls: with `seen`, returns once the thread has more than `seen` messages, or after ~50s.
    thread: Effect.fn("Station.thread")(function* (login: string, id: string, seen?: number) {
      let { all } = yield* participant(login, id);
      for (let step = 0; seen !== undefined && all.length <= seen && step < WAIT_STEPS; step++) {
        yield* Effect.sleep(WAIT_STEP);
        all = yield* thread(id);
      }
      yield* markRead(login, all);
      return all;
    }),

    unread: (login: string) =>
      rows(
        UnreadRow,
        "SELECT from_login, COUNT(*) AS n FROM messages WHERE to_login = ? AND read_at IS NULL GROUP BY from_login",
        login,
      ),

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
