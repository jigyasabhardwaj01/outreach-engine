import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { sendSmtp, buildMessage, dotStuff, parseReply, queueId, mailerFor, deliver } from '../src/mailer.js';

/** A mail server that answers each command with the next scripted reply. */
function fakeServer(replies) {
  const socket = new EventEmitter();
  socket.sent = [];
  socket.setEncoding = () => {};
  socket.end = () => { socket.ended = true; };

  const queue = [...replies];
  const next = () => {
    const reply = queue.shift();
    if (reply !== undefined) setImmediate(() => socket.emit('data', reply));
  };
  socket.write = (data) => { socket.sent.push(data); next(); return true; };

  // The greeting arrives before anyone asks for it, as a real server's does.
  setImmediate(next);
  return socket;
}

const HAPPY = [
  '220 smtp.gmail.com ESMTP ready\r\n',
  '250-smtp.gmail.com at your service\r\n250-SIZE 35882577\r\n250 SMTPUTF8\r\n',
  '334 VXNlcm5hbWU6\r\n',
  '334 UGFzc3dvcmQ6\r\n',
  '235 2.7.0 Accepted\r\n',
  '250 2.1.0 OK\r\n',
  '250 2.1.5 OK\r\n',
  '354 Go ahead\r\n',
  '250 2.0.0 OK 1763000000 abc123def456xyz - gsmtp\r\n',
  '221 2.0.0 closing connection\r\n',
];

const send = (replies = HAPPY, over = {}) => {
  let socket;
  const connectImpl = async () => (socket = fakeServer(replies));
  return sendSmtp({
    host: 'smtp.gmail.com', user: 'me@gmail.com', pass: 'app password', from: 'me@gmail.com',
    to: 'me@gmail.com', subject: 'Hello', body: 'Hi there', connectImpl, ...over,
  }).then((result) => ({ result, socket }), (error) => ({ error, socket }));
};

test('the SMTP conversation happens in the right order', async () => {
  const { result, socket } = await send();
  const commands = socket.sent.map((line) => line.split('\r\n')[0]);

  assert.deepEqual(commands.slice(0, 3), ['EHLO outreach-engine', 'AUTH LOGIN', Buffer.from('me@gmail.com').toString('base64')]);
  assert.ok(commands.includes('MAIL FROM:<me@gmail.com>'));
  assert.ok(commands.includes('RCPT TO:<me@gmail.com>'));
  assert.ok(commands.includes('DATA'));
  assert.ok(commands.includes('QUIT'));
  assert.equal(result.id, 'abc123def456xyz', 'the queue id comes back from the 250');
  assert.ok(socket.ended, 'the socket is closed afterwards');
});

test('a multi-line greeting is read as one reply, not three', async () => {
  // The 250-...250-...250 block would be three replies if hyphens were ignored.
  const { result, error } = await send();
  assert.equal(error, undefined, error?.message);
  assert.ok(result);
});

test('the password never appears in the conversation in the clear', async () => {
  const { socket } = await send();
  const wire = socket.sent.join('');
  assert.ok(!wire.includes('app password'));
  assert.ok(wire.includes(Buffer.from('app password').toString('base64')));
});

test('a rejected app password says what to do about it', async () => {
  const replies = [...HAPPY];
  replies[4] = '535-5.7.8 Username and Password not accepted\r\n535 5.7.8 https://support.google.com\r\n';
  const { error } = await send(replies);

  assert.match(error.message, /App Password/);
  assert.ok(!error.message.includes('app password'.toUpperCase()), 'it does not echo the secret');
});

test('a refused recipient fails loudly rather than reporting success', async () => {
  const replies = [...HAPPY];
  replies[6] = '550 5.1.1 No such user\r\n';
  const { error, result } = await send(replies);

  assert.equal(result, undefined);
  assert.match(error.message, /SMTP 550/);
});

test('a server that never answers gives up instead of hanging', async () => {
  const connectImpl = async () => {
    const socket = new EventEmitter();
    Object.assign(socket, { setEncoding() {}, write() {}, end() {} });
    return socket; // says nothing, ever
  };
  await assert.rejects(
    () => sendSmtp({ host: 'x', user: 'u', pass: 'p', from: 'a@b.c', to: 'a@b.c', subject: 's', body: 'b', connectImpl, timeoutMs: 60 }),
    /stopped replying/,
  );
});

test('a lone dot in the body cannot end the message early', () => {
  // Without stuffing, SMTP would treat this line as the end of DATA and the
  // rest of the email would vanish — with the server still reporting success.
  assert.equal(dotStuff('one\n.\ntwo'), 'one\r\n..\r\ntwo');
  assert.equal(dotStuff('.hidden'), '..hidden');
  assert.equal(dotStuff('nothing to do'), 'nothing to do');

  const message = buildMessage({ from: 'a@b.c', to: 'd@e.f', subject: 's', body: 'before\n.\nafter' });
  assert.ok(message.includes('\r\n..\r\n'));
  assert.ok(message.endsWith('\r\n.'), 'and the real terminator is still there');
});

test('headers survive accents, and cannot be injected into', () => {
  const message = buildMessage({
    from: 'a@b.c', fromName: 'Ada Lovelace', to: 'd@e.f',
    subject: 'Compliance — a question',
    body: 'hi',
  });
  assert.match(message, /Subject: =\?UTF-8\?B\?/, 'a non-ASCII subject is encoded');

  const injected = buildMessage({ from: 'a@b.c', to: 'd@e.f', subject: 'Hi\r\nBcc: someone@else.com', body: 'x' });
  assert.ok(!/\r\nBcc:/i.test(injected), 'a newline in the subject cannot add a header');
});

test('a plain ASCII subject is left alone', () => {
  assert.match(buildMessage({ from: 'a@b.c', to: 'd@e.f', subject: 'Plain subject', body: 'x' }), /Subject: Plain subject/);
});

test('parseReply reads the code off the last line', () => {
  assert.deepEqual(parseReply('250-one\r\n250 two\r\n'), { code: 250, text: '250-one 250 two' });
  assert.ok(Number.isNaN(parseReply('').code), 'nothing at all is not a code, and must not read as 0');
  assert.ok(Number.isNaN(parseReply('garbled\r\n').code), 'nor is a line without one');
});

test('the mailer is chosen by configuration, and says what it lacks', () => {
  assert.deepEqual(mailerFor({ MAILER: 'gmail', GMAIL_USER: 'a@b.c', GMAIL_APP_PASSWORD: 'x' }), { name: 'gmail', ready: true, missing: [] });
  assert.deepEqual(mailerFor({ MAILER: 'gmail', GMAIL_USER: 'a@b.c' }), { name: 'gmail', ready: false, missing: ['GMAIL_APP_PASSWORD'] });
  assert.equal(mailerFor({ RESEND_API_KEY: 'x' }).name, 'resend', 'resend is the fallback');
  assert.equal(mailerFor({ GMAIL_APP_PASSWORD: 'x', GMAIL_USER: 'a@b.c' }).name, 'gmail', 'a Gmail password implies Gmail');
  assert.match(mailerFor({ MAILER: 'pigeon' }).missing[0], /must be "gmail" or "resend"/);
});

test('deliver refuses rather than half-sending when nothing is configured', async () => {
  await assert.rejects(() => deliver({ settings: {}, to: 'me@mine.com', subject: 's', body: 'b' }), /Cannot send: RESEND_API_KEY not set/);
});

test('Gmail sends as the account that authenticated, whatever EMAIL_FROM says', async () => {
  let socket;
  await deliver({
    settings: { MAILER: 'gmail', GMAIL_USER: 'me@gmail.com', GMAIL_APP_PASSWORD: 'p', EMAIL_FROM: 'someone@else.com', SENDER_NAME: 'Me' },
    to: 'me@gmail.com', subject: 's', body: 'b',
    connectImpl: async () => (socket = fakeServer(HAPPY)),
  });
  assert.ok(socket.sent.some((line) => line.startsWith('MAIL FROM:<me@gmail.com>')));
  assert.ok(!socket.sent.join('').includes('someone@else.com'), 'Gmail would rewrite it anyway, so we do not pretend');
});

test('the queue id is the id, not the timestamp sitting next to it', () => {
  assert.equal(queueId('250 2.0.0 OK  1763000000 abc123def456xyz - gsmtp'), 'abc123def456xyz');
  assert.equal(queueId('250 2.0.0 OK'), null, 'some servers give no id at all');
  assert.equal(queueId(''), null);
});
