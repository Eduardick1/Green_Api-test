import { useState, type FormEvent } from "react";
import type { Credentials } from "../application/contracts";
import { ErrorNotice, Icon, errorText } from "./shared";

const DEFAULT_API_URL = "https://4100.api.green-api.com";

export function ConnectionForm({
  onConnect,
  applicationError,
}: {
  onConnect: (credentials: Credentials) => Promise<void>;
  applicationError?: string;
}) {
  const [idInstance, setIdInstance] = useState("");
  const [apiTokenInstance, setApiTokenInstance] = useState("");
  const [apiUrl, setApiUrl] = useState(DEFAULT_API_URL);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (connecting) return;
    setConnecting(true);
    setError(undefined);
    try {
      await onConnect({
        idInstance: idInstance.trim(),
        apiTokenInstance: apiTokenInstance.trim(),
        apiUrl: apiUrl.trim(),
      });
      setIdInstance("");
      setApiTokenInstance("");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setConnecting(false);
    }
  }

  return (
    <main className="connection-page">
      <div className="connection-brand">
        <span className="brand-mark">
          <Icon name="plane" />
        </span>
        <span>
          Telegram<span className="brand-caption">через GREEN-API</span>
        </span>
      </div>
      <section className="connection-card" aria-labelledby="connection-title">
        <div className="connection-art" aria-hidden="true">
          <div className="art-orbit orbit-one" />
          <div className="art-orbit orbit-two" />
          <div className="art-plane">
            <Icon name="plane" />
          </div>
          <span className="art-dot dot-one" />
          <span className="art-dot dot-two" />
        </div>
        <div className="connection-intro">
          <span className="eyebrow">ВАШИ СООБЩЕНИЯ, БЛИЖЕ</span>
          <h1 id="connection-title">Подключитесь к Telegram</h1>
          <p>Введите данные вашего инстанса GREEN-API.</p>
        </div>
        <form
          onSubmit={(event) => void handleSubmit(event)}
          className="connection-form"
        >
          <label className="field-label" htmlFor="instance-id">
            ID инстанса
          </label>
          <input
            id="instance-id"
            name="idInstance"
            className="text-input"
            inputMode="numeric"
            autoComplete="off"
            value={idInstance}
            onChange={(event) => setIdInstance(event.target.value)}
            placeholder="Введите idInstance"
            required
            disabled={connecting}
          />
          <label className="field-label" htmlFor="instance-token">
            Токен API
          </label>
          <input
            id="instance-token"
            name="apiTokenInstance"
            className="text-input"
            type="password"
            autoComplete="off"
            value={apiTokenInstance}
            onChange={(event) => setApiTokenInstance(event.target.value)}
            placeholder="Введите apiTokenInstance"
            required
            disabled={connecting}
          />
          <details className="connection-settings">
            <summary>Настройки подключения</summary>
            <label className="field-label" htmlFor="api-url">
              Адрес API из личного кабинета
            </label>
            <input
              id="api-url"
              className="text-input"
              type="url"
              value={apiUrl}
              onChange={(event) => setApiUrl(event.target.value)}
              required
              disabled={connecting}
            />
          </details>
          {(error || applicationError) && (
            <ErrorNotice>{error || applicationError}</ErrorNotice>
          )}
          <button
            className="primary-button connection-submit"
            type="submit"
            disabled={connecting}
          >
            {connecting ? (
              <>
                <span className="spinner" />
                Подключение…
              </>
            ) : (
              <>
                Открыть чат
                <Icon name="plane" />
              </>
            )}
          </button>
          <div className="credential-note">
            <Icon name="lock" />
            <span>
              Токен используется только в этой сессии и не сохраняется в
              браузере.
            </span>
          </div>
        </form>
      </section>
      <aside className="setup-note">
        <strong>Перед подключением</strong>
        <p>
          Авторизуйте Telegram-инстанс в личном кабинете GREEN-API. <br />{" "}
          Включите входящие уведомления и оставьте поле Webhook URL пустым.
        </p>
      </aside>
    </main>
  );
}
