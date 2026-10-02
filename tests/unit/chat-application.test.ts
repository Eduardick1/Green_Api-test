import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatApplication } from '../../src/application/ChatApplication';
import type { ChatStore, Credentials, MessagingGateway, Notification } from '../../src/application/contracts';
import { Chat, ChatError, MessageStatus, TextMessage } from '../../src/domain/models';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function clone(chats: readonly Chat[]): Chat[] {
  return chats.map((chat) => new Chat({ ...chat, messages: chat.messages.map((message) => new TextMessage({ ...message })) }));
}

function incoming(id = 'provider-in', chatId = '123'): Notification {
  return { receiptId: `receipt-${id}`, senderName: 'Анна', message: new TextMessage({ localId: `incoming-${id}`, providerMessageId: id, chatId, text: 'Ответ', timestampMs: 2000, direction: 'incoming', status: MessageStatus.received }) };
}

const credentials: Credentials = { apiUrl: 'https://example.test', idInstance: 'account-a', apiTokenInstance: 'only-in-memory' };
const apps: ChatApplication[] = [];

function setup(seed: Chat[] = []) {
  const histories = new Map<string, Chat[]>([['account-a', clone(seed)]]);
  const gateway = {
    connect: vi.fn<MessagingGateway['connect']>().mockResolvedValue(undefined),
    resolveRecipient: vi.fn<MessagingGateway['resolveRecipient']>().mockResolvedValue(new Chat({ chatId: '123', title: 'Анна' })),
    sendText: vi.fn<MessagingGateway['sendText']>().mockResolvedValue('provider-out'),
    receive: vi.fn<MessagingGateway['receive']>().mockImplementation(() => new Promise(() => {})),
    acknowledge: vi.fn<MessagingGateway['acknowledge']>().mockResolvedValue(undefined),
    disconnect: vi.fn<MessagingGateway['disconnect']>(),
  };
  const store = {
    load: vi.fn<ChatStore['load']>().mockImplementation(async (accountId) => clone(histories.get(accountId) ?? [])),
    save: vi.fn<ChatStore['save']>().mockImplementation(async (accountId, chats) => { histories.set(accountId, clone(chats)); }),
  };
  let ids = 0;
  const app = new ChatApplication(gateway, store, { now: () => 1000, createId: () => `out-${++ids}`, emptyReceiveDelayMs: 5, retryBaseDelayMs: 5, retryMaxDelayMs: 10 });
  apps.push(app);
  return { app, gateway, store, histories };
}

async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

afterEach(() => { for (const app of apps.splice(0)) app.disconnect(); });

describe('ChatApplication', () => {
  it('connects, creates by normalized phone, reopens the same canonical chat and sends only after saving pending', async () => {
    const { app, gateway, histories } = setup();
    await app.connect(credentials);
    await app.createChat('+7 (999) 123-45-67');
    await app.createChat('79991234567');
    expect(gateway.resolveRecipient).toHaveBeenCalledWith('79991234567');
    expect(gateway.resolveRecipient).toHaveBeenCalledTimes(1);
    expect(app.getSnapshot().chats).toHaveLength(1);
    gateway.sendText.mockImplementation(async () => {
      expect(histories.get('account-a')?.[0].messages[0].status).toBe(MessageStatus.pending);
      return 'provider-out';
    });
    const sent = await app.sendText('123', 'Привет https://example.com');
    expect(sent.status).toBe(MessageStatus.accepted);
    expect(sent.providerMessageId).toBe('provider-out');
    expect(histories.get('account-a')?.[0].messages[0].status).toBe(MessageStatus.accepted);
  });

  it('publishes stable, deeply immutable snapshots without credentials', async () => {
    const { app } = setup([new Chat({ chatId: '123', title: 'Чат' })]);
    let notifications = 0;
    const unsubscribe = app.subscribe(() => { notifications++; });
    await app.connect(credentials);
    const old = app.getSnapshot();
    expect(app.getSnapshot()).toBe(old);
    expect(Object.isFrozen(old)).toBe(true);
    expect(Object.isFrozen(old.chats[0].messages)).toBe(true);
    await app.sendText('123', 'Текст');
    expect(old.chats[0].messages).toHaveLength(0);
    expect(Object.isFrozen(app.getSnapshot().chats[0].messages[0])).toBe(true);
    expect(JSON.stringify(app.getSnapshot())).not.toContain(credentials.apiTokenInstance);
    expect(notifications).toBeGreaterThan(0);
    unsubscribe();
  });

  it('rejects invalid messages and never sends when pending cannot be persisted', async () => {
    const { app, gateway, store } = setup([new Chat({ chatId: '123', title: 'Чат' })]);
    await app.connect(credentials);
    await expect(app.sendText('123', ' \n ')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(app.sendText('123', 'x'.repeat(4097))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    store.save.mockRejectedValueOnce(new ChatError('STORAGE_ERROR', 'Нет места'));
    await expect(app.sendText('123', 'Текст')).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    expect(gateway.sendText).not.toHaveBeenCalled();
    expect(app.getSnapshot().errorMessage).toBe('Нет места');
  });

  it('keeps accepted visible if final persistence fails and does not resend', async () => {
    const { app, gateway, store, histories } = setup([new Chat({ chatId: '123', title: 'Чат' })]);
    await app.connect(credentials);
    store.save.mockImplementationOnce(async (id, chats) => { histories.set(id, clone(chats)); });
    store.save.mockRejectedValueOnce(new ChatError('STORAGE_ERROR', 'Нет места'));
    const sent = await app.sendText('123', 'Текст');
    expect(sent.status).toBe(MessageStatus.accepted);
    expect(app.getSnapshot().chats[0].messages[0].status).toBe(MessageStatus.accepted);
    expect(app.getSnapshot().errorMessage).toBe('Нет места');
    expect(gateway.sendText).toHaveBeenCalledTimes(1);
    expect(histories.get('account-a')?.[0].messages[0].status).toBe(MessageStatus.pending);
  });

  it.each([
    ['SEND_REJECTED', MessageStatus.failed],
    ['SEND_UNKNOWN', MessageStatus.unknown],
    ['REQUEST_TIMEOUT', MessageStatus.unknown],
  ])('records %s without automatic resend', async (code, status) => {
    const { app, gateway } = setup([new Chat({ chatId: '123', title: 'Чат' })]);
    await app.connect(credentials);
    gateway.sendText.mockRejectedValueOnce(new ChatError(code, 'Ошибка отправки'));
    const sent = await app.sendText('123', 'Не терять этот текст');
    expect(sent.status).toBe(status);
    expect(sent.text).toBe('Не терять этот текст');
    expect(app.getSnapshot().errorMessage).toBe('Ошибка отправки');
    expect(gateway.sendText).toHaveBeenCalledTimes(1);
  });

  it('recovers pending to unknown, isolates account histories and never persists credentials', async () => {
    const pending = new TextMessage({ localId: 'old', chatId: '123', text: 'Незавершённое', timestampMs: 1, direction: 'outgoing', status: MessageStatus.pending });
    const { app, histories } = setup([new Chat({ chatId: '123', title: 'Первый', messages: [pending] })]);
    await app.connect(credentials);
    expect(app.getSnapshot().chats[0].messages[0].status).toBe(MessageStatus.unknown);
    expect(histories.get('account-a')?.[0].messages[0].status).toBe(MessageStatus.unknown);
    await app.connect({ ...credentials, idInstance: 'account-b' });
    expect(app.getSnapshot().chats).toHaveLength(0);
    await app.createChat('12025550123');
    expect(histories.get('account-a')?.[0].title).toBe('Первый');
    expect(histories.get('account-b')).toHaveLength(1);
    expect(JSON.stringify([...histories])).not.toContain(credentials.apiTokenInstance);
  });

  it('uses a trimmed instance ID for history even when login contains whitespace', async () => {
    const { app, store } = setup([new Chat({ chatId: '123', title: 'Сохранённый' })]);
    await app.connect({ ...credentials, idInstance: ' account-a ' });
    expect(store.load).toHaveBeenCalledWith('account-a');
    await app.sendText('123', 'Текст');
    expect(store.save).toHaveBeenCalledWith('account-a', expect.any(Array));
  });

  it('waits for an old in-flight save before loading the same account on reconnect', async () => {
    const { app, gateway, store, histories } = setup([new Chat({ chatId: '123', title: 'Чат' })]);
    const writing = deferred<void>();
    await app.connect(credentials);
    store.save.mockImplementationOnce(async (accountId, chats) => {
      await writing.promise;
      histories.set(accountId, clone(chats));
    });
    const send = app.sendText('123', 'Незавершённое');
    const failedSend = expect(send).rejects.toMatchObject({ code: 'SESSION_ENDED' });
    await flush();
    expect(store.save).toHaveBeenCalledTimes(1);
    const reconnect = app.connect(credentials);
    await flush();
    expect(store.load).toHaveBeenCalledTimes(1);
    writing.resolve();
    await failedSend;
    await reconnect;
    expect(app.getSnapshot().chats[0].messages[0].status).toBe(MessageStatus.unknown);
    expect(histories.get('account-a')?.[0].messages[0].status).toBe(MessageStatus.unknown);
    expect(gateway.sendText).not.toHaveBeenCalled();
  });

  it('saves and publishes incoming before acknowledging; retrying an ack does not duplicate messages', async () => {
    const { app, gateway, histories } = setup();
    const notification = incoming();
    gateway.receive.mockResolvedValueOnce(notification).mockResolvedValueOnce(notification);
    gateway.acknowledge.mockImplementationOnce(async () => {
      expect(histories.get('account-a')?.[0].messages).toHaveLength(1);
      expect(app.getSnapshot().chats[0].messages).toHaveLength(1);
      throw new ChatError('NETWORK_ERROR', 'Сбой подтверждения');
    });
    await app.connect(credentials);
    await vi.waitFor(() => expect(gateway.acknowledge).toHaveBeenCalledTimes(2));
    expect(app.getSnapshot().chats[0].title).toBe('Анна');
    expect(app.getSnapshot().chats[0].messages).toHaveLength(1);
  });

  it('does not acknowledge an incoming message after storage failure and stops receiving', async () => {
    const { app, gateway, store } = setup();
    gateway.receive.mockResolvedValueOnce(incoming());
    store.save.mockRejectedValueOnce(new ChatError('STORAGE_ERROR', 'Хранилище недоступно'));
    await app.connect(credentials);
    await flush();
    expect(gateway.acknowledge).not.toHaveBeenCalled();
    expect(gateway.receive).toHaveBeenCalledTimes(1);
    expect(app.getSnapshot().chats).toHaveLength(0);
    expect(app.getSnapshot().errorMessage).toBe('Хранилище недоступно');
  });

  it('acknowledges unsupported events without creating chats', async () => {
    const { app, gateway, store } = setup();
    gateway.receive.mockResolvedValueOnce({ receiptId: 'ignored' });
    await app.connect(credentials);
    await flush();
    expect(gateway.acknowledge).toHaveBeenCalledWith('ignored');
    expect(store.save).not.toHaveBeenCalled();
    expect(app.getSnapshot().chats).toHaveLength(0);
  });

  it('merges concurrent sending and receiving rather than overwriting a stale history', async () => {
    const { app, gateway, histories } = setup([new Chat({ chatId: '123', title: 'Чат' })]);
    const send = deferred<string>();
    const receive = deferred<Notification | null>();
    gateway.sendText.mockReturnValueOnce(send.promise);
    gateway.receive.mockReturnValueOnce(receive.promise);
    await app.connect(credentials);
    const pendingSend = app.sendText('123', 'Вопрос');
    await flush();
    expect(gateway.sendText).toHaveBeenCalledTimes(1);
    receive.resolve(incoming());
    await flush();
    send.resolve('outbound-id');
    await pendingSend;
    const messages = histories.get('account-a')![0].messages;
    expect(messages).toHaveLength(2);
    expect(messages.find((message) => message.direction === 'outgoing')?.status).toBe(MessageStatus.accepted);
    expect(messages.find((message) => message.direction === 'incoming')?.status).toBe(MessageStatus.received);
  });

  it('ignores late send and receive responses after account switch', async () => {
    const { app, gateway, histories } = setup([new Chat({ chatId: '123', title: 'Чат' })]);
    const send = deferred<string>();
    const receive = deferred<Notification | null>();
    gateway.sendText.mockReturnValueOnce(send.promise);
    gateway.receive.mockReturnValueOnce(receive.promise);
    await app.connect(credentials);
    const pendingSend = app.sendText('123', 'Вопрос');
    const sendFailure = expect(pendingSend).rejects.toMatchObject({ code: 'SESSION_ENDED' });
    await flush();
    await app.connect({ ...credentials, idInstance: 'account-b' });
    send.resolve('too-late');
    receive.resolve(incoming('late'));
    await sendFailure;
    await flush();
    expect(app.getSnapshot().chats).toHaveLength(0);
    expect(histories.get('account-b')).toBeUndefined();
    expect(gateway.acknowledge).not.toHaveBeenCalled();
    expect(histories.get('account-a')?.[0].messages[0].status).toBe(MessageStatus.pending);
  });

  it('disconnects on fatal authorization errors while transient receiving errors retry', async () => {
    const { app, gateway } = setup();
    gateway.receive.mockRejectedValueOnce(new ChatError('NETWORK_ERROR', 'Временно недоступно'));
    gateway.receive.mockRejectedValueOnce(new ChatError('AUTH_ERROR', 'Авторизация истекла'));
    await app.connect(credentials);
    await vi.waitFor(() => expect(app.getSnapshot().connected).toBe(false));
    expect(app.getSnapshot().errorMessage).toBe('Авторизация истекла');
    expect(gateway.receive).toHaveBeenCalledTimes(2);
    expect(gateway.disconnect).toHaveBeenCalledTimes(2);
  });

  it('clears a transient polling error after a successful empty response', async () => {
    const { app, gateway } = setup();
    gateway.receive.mockRejectedValueOnce(new ChatError('NETWORK_ERROR', 'Временная ошибка'));
    gateway.receive.mockResolvedValueOnce(null);
    await app.connect(credentials);
    await flush();
    expect(app.getSnapshot().errorMessage).toBe('Временная ошибка');
    await vi.waitFor(() => {
      expect(gateway.receive).toHaveBeenCalledTimes(3);
      expect(app.getSnapshot().errorMessage).toBeUndefined();
    });
  });

  it('successful receiving and acknowledgment keep an unresolved send error visible', async () => {
    const { app, gateway } = setup([new Chat({ chatId: '123', title: 'Чат' })]);
    const receive = deferred<Notification | null>();
    gateway.receive.mockReturnValueOnce(receive.promise).mockResolvedValueOnce(null);
    await app.connect(credentials);
    gateway.sendText.mockRejectedValueOnce(new ChatError('SEND_UNKNOWN', 'Результат отправки неизвестен'));
    await app.sendText('123', 'Не повторять автоматически');
    receive.resolve(incoming());
    await vi.waitFor(() => expect(gateway.receive).toHaveBeenCalledTimes(3));
    expect(gateway.acknowledge).toHaveBeenCalledTimes(1);
    expect(app.getSnapshot().errorMessage).toBe('Результат отправки неизвестен');
  });

  it('polling retries do not replace or clear an unresolved send error', async () => {
    const { app, gateway } = setup([new Chat({ chatId: '123', title: 'Чат' })]);
    const receive = deferred<Notification | null>();
    gateway.receive.mockReturnValueOnce(receive.promise).mockResolvedValueOnce(null);
    await app.connect(credentials);
    gateway.sendText.mockRejectedValueOnce(new ChatError('SEND_UNKNOWN', 'Проверьте результат отправки'));
    await app.sendText('123', 'Вопрос');
    receive.reject(new ChatError('NETWORK_ERROR', 'Ошибка получения'));
    await vi.waitFor(() => expect(gateway.receive).toHaveBeenCalledTimes(3));
    expect(app.getSnapshot().errorMessage).toBe('Проверьте результат отправки');
  });
});
