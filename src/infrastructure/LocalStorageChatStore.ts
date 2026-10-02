import type { ChatStore } from '../application/contracts';
import { Chat, ChatError, MessageStatus, TextMessage } from '../domain/models';

type StorageAccess = Pick<Storage, 'getItem' | 'setItem'>;
type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

export class LocalStorageChatStore implements ChatStore {
  constructor(private readonly storage?: StorageAccess) {}

  async load(accountId: string): Promise<Chat[]> {
    try {
      const raw = this.getStorage().getItem(this.key(accountId));
      if (raw === null) return [];

      const history: unknown = JSON.parse(raw);
      if (!isRecord(history) || history.version !== 1 || !Array.isArray(history.chats)) {
        throw new Error('Invalid history');
      }

      const chats = history.chats.map((chat: unknown) => this.hydrateChat(chat));
      const chatIds = new Set(chats.map(chat => chat.chatId));
      if (chatIds.size !== chats.length) {
        throw new Error('Duplicate chats');
      }
      return chats;
    } catch {
      throw new ChatError('STORAGE_ERROR', 'Не удалось прочитать локальную историю. Проверьте доступ к хранилищу браузера; повреждённые данные не перезаписаны.');
    }
  }

  async save(accountId: string, chats: readonly Chat[]): Promise<void> {
    try {
      // Explicit fields keep credentials and other session data out of history.
      const history = {
        version: 1,
        chats: chats.map(chat => ({
          chatId: chat.chatId,
          phone: chat.phone,
          title: chat.title,
          messages: chat.messages.map(message => ({
            localId: message.localId,
            providerMessageId: message.providerMessageId,
            chatId: message.chatId,
            text: message.text,
            timestampMs: message.timestampMs,
            direction: message.direction,
            status: message.status,
          })),
        })),
      };
      this.getStorage().setItem(this.key(accountId), JSON.stringify(history));
    } catch {
      throw new ChatError('STORAGE_ERROR', 'Не удалось сохранить переписку. Проверьте свободное место и доступ к хранилищу браузера, затем отключитесь и подключитесь заново.');
    }
  }

  private key(accountId: string): string {
    if (!/^\d+$/.test(accountId)) throw new Error('Invalid account');
    return `telegram-chat:v1:${accountId}`;
  }

  private getStorage(): StorageAccess {
    return this.storage ?? globalThis.localStorage;
  }

  private hydrateChat(value: unknown): Chat {
    if (
      !isRecord(value) ||
      !isString(value.chatId) ||
      !isString(value.title) ||
      !optionalString(value.phone) ||
      !Array.isArray(value.messages)
    ) {
      throw new Error('Invalid chat');
    }

    const chatId = value.chatId;
    const messages = value.messages.map((message: unknown) => {
      if (
        !isRecord(message) ||
        !isString(message.localId) ||
        message.chatId !== chatId ||
        typeof message.text !== 'string' ||
        typeof message.timestampMs !== 'number' ||
        !Number.isFinite(message.timestampMs) ||
        Math.abs(message.timestampMs) > 8.64e15 ||
        !optionalString(message.providerMessageId) ||
        (message.direction !== 'incoming' && message.direction !== 'outgoing') ||
        !Object.values(MessageStatus).includes(message.status as MessageStatus)
      ) {
        throw new Error('Invalid message');
      }
      return new TextMessage({
        localId: message.localId,
        providerMessageId: message.providerMessageId,
        chatId,
        text: message.text,
        timestampMs: message.timestampMs,
        direction: message.direction,
        status: message.status as MessageStatus,
      });
    });
    return new Chat({ chatId, phone: value.phone, title: value.title, messages });
  }
}
