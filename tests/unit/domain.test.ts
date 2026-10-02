import { describe, expect, it } from 'vitest';
import { Chat, ChatError, MessageStatus, TextMessage, normalizePhone } from '../../src/domain/models';

function message(overrides: Partial<TextMessage> = {}): TextMessage {
  return new TextMessage({ localId: 'local-1', chatId: '123', text: 'Привет', timestampMs: 1, direction: 'outgoing', status: MessageStatus.pending, ...overrides });
}

describe('Domain business rules', () => {
  it('rejects blank outgoing text and text over 4096 characters', () => {
    expect(() => message({ text: ' \n ' }).validate()).toThrow(ChatError);
    expect(() => message({ text: 'a'.repeat(4097) }).validate()).toThrow('4096');
    expect(() => message({ text: 'a'.repeat(4096) }).validate()).not.toThrow();
    expect(() => message({ text: 'https://example.com' }).validate()).not.toThrow();
  });

  it('deduplicates provider IDs within a chat and local IDs before sending', () => {
    const chat = new Chat({ chatId: '123', title: 'Чат' });
    expect(chat.addMessageOnce(message())).toBe(true);
    expect(chat.addMessageOnce(message())).toBe(false);
    expect(chat.addMessageOnce(message({ localId: 'local-2', providerMessageId: 'provider-1' }))).toBe(true);
    expect(chat.addMessageOnce(message({ localId: 'local-3', providerMessageId: 'provider-1' }))).toBe(false);
    expect(chat.messages).toHaveLength(2);
    const another = new Chat({ chatId: '456', title: 'Другой чат' });
    expect(another.addMessageOnce(message({ chatId: '456', providerMessageId: 'provider-1' }))).toBe(true);
    expect(() => chat.addMessageOnce(message({ chatId: '456' }))).toThrow(ChatError);
  });

  it('normalizes international formatting without adding a country code', () => {
    expect(normalizePhone('+7 (999) 123-45-67')).toBe('79991234567');
    expect(normalizePhone('1 202 555 0123')).toBe('12025550123');
    for (const phone of ['', 'abc79991234567', '+12', '0123456789', '1234567890123456']) {
      expect(() => normalizePhone(phone)).toThrow(ChatError);
    }
  });
});
