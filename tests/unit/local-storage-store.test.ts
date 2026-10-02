import { describe, expect, it, vi } from 'vitest'
import { LocalStorageChatStore } from '../../src/infrastructure/LocalStorageChatStore'
import { Chat, MessageStatus, TextMessage } from '../../src/domain/models'

function setup() {
  const data = new Map<string, string>()
  const storage = { getItem: vi.fn((key: string) => data.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { data.set(key, value) }) }
  return { data, storage, store: new LocalStorageChatStore(storage) }
}
function chat() {
  return new Chat({ chatId: '1', title: 'Анна', phone: '79991234567', messages: [new TextMessage({
    localId: 'local1', chatId: '1', text: 'Привет', timestampMs: 1000, direction: 'outgoing', status: MessageStatus.accepted, providerMessageId: 'remote1',
  })] })
}

describe('LocalStorageChatStore', () => {
  it('restores entity behavior after serialization and isolates instance histories', async () => {
    const { store, data } = setup()
    await store.save('100', [chat()])
    expect(data.has('telegram-chat:v1:100')).toBe(true)
    const loaded = await store.load('100')
    expect(loaded[0]).toBeInstanceOf(Chat)
    expect(loaded[0].messages[0]).toBeInstanceOf(TextMessage)
    expect(loaded[0].messages[0].text).toBe('Привет')
    expect(await store.load('200')).toEqual([])
  })

  it('serializes only the approved schema, never attached credential properties', async () => {
    const { store, data } = setup()
    const record = Object.assign(chat(), { apiTokenInstance: 'private-value', credentials: { idInstance: '100' } })
    Object.assign(record.messages[0], { secret: 'private-value' })
    await store.save('100', [record])
    expect(data.get('telegram-chat:v1:100')).not.toContain('private-value')
    expect(data.get('telegram-chat:v1:100')).not.toContain('credentials')
  })

  it('leaves corrupted history intact and surfaces a storage error', async () => {
    const { store, data, storage } = setup()
    data.set('telegram-chat:v1:100', '{broken')
    await expect(store.load('100')).rejects.toMatchObject({ code: 'STORAGE_ERROR' })
    expect(data.get('telegram-chat:v1:100')).toBe('{broken')
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('rejects structurally invalid or unsupported history instead of silently replacing it', async () => {
    const { store, data } = setup()
    data.set('telegram-chat:v1:100', JSON.stringify({ version: 2, chats: [] }))
    await expect(store.load('100')).rejects.toMatchObject({ code: 'STORAGE_ERROR' })
    data.set('telegram-chat:v1:100', JSON.stringify({ version: 1, chats: [{ chatId: '1', title: 'A', messages: [{ text: 1 }] }] }))
    await expect(store.load('100')).rejects.toMatchObject({ code: 'STORAGE_ERROR' })
  })

  it('maps unavailable storage and quota errors into credential-free errors', async () => {
    const { store, storage } = setup()
    storage.getItem.mockImplementationOnce(() => { throw new Error('private-value') })
    await expect(store.load('100')).rejects.toMatchObject({ code: 'STORAGE_ERROR', message: expect.not.stringContaining('private-value') })
    storage.setItem.mockImplementationOnce(() => { throw new Error('QuotaExceededError') })
    await expect(store.save('100', [chat()])).rejects.toMatchObject({ code: 'STORAGE_ERROR' })
  })
})
