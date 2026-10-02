import { afterEach, describe, expect, it, vi } from 'vitest'
import { GreenApiTelegramAdapter } from '../../src/adapters/GreenApiTelegramAdapter'

const credentials = { apiUrl: 'https://4100.api.green-api.com', idInstance: '4100000000', apiTokenInstance: 'test-token-not-a-real-secret' }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const incoming = (overrides: Record<string, unknown> = {}) => ({
  receiptId: 123,
  body: {
    typeWebhook: 'incomingMessageReceived', instanceData: { idInstance: 4100000000, typeInstance: 'telegram' },
    timestamp: 1_700_000_000, idMessage: 'message-1',
    senderData: { chatId: '10000000', chatType: 'user', chatName: 'Анна', senderPhoneNumber: 79991234567 },
    messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'Привет!' } }, ...overrides,
  },
})
const adapters: GreenApiTelegramAdapter[] = []
async function setup(responses: Response[]) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ stateInstance: 'authorized' }))
  for (const response of responses) fetchMock.mockResolvedValueOnce(response)
  const adapter = new GreenApiTelegramAdapter(fetchMock)
  adapters.push(adapter)
  await adapter.connect(credentials)
  return { adapter, fetchMock }
}
afterEach(() => { for (const adapter of adapters.splice(0)) adapter.disconnect(); vi.useRealTimers() })

describe('GREEN-API Telegram contract', () => {
  it('uses canonical chat IDs and exact request bodies without cookies', async () => {
    const { adapter, fetchMock } = await setup([json({ exist: true, chatId: '10000000' }), json({ idMessage: '42' })])
    expect((await adapter.resolveRecipient('79991234567')).chatId).toBe('10000000')
    expect(await adapter.sendText('10000000', ' Привет\nмир ')).toBe('42')
    expect(fetchMock.mock.calls[1][0]).toContain('/checkAccount/')
    expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string)).toEqual({ phoneNumber: 79991234567 })
    expect(JSON.parse(fetchMock.mock.calls[2][1]!.body as string)).toEqual({ chatId: '10000000', message: ' Привет\nмир ' })
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error' })
  })

  it('normalizes ordinary text, sender metadata, receipt and seconds to milliseconds', async () => {
    const { adapter, fetchMock } = await setup([json(incoming())])
    expect(await adapter.receive()).toMatchObject({
      receiptId: '123', senderName: 'Анна', senderPhone: '79991234567',
      message: { chatId: '10000000', providerMessageId: 'message-1', text: 'Привет!', timestampMs: 1_700_000_000_000, status: 'received', direction: 'incoming' },
    })
    expect(fetchMock.mock.calls[1][0]).toContain('?receiveTimeout=30')
  })

  it('normalizes URL text and acknowledges using DELETE and exact receipt', async () => {
    const { adapter, fetchMock } = await setup([
      json(incoming({ messageData: { typeMessage: 'extendedTextMessage', extendedTextMessageData: { text: 'https://example.org' } } })),
      json({ result: true }),
    ])
    expect((await adapter.receive())?.message?.text).toBe('https://example.org')
    await adapter.acknowledge('123')
    expect(fetchMock.mock.calls[2][0]).toContain('/deleteNotification/test-token-not-a-real-secret/123')
    expect(fetchMock.mock.calls[2][1]?.method).toBe('DELETE')
  })

  it.each([json(null), new Response('')])('normalizes an empty receive response', async response => {
    const { adapter } = await setup([response])
    expect(await adapter.receive()).toBeNull()
  })

  it('returns receipt only for groups and media so the queue can advance', async () => {
    const { adapter } = await setup([
      json(incoming({ senderData: { chatId: '-1000', chatType: 'supergroup' } })),
      json(incoming({ messageData: { typeMessage: 'imageMessage' } })),
    ])
    expect(await adapter.receive()).toEqual({ receiptId: '123' })
    expect(await adapter.receive()).toEqual({ receiptId: '123' })
  })

  it('does not claim a hidden number lacks Telegram', async () => {
    const { adapter } = await setup([json({ exist: false, chatId: '' })])
    await expect(adapter.resolveRecipient('79991234567')).rejects.toMatchObject({ code: 'RECIPIENT_NOT_FOUND', message: 'Номер не найден или скрыт настройками приватности.' })
  })

  it('recognizes error bodies returned with HTTP 200', async () => {
    const { adapter } = await setup([json({ status: false, data: { status: 'fail', reason: 'rate_limit_exceeded' } })])
    await expect(adapter.resolveRecipient('79991234567')).rejects.toMatchObject({ code: 'RATE_LIMITED' })
  })

  it('distinguishes rejected sends from uncertain HTTP 5xx results', async () => {
    const { adapter } = await setup([json({ error: credentials.apiTokenInstance }, 400), json({}, 503), json({})])
    await expect(adapter.sendText('10000000', 'A')).rejects.toMatchObject({ code: 'SEND_REJECTED' })
    await expect(adapter.sendText('10000000', 'B')).rejects.toMatchObject({ code: 'SEND_UNKNOWN' })
    await expect(adapter.sendText('10000000', 'C')).rejects.toMatchObject({ code: 'SEND_UNKNOWN' })
  })

  it('does not leak provider payloads or request URLs through errors', async () => {
    const { adapter, fetchMock } = await setup([])
    fetchMock.mockRejectedValueOnce(new Error(credentials.apiTokenInstance))
    await expect(adapter.receive()).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    fetchMock.mockResolvedValueOnce(json({ error: credentials.apiTokenInstance }, 403))
    await expect(adapter.receive()).rejects.toMatchObject({ code: 'AUTH_ERROR', message: expect.not.stringContaining(credentials.apiTokenInstance) })
  })

  it('aborts in-flight fetches and rejects late responses after disconnect', async () => {
    const { adapter, fetchMock } = await setup([])
    let complete!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const receiving = adapter.receive()
    const assertion = expect(receiving).rejects.toMatchObject({ code: 'REQUEST_ABORTED' })
    const signal = fetchMock.mock.calls[1][1]!.signal!
    adapter.disconnect()
    expect(signal.aborted).toBe(true)
    complete(json(incoming()))
    await assertion
  })

  it('times out sends as unknown without retrying', async () => {
    const { adapter, fetchMock } = await setup([])
    vi.useFakeTimers()
    fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    const sending = adapter.sendText('10000000', 'A')
    const assertion = expect(sending).rejects.toMatchObject({ code: 'SEND_UNKNOWN' })
    await vi.advanceTimersByTimeAsync(45_000)
    await assertion
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('accepts an already removed receipt but not a malformed acknowledgement', async () => {
    const { adapter } = await setup([json({ result: false, reason: 'already deleted' }), json({})])
    await adapter.acknowledge('123')
    await expect(adapter.acknowledge('123')).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
  })

  it('rejects non-Telegram and another-instance notifications without acknowledging them', async () => {
    const { adapter } = await setup([
      json(incoming({ instanceData: { typeInstance: 'max' } })),
      json(incoming({ instanceData: { idInstance: 123, typeInstance: 'telegram' } })),
    ])
    await expect(adapter.receive()).rejects.toMatchObject({ code: 'INSTANCE_NOT_AUTHORIZED' })
    await expect(adapter.receive()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
  })

  it('does not discard malformed supported text as an unsupported event', async () => {
    const { adapter } = await setup([
      json(incoming({ messageData: { typeMessage: 'textMessage' } })),
      json(incoming({ timestamp: 1e100 })),
      json(incoming({ senderData: { chatType: 'user' } })),
    ])
    await expect(adapter.receive()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
    await expect(adapter.receive()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
    await expect(adapter.receive()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
  })

  it('rejects unsafe hosts and unauthorized instances', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ stateInstance: 'notAuthorized' }))
    const adapter = new GreenApiTelegramAdapter(fetchMock)
    adapters.push(adapter)
    await expect(adapter.connect({ ...credentials, apiUrl: 'https://example.org' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(adapter.connect(credentials)).rejects.toMatchObject({ code: 'INSTANCE_NOT_AUTHORIZED' })
  })
})
