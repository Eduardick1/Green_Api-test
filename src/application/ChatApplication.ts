import { Chat, ChatError, MessageStatus, TextMessage, normalizePhone } from '../domain/models';
import type { ChatState, ChatStore, Credentials, MessagingGateway, Notification, Unsubscribe } from './contracts';

interface ApplicationOptions {
  now?: () => number;
  createId?: () => string;
  emptyReceiveDelayMs?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
}

function cloneChats(chats: readonly Chat[]): Chat[] {
  return chats.map((chat) => new Chat({
    ...chat,
    messages: chat.messages.map((message) => new TextMessage({ ...message })),
  }));
}

function freezeChats(chats: readonly Chat[]): readonly Chat[] {
  if (Object.isFrozen(chats)) return chats;
  for (const chat of chats) {
    for (const message of chat.messages) Object.freeze(message);
    Object.freeze(chat.messages);
    Object.freeze(chat);
  }
  return Object.freeze(chats);
}

function asChatError(error: unknown, code: string, message: string): ChatError {
  return error instanceof ChatError ? error : new ChatError(code, message);
}

export class ChatApplication {
  private state: ChatState = Object.freeze({ chats: Object.freeze([]), connected: false });
  private readonly listeners = new Set<() => void>();
  private accountId?: string;
  private epoch = 0;
  private commits: Promise<void> = Promise.resolve();
  private receivingPaused = false;
  private errorSource?: 'polling' | 'action';
  private cancelDelay?: () => void;
  private readonly options: Required<ApplicationOptions>;
  private idSequence = 0;

  constructor(private readonly gateway: MessagingGateway, private readonly store: ChatStore, options: ApplicationOptions = {}) {
    this.options = {
      now: options.now ?? Date.now,
      createId: options.createId ?? (() => `local-${Date.now()}-${++this.idSequence}-${Math.random().toString(36).slice(2)}`),
      emptyReceiveDelayMs: options.emptyReceiveDelayMs ?? 250,
      retryBaseDelayMs: options.retryBaseDelayMs ?? 1000,
      retryMaxDelayMs: options.retryMaxDelayMs ?? 15000,
    };
  }

  getSnapshot = (): ChatState => this.state;

  subscribe = (listener: () => void): Unsubscribe => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  async connect(credentials: Credentials): Promise<void> {
    this.disconnect();
    const epoch = this.epoch;
    const accountId = credentials.idInstance.trim();
    try {
      await this.gateway.connect(credentials);
      this.assertEpoch(epoch);
      const chats = await this.enqueue(async () => {
        this.assertEpoch(epoch);
        const loaded = cloneChats(await this.store.load(accountId));
        this.assertEpoch(epoch);
        let recovered = false;
        for (const chat of loaded) {
          for (const message of chat.messages) {
            if (message.status === MessageStatus.pending) {
              message.status = MessageStatus.unknown;
              recovered = true;
            }
          }
        }
        if (recovered) {
          await this.store.save(accountId, freezeChats(loaded));
          this.assertEpoch(epoch);
        }
        return loaded;
      });
      this.assertEpoch(epoch);
      this.accountId = accountId;
      this.publish(chats, true);
      this.startReceiving(epoch);
    } catch (error) {
      const mapped = asChatError(error, 'STORAGE_ERROR', 'Не удалось загрузить сохранённые чаты.');
      if (epoch === this.epoch) this.expireSession(mapped.message);
      throw mapped;
    }
  }

  async createChat(phone: string): Promise<Chat> {
    const normalized = normalizePhone(phone);
    const epoch = this.requireSession();
    const existing = this.state.chats.find((chat) => chat.phone === normalized);
    if (existing) return existing;
    try {
      const resolved = await this.gateway.resolveRecipient(normalized);
      this.assertSession(epoch);
      await this.commit(epoch, (chats) => {
        if (!chats.some((chat) => chat.chatId === resolved.chatId)) {
          chats.push(new Chat({ ...resolved, phone: normalized, messages: [] }));
        }
      });
      return this.state.chats.find((chat) => chat.chatId === resolved.chatId)!;
    } catch (error) {
      const mapped = asChatError(error, 'PROVIDER_ERROR', 'Не удалось создать чат.');
      if (epoch === this.epoch) this.publish(this.state.chats, this.state.connected, mapped.message, 'action');
      throw mapped;
    }
  }

  async sendText(chatId: string, text: string): Promise<TextMessage> {
    const epoch = this.requireSession();
    const message = new TextMessage({
      localId: this.options.createId(), chatId, text, timestampMs: this.options.now(),
      direction: 'outgoing', status: MessageStatus.pending,
    });
    message.validate();
    await this.commit(epoch, (chats) => {
      const chat = chats.find((item) => item.chatId === chatId);
      if (!chat) throw new ChatError('VALIDATION_ERROR', 'Сначала выберите чат.');
      chat.addMessageOnce(message);
    });

    let providerMessageId: string | undefined;
    let status: MessageStatus;
    let sendError: ChatError | undefined;
    try {
      providerMessageId = await this.gateway.sendText(chatId, text);
      this.assertSession(epoch);
      status = MessageStatus.accepted;
    } catch (error) {
      this.assertSession(epoch);
      sendError = asChatError(error, 'SEND_UNKNOWN', 'Результат отправки неизвестен. Проверьте переписку перед повторной отправкой.');
      status = ['SEND_REJECTED', 'AUTH_ERROR', 'INSTANCE_NOT_AUTHORIZED', 'VALIDATION_ERROR', 'RECIPIENT_NOT_FOUND'].includes(sendError.code)
        ? MessageStatus.failed : MessageStatus.unknown;
    }
    await this.commit(epoch, (chats) => {
      const stored = chats.find((chat) => chat.chatId === chatId)?.messages.find((item) => item.localId === message.localId);
      if (!stored) throw new ChatError('SESSION_ENDED', 'Подключение завершено.');
      stored.status = status;
      stored.providerMessageId = providerMessageId;
    }, { publishOnStorageFailure: true, errorMessage: sendError?.message });
    return this.state.chats.find((chat) => chat.chatId === chatId)!.messages.find((item) => item.localId === message.localId)!;
  }

  disconnect(): void {
    this.epoch += 1;
    this.accountId = undefined;
    this.receivingPaused = false;
    this.gateway.disconnect();
    this.cancelDelay?.();
    this.publish([], false);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.commits.then(operation);
    this.commits = result.then(() => undefined, () => undefined);
    return result;
  }

  // The queue protects against a reply arriving while a message is being saved.
  private commit(epoch: number, update: (chats: Chat[]) => void, options: { publishOnStorageFailure?: boolean; errorMessage?: string; preserveError?: boolean } = {}): Promise<void> {
    return this.enqueue(async () => {
      this.assertSession(epoch);
      const accountId = this.accountId!;
      const chats = cloneChats(this.state.chats);
      update(chats);
      const snapshot = freezeChats(chats);
      try {
        await this.store.save(accountId, snapshot);
        this.assertSession(epoch);
        const errorMessage = options.preserveError ? this.state.errorMessage : options.errorMessage;
        const errorSource = options.preserveError ? this.errorSource : 'action';
        this.publish(snapshot, true, errorMessage, errorSource);
      } catch (error) {
        this.assertSession(epoch);
        const mapped = asChatError(error, 'STORAGE_ERROR', 'Не удалось сохранить переписку. Проверьте доступность хранилища браузера.');
        this.receivingPaused = true;
        this.publish(options.publishOnStorageFailure ? snapshot : this.state.chats, true, mapped.message, 'action');
        if (!options.publishOnStorageFailure) throw mapped;
      }
    });
  }

  private startReceiving(epoch: number): void {
    void this.receiveLoop(epoch);
  }

  private async receiveLoop(epoch: number): Promise<void> {
    const initialRetryDelay = Math.min(this.options.retryBaseDelayMs, this.options.retryMaxDelayMs);
    let retryDelay = initialRetryDelay;
    while (this.isActive(epoch)) {
      try {
        const notification = await this.gateway.receive();
        if (!this.isActive(epoch)) return;
        if (notification) {
          await this.handleNotification(notification, epoch);
        }
        retryDelay = initialRetryDelay;
        if (this.isActive(epoch) && this.errorSource === 'polling') this.publish(this.state.chats, true);
        if (!notification) await this.delay(this.options.emptyReceiveDelayMs, epoch);
      } catch (error) {
        if (!this.isActive(epoch)) return;
        const mapped = asChatError(error, 'NETWORK_ERROR', 'Не удалось получить сообщения. Повторяем подключение.');
        if (['AUTH_ERROR', 'INSTANCE_NOT_AUTHORIZED'].includes(mapped.code)) {
          this.expireSession(mapped.message);
          return;
        }
        if (!this.state.errorMessage || this.errorSource === 'polling') {
          this.publish(this.state.chats, true, mapped.message, 'polling');
        }
        await this.delay(retryDelay, epoch);
        retryDelay = Math.min(this.options.retryMaxDelayMs, retryDelay * 2);
      }
    }
  }

  private async handleNotification(notification: Notification, epoch: number): Promise<void> {
    if (notification.message) {
      await this.commit(epoch, (chats) => {
        const message = notification.message!;
        let chat = chats.find((item) => item.chatId === message.chatId);
        if (!chat) {
          chat = new Chat({ chatId: message.chatId, phone: notification.senderPhone, title: notification.senderName || notification.senderPhone || message.chatId });
          chats.push(chat);
        }
        chat.addMessageOnce(new TextMessage({ ...message, direction: 'incoming', status: MessageStatus.received }));
      }, { preserveError: true });
    }
    if (!this.isActive(epoch)) return;
    await this.gateway.acknowledge(notification.receiptId);
    this.assertSession(epoch);
  }

  private delay(milliseconds: number, epoch: number): Promise<void> {
    if (!this.isActive(epoch)) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        if (this.cancelDelay === finish) this.cancelDelay = undefined;
        resolve();
      };
      const timer = setTimeout(finish, milliseconds);
      this.cancelDelay = finish;
    });
  }

  private isActive(epoch: number): boolean {
    return epoch === this.epoch && this.state.connected && !this.receivingPaused;
  }

  private requireSession(): number {
    if (!this.state.connected || !this.accountId) throw new ChatError('SESSION_ENDED', 'Подключитесь к Telegram-инстансу.');
    return this.epoch;
  }

  private assertEpoch(epoch: number): void {
    if (epoch !== this.epoch) throw new ChatError('SESSION_ENDED', 'Подключение завершено.');
  }

  private assertSession(epoch: number): void {
    this.assertEpoch(epoch);
    this.requireSession();
  }

  private expireSession(errorMessage: string): void {
    this.disconnect();
    this.publish([], false, errorMessage);
  }

  private publish(chats: readonly Chat[], connected: boolean, errorMessage?: string, errorSource?: 'polling' | 'action'): void {
    this.errorSource = errorMessage ? errorSource : undefined;
    this.state = Object.freeze({ chats: freezeChats(chats), connected, errorMessage });
    for (const listener of [...this.listeners]) listener();
  }
}
