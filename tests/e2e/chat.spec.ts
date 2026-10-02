import { expect, test, type Page } from '@playwright/test'

const INSTANCE = '4100000000'
const TOKEN = 'test-token-not-a-real-secret'
const PHONE = '79991234567'

function notification(receiptId: number, idMessage: string, text: string, chatId = '10000000', name = 'Анна') {
  return { receiptId, body: {
    typeWebhook: 'incomingMessageReceived', instanceData: { idInstance: Number(INSTANCE), typeInstance: 'telegram' },
    timestamp: 1_700_000_000, idMessage,
    senderData: { chatId, chatType: 'user', chatName: name, senderPhoneNumber: Number(PHONE) },
    messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: text } },
  } }
}

async function mockGreenApi(page: Page) {
  const queue: unknown[] = []
  const sent: { chatId: string; message: string }[] = []
  const acknowledged: string[] = []
  let hidden = false
  let failSend = false
  let receives = 0
  let savedAtAcknowledgement = true
  await page.route('https://*.api.green-api.com/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const operation = url.pathname.split('/')[2]
    const fulfill = async (value: unknown, status = 200) => {
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) }).catch(() => {})
    }
    if (request.method() === 'OPTIONS') { await fulfill({}); return }
    switch (operation) {
      case 'getStateInstance': await fulfill({ stateInstance: 'authorized' }); break
      case 'checkAccount': await fulfill(hidden ? { exist: false, chatId: '' } : { exist: true, chatId: '10000000' }); break
      case 'sendMessage':
        sent.push(request.postDataJSON())
        if (failSend) await route.abort('failed')
        else await fulfill({ idMessage: `outgoing-${sent.length}` })
        break
      case 'receiveNotification':
        receives++
        if (!queue.length) await new Promise(resolve => setTimeout(resolve, 150))
        await fulfill(queue[0] ?? null)
        break
      case 'deleteNotification': {
        const receipt = url.pathname.split('/').at(-1)!
        const current = queue[0] as ReturnType<typeof notification> | undefined
        if (current?.body?.messageData?.typeMessage === 'textMessage' && current.body.senderData.chatType === 'user') {
          const persisted = await page.evaluate(id => localStorage.getItem(`telegram-chat:v1:${id}`), INSTANCE)
          savedAtAcknowledgement &&= Boolean(persisted?.includes(current.body.idMessage))
        }
        acknowledged.push(receipt)
        if (String(current?.receiptId) === receipt) queue.shift()
        await fulfill({ result: true })
        break
      }
      default: await fulfill({ error: 'unmocked operation' }, 400)
    }
  })
  return {
    queue, sent, acknowledged,
    setHidden: () => { hidden = true }, setFailSend: () => { failSend = true },
    receives: () => receives, savedAtAcknowledgement: () => savedAtAcknowledgement,
  }
}

async function login(page: Page) {
  await page.getByLabel('ID инстанса').fill(INSTANCE)
  await page.getByLabel('Токен API', { exact: true }).fill(TOKEN)
  await page.getByRole('button', { name: 'Открыть чат' }).click()
  await expect(page.getByText('Подключено', { exact: true })).toBeVisible()
}
async function createChat(page: Page) {
  await page.getByRole('button', { name: 'Новый чат', exact: true }).first().click()
  await page.getByLabel('Номер телефона', { exact: true }).fill('+7 (999) 123-45-67')
  await page.getByRole('button', { name: 'Начать общение' }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await expect(page.getByLabel('Сообщение', { exact: true })).toBeVisible()
}

test('send, receive, deduplicate and restore history without storing credentials', async ({ page }, testInfo) => {
  const api = await mockGreenApi(page)
  await page.goto('/')
  if (testInfo.project.name === 'chromium') await page.screenshot({ path: 'test-results/login.png', fullPage: true })
  await login(page)
  await createChat(page)
  await page.getByLabel('Сообщение', { exact: true }).fill('Привет!\nКак дела?')
  await page.getByRole('button', { name: 'Отправить сообщение' }).click()
  await expect(page.getByText('Принято', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Сообщение', { exact: true })).toHaveValue('')
  expect(api.sent).toEqual([{ chatId: '10000000', message: 'Привет!\nКак дела?' }])

  api.queue.push(notification(1, 'incoming-1', 'Всё хорошо!'), notification(2, 'incoming-1', 'Всё хорошо!'))
  await expect(page.locator('.message-text').filter({ hasText: 'Всё хорошо!' })).toHaveCount(1)
  await expect.poll(() => api.acknowledged.length).toBe(2)
  expect(api.savedAtAcknowledgement()).toBe(true)
  const storage = await page.evaluate(() => JSON.stringify(localStorage))
  expect(storage).not.toContain(TOKEN)
  expect(storage).not.toContain('apiTokenInstance')
  if (testInfo.project.name === 'chromium') await page.screenshot({ path: 'test-results/chat.png', fullPage: true })

  await page.reload()
  await expect(page.getByLabel('Токен API', { exact: true })).toHaveValue('')
  await login(page)
  await expect(page.locator('.message-text')).toHaveCount(2)
  await page.getByRole('button', { name: 'Отключиться' }).click()
  await expect(page.getByLabel('Токен API', { exact: true })).toHaveValue('')
})

test('hidden phone error, text length and uncertain sends preserve the draft', async ({ page }) => {
  const api = await mockGreenApi(page)
  await page.goto('/')
  await login(page)
  api.setHidden()
  await page.getByRole('button', { name: 'Новый чат', exact: true }).first().click()
  await page.getByLabel('Номер телефона', { exact: true }).fill(`+${PHONE}`)
  await page.getByRole('button', { name: 'Начать общение' }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Номер не найден или скрыт')
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click()
  // A private incoming text creates its own chat even when phone lookup is unavailable.
  api.queue.push(notification(10, 'first', 'Здравствуйте'))
  await expect(page.getByLabel('Сообщение', { exact: true })).toBeVisible()
  await page.getByLabel('Сообщение', { exact: true }).fill('x'.repeat(4097))
  await expect(page.getByRole('button', { name: 'Отправить сообщение' })).toBeDisabled()
  expect(api.sent).toHaveLength(0)
  api.setFailSend()
  await page.getByLabel('Сообщение', { exact: true }).fill('Проверка таймаута')
  await page.getByRole('button', { name: 'Отправить сообщение' }).click()
  await expect(page.getByText('Результат неизвестен', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Сообщение', { exact: true })).toHaveValue('Проверка таймаута')
  expect(api.sent).toHaveLength(1)
})

test('unsupported notifications advance the queue and unknown private chats appear', async ({ page }) => {
  const api = await mockGreenApi(page)
  await page.goto('/')
  await login(page)
  api.queue.push({ receiptId: 20, body: { typeWebhook: 'outgoingMessageStatus' } }, notification(21, 'url-1', 'https://example.org', '20000000', 'Мария'))
  await expect(page.getByRole('heading', { name: 'Мария', exact: true })).toBeVisible()
  await expect(page.locator('.message-text')).toHaveText('https://example.org')
  await expect.poll(() => api.acknowledged.length).toBe(2)
})

test('storage failure does not acknowledge or display an unsaved incoming message', async ({ page }) => {
  const api = await mockGreenApi(page)
  await page.goto('/')
  await login(page)
  await createChat(page)
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith('telegram-chat:')) throw new DOMException('Full', 'QuotaExceededError')
      original.call(this, key, value)
    }
  })
  api.queue.push(notification(30, 'unsaved', 'Нельзя терять этот ответ'))
  await expect(page.getByRole('alert')).toContainText('Не удалось сохранить переписку')
  await expect(page.locator('.message-text')).toHaveCount(0)
  expect(api.acknowledged).toHaveLength(0)
  const requests = api.receives()
  await expect.poll(() => api.receives()).toBe(requests)
})

test('mobile navigation preserves an unsent draft and remains within viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockGreenApi(page)
  await page.goto('/')
  await login(page)
  await createChat(page)
  await page.getByLabel('Сообщение', { exact: true }).fill('Черновик')
  await page.getByRole('button', { name: 'Назад к чатам' }).click()
  await expect(page.getByLabel('Сообщение', { exact: true })).not.toBeVisible()
  await page.locator('.chat-item').click()
  await expect(page.getByLabel('Сообщение', { exact: true })).toHaveValue('Черновик')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('mobile chat list shows a storage error when the first incoming chat cannot be saved', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const api = await mockGreenApi(page)
  await page.goto('/')
  await login(page)
  await page.evaluate(() => {
    Storage.prototype.setItem = () => { throw new DOMException('Full', 'QuotaExceededError') }
  })
  api.queue.push(notification(40, 'first-unsaved', 'Первый ответ'))
  await expect(page.getByRole('alert')).toContainText('Не удалось сохранить переписку')
  await expect(page.getByRole('alert')).toContainText('подключитесь заново')
  expect(api.acknowledged).toHaveLength(0)
})
