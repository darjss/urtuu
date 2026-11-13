import type * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Login, type Message, UrtuuError } from "./contract.ts";

const WAIT_STEP = "2 seconds";
const THREAD_WAIT_STEPS = 25;
const LISTEN_WAIT_STEPS = 12;
const ONLINE_MS = 3 * 60 * 1000;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Agent-only messages in a row before a thread pauses for a human (an approved message resumes it).
const AGENT_RUN_LIMIT = 6;

// The caller as the station sees it: a login, and the session when it came through a local channel.
export interface Me {
  readonly login: string;
  readonly session: string | undefined;
}

const MessageRow = Schema.Struct({
  id: Schema.String,
  thread_id: Schema.String,
  from_login: Schema.String,
  from_session: Schema.NullOr(Schema.String),
  to_login: Schema.String,
  to_session: Schema.NullOr(Schema.String),
  body: Schema.String,
  approved: Schema.Number,
  created_at: Schema.Number,
});
type MessageRow = typeof MessageRow.Type;
const LoginRow = Schema.Struct({ login: Schema.String });
const OnlineRow = Schema.Struct({ login: Schema.String, session: Schema.String });
const UnreadRow = Schema.Struct({ from_login: Schema.String, n: Schema.Number });
const InviteRow = Schema.Struct({ invited_by: Schema.String });

const address = (login: string, session: string | null) =>
  session === null ? login : `${login}@${session}`;

const toMessage = (row: MessageRow): Message => ({
  id: row.id,
  thread: row.thread_id,
  from: address(row.from_login, row.from_session),
  to: address(row.to_login, row.to_session),
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

  const threadRows = (id: string) =>
    rows(MessageRow, "SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at, id", id);

  const participant = Effect.fn("Station.participant")(function* (me: Me, id: string) {
    const all = yield* threadRows(id);
    const first = all[0];
    if (!first || (first.from_login !== me.login && first.to_login !== me.login)) {
      return yield* new UrtuuError({ message: `No thread ${id} that includes ${me.login}.` });
    }
    return { first, all };
  });

  // A session-less caller sees all of its login's mail; a session sees its own plus login-wide mail.
  const unreadFor = (me: Me) =>
    me.session === undefined
      ? rows(
          MessageRow,
          "SELECT * FROM messages WHERE to_login = ? AND read_at IS NULL ORDER BY created_at, id",
          me.login,
        )
      : rows(
          MessageRow,
          "SELECT * FROM messages WHERE to_login = ? AND read_at IS NULL AND (to_session IS NULL OR to_session = ?) ORDER BY created_at, id",
          me.login,
          me.session,
        );

  const markRead = (me: Me, messages: ReadonlyArray<MessageRow>) => {
    const ids = messages.filter((m) => m.to_login === me.login).map((m) => m.id);
    return ids.length === 0
      ? Effect.void
      : run(
          `UPDATE messages SET read_at = ? WHERE read_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`,
          Date.now(),
          ...ids,
        );
  };

  const seen = (me: Me) =>
    me.session === undefined
      ? Effect.void
      : run(
          "INSERT INTO sessions (login, session, last_seen) VALUES (?, ?, ?) ON CONFLICT (login, session) DO UPDATE SET last_seen = excluded.last_seen",
          me.login,
          me.session,
          Date.now(),
        );

  // A new thread's id is its first message's id.
  const send = Effect.fn("Station.send")(function* (
    thread: string | undefined,
    from: Me,
    to: { login: string; session: string | null },
    body: string,
    approved: boolean,
  ) {
    const now = Date.now();
    const id = randomHex(5);
    const row: MessageRow = {
      id,
      thread_id: thread ?? id,
      from_login: from.login,
      from_session: from.session ?? null,
      to_login: to.login,
      to_session: to.session,
      body,
      approved: approved ? 1 : 0,
      created_at: now,
    };
    yield* run(
      "INSERT INTO messages (id, thread_id, from_login, from_session, to_login, to_session, body, approved, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      row.id,
      row.thread_id,
      row.from_login,
      row.from_session,
      row.to_login,
      row.to_session,
      row.body,
      row.approved,
      row.created_at,
    );
    return toMessage(row);
  });

  const members = rows(LoginRow, "SELECT DISTINCT login FROM tokens ORDER BY login").pipe(
    Effect.map((all) => all.map((m) => m.login)),
  );

  return {
    ask: Effect.fn("Station.ask")(function* (from: Me, to: string, body: string) {
      const [login = "", session] = to.split("@");
      const known = yield* members;
      if (!known.includes(login)) {
        return yield* new UrtuuError({
          message: `${login} is not on this station. Members: ${known.join(", ")}.`,
        });
      }
      const message = yield* send(
        undefined,
        from,
        { login, session: session ?? null },
        body,
        false,
      );
      return { thread: message.thread };
    }),

    inbox: Effect.fn("Station.inbox")(function* (me: Me) {
      const unread = yield* unreadFor(me);
      yield* markRead(me, unread);
      return unread.map(toMessage);
    }),

    // Waits for mail to this session, so the local channel can push it into Claude Code as it lands.
    listen: Effect.fn("Station.listen")(function* (me: Me) {
      yield* seen(me);
      let unread = yield* unreadFor(me);
      for (let step = 0; unread.length === 0 && step < LISTEN_WAIT_STEPS; step++) {
        yield* Effect.sleep(WAIT_STEP);
        unread = yield* unreadFor(me);
      }
      yield* markRead(me, unread);
      return unread.map(toMessage);
    }),

    reply: Effect.fn("Station.reply")(function* (
      me: Me,
      id: string,
      body: string,
      approved: boolean,
    ) {
      const { first, all } = yield* participant(me, id);
      const tail = all.slice(-AGENT_RUN_LIMIT);
      if (!approved && tail.length === AGENT_RUN_LIMIT && tail.every((m) => m.approved === 0)) {
        return yield* new UrtuuError({
          message: `Thread ${id} is paused after ${AGENT_RUN_LIMIT} agent-only messages in a row. Show your human where it stands; send with approved true once they weigh in.`,
        });
      }
      // Reply to the session the other side last wrote from, so a conversation stays with one session.
      const theirs = all.filter((m) => m.from_login !== me.login).at(-1);
      const to = theirs
        ? { login: theirs.from_login, session: theirs.from_session }
        : { login: first.to_login, session: first.to_session };
      return yield* send(id, me, to, body, approved);
    }),

    // Long-polls: with `seen`, returns once the thread has more than `seen` messages, or after ~50s.
    thread: Effect.fn("Station.thread")(function* (me: Me, id: string, count?: number) {
      let { all } = yield* participant(me, id);
      for (
        let step = 0;
        count !== undefined && all.length <= count && step < THREAD_WAIT_STEPS;
        step++
      ) {
        yield* Effect.sleep(WAIT_STEP);
        all = yield* threadRows(id);
      }
      yield* markRead(me, all);
      return all.map(toMessage);
    }),

    who: Effect.fn("Station.who")(function* () {
      const online = yield* rows(
        OnlineRow,
        "SELECT login, session FROM sessions WHERE last_seen > ? ORDER BY login, session",
        Date.now() - ONLINE_MS,
      );
      return {
        members: yield* members,
        online: online.map((s) => address(s.login, s.session)),
      };
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
