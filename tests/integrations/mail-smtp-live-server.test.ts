/**
 * The SMTP stage question, graded against a REAL scripted server on a real socket.
 *
 * Why this deserves its own file: `stage` is the only thing that decides whether Walnut may ever let
 * a human retry a send, SMTP has no dedupe, and the first implementation got it wrong in a way no
 * fake transporter could show. It read "did anything read the composed message" as "did DATA begin",
 * which is intuitive and false: on the envelope-error path nodemailer pipes the whole message into a
 * throwaway stream just to avoid holding it in memory, so a mistyped recipient drains the body
 * without a single byte reaching the socket. Every case below was a wrong answer at some point, and
 * each one had a cost: a typo became an unretriable `unknown` that only the Sent folder could
 * resolve, and so did a wrong port.
 *
 * The server here is deliberately dumb (a line reader and a table of replies) so each test states
 * what the SERVER said rather than what a library thinks it said, and it records the body it
 * received, which is how the finding above is verified directly rather than inferred.
 */
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { sendMail, messageIdFor, setSmtpTransportFactory } from '../../src/integrations/mail-imap/smtp.js';

/** A reply table over uppercased command lines. `DATA_OK` opens the body. */
type Script = (line: string) => string | undefined;

const DATA_OK = '__data__';

interface Scripted {
  port: number;
  /** Every command line the client sent, in order. */
  lines: string[];
  /** Everything sent between the `354` and the lone dot. Empty means DATA never began. */
  body: string;
  close(): Promise<void>;
}

const running: Scripted[] = [];
/** Every accepted socket, so teardown can drop one the client is still holding. See `closing`. */
const sockets: net.Socket[] = [];

const log = { debug: () => undefined, info: () => undefined, warn: () => undefined };

const MESSAGE = {
  from: { name: 'Alice', address: 'alice@example.invalid' },
  to: [{ address: 'bob@example.invalid' }],
  subject: 'Lunch on Thursday',
  text: 'Does **noon** work?',
  html: '<p>Does <strong>noon</strong> work?</p>',
  idempotencyKey: 'dr-live:1',
};

/** The ordinary conversation, with any step replaced by prefix. */
function table(overrides: Record<string, string> = {}): Script {
  return (line) => {
    for (const [prefix, reply] of Object.entries(overrides)) {
      if (line.startsWith(prefix)) return reply;
    }
    if (line.startsWith('EHLO') || line.startsWith('HELO')) return '250-scripted\r\n250 AUTH PLAIN LOGIN';
    if (line.startsWith('AUTH')) return '235 2.7.0 authenticated';
    if (line.startsWith('MAIL FROM')) return '250 2.1.0 ok';
    if (line.startsWith('RCPT TO')) return '250 2.1.5 ok';
    if (line.startsWith('DATA')) return DATA_OK;
    if (line.startsWith('QUIT')) return '221 2.0.0 bye';
    return '250 ok';
  };
}

/**
 * One scripted SMTP server on a random loopback port.
 *
 * `endOfData` is separate from the script because the reply to the lone dot is the ONE answer that
 * arrives after the server has the whole message, which is exactly the line between a send a human
 * may retry and one nobody can judge.
 */
async function scripted(script: Script, endOfData = '250 2.0.0 queued as scripted-1'): Promise<Scripted> {
  const state: Scripted = { port: 0, lines: [], body: '', close: async () => undefined };
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.write('220 scripted ESMTP\r\n');
    let buffer = '';
    let inData = false;
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const at = buffer.indexOf('\r\n');
        if (at < 0) break;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (inData) {
          if (line === '.') { inData = false; socket.write(`${endOfData}\r\n`); continue; }
          state.body += `${line}\n`;
          continue;
        }
        state.lines.push(line);
        const reply = script(line.toUpperCase());
        if (reply === undefined) continue;
        if (reply === DATA_OK) { inData = true; socket.write('354 go ahead\r\n'); continue; }
        socket.write(`${reply}\r\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  state.port = typeof address === 'object' && address ? address.port : 0;
  state.close = () => closing(server);
  running.push(state);
  return state;
}

/**
 * Close a listener AND drop whatever is still connected to it.
 *
 * `server.close()` alone only stops accepting: it waits for open sockets, and a client whose send
 * this test deliberately abandoned still holds one until nodemailer's own 15s greeting timeout fires.
 * That turned a 400ms assertion into a 15s test.
 */
function closing(server: net.Server): Promise<void> {
  for (const socket of sockets.splice(0)) socket.destroy();
  return new Promise<void>((resolve) => { server.close(() => resolve()); });
}

async function attempt(port: number, timeoutMs = 8_000): Promise<{
  ok?: Awaited<ReturnType<typeof sendMail>>;
  code?: string;
  stage?: string;
  message?: string;
}> {
  try {
    const ok = await sendMail({
      settings: { host: '127.0.0.1', port, security: 'none' },
      user: 'alice@example.invalid',
      password: 'not-a-real-password',
      message: MESSAGE,
      log,
      timeoutMs,
    });
    return { ok };
  } catch (error) {
    const staged = error as { code?: string; stage?: string; message?: string };
    return { code: staged.code, stage: staged.stage, message: staged.message };
  }
}

afterEach(async () => {
  // The REAL nodemailer is the point of this file: its own error shapes are what is being graded.
  setSmtpTransportFactory(null);
  await Promise.all(running.splice(0).map((one) => one.close()));
});

describe('a send the server refuses before it takes the body', () => {
  it('reads a refused recipient as before-data, and the server gets no DATA at all', async () => {
    const server = await scripted(table({ 'RCPT TO': '550 5.1.1 no such user' }));
    const outcome = await attempt(server.port);

    // `failed`, so the console may offer Retry: the mail provably did not go, and the fix is a typo.
    expect(outcome.stage).toBe('before-data');
    expect(outcome.code).toBe('invalid');
    expect(outcome.message).toContain('before it accepted any of it');

    // THE finding this file exists for. nodemailer drained the composed message into a throwaway
    // stream, so a byte-based stage signal saw the whole body go past; the socket carried none of it,
    // and the server never even received a DATA command.
    expect(server.body).toBe('');
    expect(server.lines.some((line) => line.toUpperCase().startsWith('DATA'))).toBe(false);
  });

  it('reads a refused DATA command as before-data', async () => {
    const server = await scripted(table({ DATA: '554 5.7.1 rejected for policy reasons' }));
    const outcome = await attempt(server.port);

    // The go-ahead never came, so there was nothing for the server to take. nodemailer reports this
    // at the same code as a refused envelope, which is why the code table treats them together.
    expect(outcome.stage).toBe('before-data');
    expect(outcome.code).toBe('invalid');
    expect(server.body).toBe('');
  });

  it('reads a rejected login as before-data, with the code that names the fix', async () => {
    const server = await scripted(table({ AUTH: '535 5.7.8 bad credentials' }));
    const outcome = await attempt(server.port);

    // `auth`, not a generic failure: the account is the thing to fix, and the base parks the account
    // on this code instead of inviting a retry that will fail the same way.
    expect(outcome.stage).toBe('before-data');
    expect(outcome.code).toBe('auth');
    expect(server.body).toBe('');
  });

  it('reads a refused connection as before-data', async () => {
    // Nothing listening: a wrong port, a firewall, a server that is down. This was `unknown` before
    // the rewrite, which is the worst possible answer, because there is nothing in the Sent folder
    // for the human to find and nothing here will ever retry it.
    const server = await scripted(table());
    const port = server.port;
    await server.close();
    running.splice(running.indexOf(server), 1);

    const outcome = await attempt(port, 4_000);
    expect(outcome.stage).toBe('before-data');
    expect(outcome.code).toBe('unreachable');
  });

  it('reads OUR OWN deadline as before-data when nothing was read out of the message', async () => {
    // A server that accepts the socket and never greets. Walnut's own clock fires, and the stage is
    // whatever can be proved: nothing was read out of the composed message, so nothing went. This
    // branch used to hard-code `after-data`, which made every slow-to-greet server a permanent
    // `unknown`.
    const silent = net.createServer((socket) => { sockets.push(socket); });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', () => resolve()));
    const address = silent.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const outcome = await attempt(port, 400);
      expect(outcome.stage).toBe('before-data');
      expect(outcome.code).toBe('unreachable');
      expect(outcome.message).toContain('within 400ms');
    } finally {
      await closing(silent);
    }
  });
});

describe('a send the server takes and then refuses', () => {
  it('is after-data, because a server that read the whole body may have queued it anyway', async () => {
    // Refused at the END of DATA. Nothing about a 451 there proves the message was not also queued,
    // and SMTP gives no way to ask, so this is the outcome that must never be retried automatically.
    const server = await scripted(table(), '451 4.3.0 try again later');
    const outcome = await attempt(server.port);

    expect(outcome.stage).toBe('after-data');
    expect(outcome.message).toContain('cannot tell whether it went');
    // The server really did receive the whole message: the classification is a fact here, not a
    // conservative guess.
    expect(server.body).toContain('Subject: Lunch on Thursday');
  });
});

describe('a send the server accepts', () => {
  it('reports the acceptance and hands back exactly the bytes that went over DATA', async () => {
    const server = await scripted(table());
    const outcome = await attempt(server.port);

    expect(outcome.stage).toBeUndefined();
    const result = outcome.ok!;
    expect(result.acceptedAt).toBeGreaterThan(0);
    // Derived from the ledger key, so one approved revision always carries the same id.
    const expectedId = messageIdFor(MESSAGE.idempotencyKey, MESSAGE.from.address);
    expect(result.providerMessageId).toBe(expectedId);

    // The captured raw is what the Sent copy is filed from, and it has to BE the sent message: two
    // composes of one mail differ in boundary strings, so a re-compose would put a lookalike in the
    // one folder a user checks to see what they sent.
    const raw = result.raw!.toString('utf8');
    // Matched on the id, not on `Message-ID: <id>`: a long header is FOLDED onto the next line, and
    // an assertion that hard-codes the unfolded spelling grades the composer's line width instead of
    // the thing that matters, which is that these bytes carry the derived id.
    expect(raw).toMatch(/Message-ID:\s/);
    expect(raw).toContain(expectedId);
    expect(raw).toContain('Subject: Lunch on Thursday');
    expect(raw).toContain('Does **noon** work?');
    expect(raw).toContain('<strong>noon</strong>');
    // The same message, seen from the other end of the socket.
    expect(server.body).toContain(expectedId);
    expect(server.body).toContain('Subject: Lunch on Thursday');
    // And the credential is nowhere in the message, however the transport authenticated.
    expect(raw).not.toContain('not-a-real-password');
  });
});
