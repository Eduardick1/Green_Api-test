import { useEffect, useRef, useState, type FormEvent } from "react";
import { ErrorNotice, Icon, errorText } from "./shared";

export function NewChatDialog({
  onCreate,
  onClose,
}: {
  onCreate: (phone: string) => Promise<void>;
  onClose: () => void;
}) {
  const [phone, setPhone] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating) return;
    setCreating(true);
    setError(undefined);
    try {
      await onCreate(phone);
      onClose();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setCreating(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="new-chat-dialog"
      aria-labelledby="new-chat-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!creating) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !creating) onClose();
      }}
    >
      <div className="dialog-heading">
        <span className="dialog-icon">
          <Icon name="chat" />
        </span>
        <button
          type="button"
          className="icon-button"
          aria-label="Закрыть"
          onClick={onClose}
          disabled={creating}
        >
          <Icon name="close" />
        </button>
      </div>
      <h2 id="new-chat-title">Новый чат</h2>
      <p>
        Введите номер телефона получателя
        <br />в международном формате.
      </p>
      <form onSubmit={(event) => void handleSubmit(event)}>
        <label className="field-label" htmlFor="recipient-phone">
          Номер телефона
        </label>
        <input
          id="recipient-phone"
          className="text-input"
          type="tel"
          autoComplete="tel"
          placeholder="+7 999 123-45-67"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          required
          autoFocus
          disabled={creating}
        />
        <span className="field-hint">
          Пользователь должен быть доступен в Telegram.
        </span>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <button className="primary-button" type="submit" disabled={creating}>
          {creating ? (
            <>
              <span className="spinner" />
              Поиск…
            </>
          ) : (
            "Начать общение"
          )}
        </button>
      </form>
    </dialog>
  );
}

