"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { apiFetch, ApiError } from "../../lib/api/client";
import { useI18n } from "../../lib/i18n/I18nContext";
import type { MessageKey } from "../../lib/i18n/messages";
import { Notice } from "../ui/RiskBadge";

type SignedIn = { user: { id: string; role: string; name: string } };
type DemoAccount = { email: string; name: string; role: string; password: string };

/** Only same-site relative paths are honoured as post-login destinations (no open redirect). */
export function safeNext(next: string | null | undefined, role?: string): string {
  if (next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/login")) {
    return next;
  }
  return role === "PATIENT" ? "/glance" : "/patients";
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError || error instanceof Error ? error.message : fallback;
}

export function LoginForm() {
  const { t } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState<DemoAccount[]>([]);

  useEffect(() => {
    fetch("/api/auth/demo-accounts", { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : { accounts: [] }))
      .then((data: { accounts?: DemoAccount[] }) => setDemo(data.accounts ?? []))
      .catch(() => setDemo([]));
  }, []);

  async function signIn(credentials: { email: string; password: string }) {
    setBusy(true);
    setError(null);
    try {
      const { user } = await apiFetch<SignedIn>("/api/auth/login", { method: "POST", body: credentials });
      router.replace(safeNext(params?.get("next"), user.role));
    } catch (caught) {
      setError(messageOf(caught, t("auth.genericError")));
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void signIn({ email, password });
  }

  return (
    <section className="auth-card" aria-labelledby="login-title">
      <h1 id="login-title">{t("auth.signInTitle")}</h1>
      <form onSubmit={onSubmit} className="form-stack" noValidate>
        <div className="field">
          <label htmlFor="login-email">{t("auth.email")}</label>
          <input id="login-email" type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="login-password">{t("auth.password")}</label>
          <input id="login-password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
        </div>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <button type="submit" className="btn btn-block" disabled={busy || !email || !password}>
          {busy ? t("auth.signingIn") : t("auth.signIn")}
        </button>
      </form>
      <p className="auth-switch">
        {t("auth.noAccount")} <Link href="/register">{t("auth.register")}</Link>
      </p>
      {demo.length > 0 ? (
        <section className="demo-accounts" aria-labelledby="demo-title">
          <h2 id="demo-title">{t("auth.demoTitle")}</h2>
          <p className="muted">{t("auth.demoHint")}</p>
          <ul>
            {demo.map((account) => (
              <li key={account.email}>
                <button type="button" className="btn btn-secondary btn-block" disabled={busy} onClick={() => void signIn(account)}>
                  {account.name} · {t(`role.${account.role}` as MessageKey)}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

function PasswordFields({
  password,
  confirm,
  onPassword,
  onConfirm,
  idPrefix,
}: {
  password: string;
  confirm: string;
  onPassword: (value: string) => void;
  onConfirm: (value: string) => void;
  idPrefix: string;
}) {
  const { t } = useI18n();
  return (
    <>
      <div className="field">
        <label htmlFor={`${idPrefix}-password`}>{t("auth.password")}</label>
        <input
          id={`${idPrefix}-password`}
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          aria-describedby={`${idPrefix}-password-hint`}
          value={password}
          onChange={(event) => onPassword(event.target.value)}
        />
        <p className="field-hint" id={`${idPrefix}-password-hint`}>
          {t("auth.passwordHint")}
        </p>
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-confirm`}>{t("auth.confirmPassword")}</label>
        <input id={`${idPrefix}-confirm`} type="password" autoComplete="new-password" required value={confirm} onChange={(event) => onConfirm(event.target.value)} />
      </div>
    </>
  );
}

export function RegisterForm() {
  const { t } = useI18n();
  const router = useRouter();
  const [form, setForm] = useState({ clinicCode: "", name: "", email: "", dateOfBirth: "", password: "", confirm: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [key]: value }));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (form.password !== form.confirm) {
      setError(t("auth.passwordMismatch"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { confirm: _confirm, ...payload } = form;
      void _confirm;
      await apiFetch<SignedIn>("/api/auth/register", { method: "POST", body: payload });
      router.replace("/glance");
    } catch (caught) {
      setError(messageOf(caught, t("auth.genericError")));
      setBusy(false);
    }
  }

  return (
    <section className="auth-card" aria-labelledby="register-title">
      <h1 id="register-title">{t("auth.registerTitle")}</h1>
      <form onSubmit={(event) => void onSubmit(event)} className="form-stack" noValidate>
        <div className="field">
          <label htmlFor="register-code">{t("auth.clinicCode")}</label>
          <input id="register-code" required aria-describedby="register-code-hint" value={form.clinicCode} onChange={(event) => set("clinicCode")(event.target.value)} />
          <p className="field-hint" id="register-code-hint">
            {t("auth.clinicCodeHint")}
          </p>
        </div>
        <div className="field">
          <label htmlFor="register-name">{t("auth.fullName")}</label>
          <input id="register-name" autoComplete="name" required value={form.name} onChange={(event) => set("name")(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="register-email">{t("auth.email")}</label>
          <input id="register-email" type="email" autoComplete="email" required value={form.email} onChange={(event) => set("email")(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="register-dob">{t("auth.dob")}</label>
          <input id="register-dob" type="date" autoComplete="bday" required value={form.dateOfBirth} onChange={(event) => set("dateOfBirth")(event.target.value)} />
        </div>
        <PasswordFields idPrefix="register" password={form.password} confirm={form.confirm} onPassword={set("password")} onConfirm={set("confirm")} />
        {error ? <Notice tone="error">{error}</Notice> : null}
        <button type="submit" className="btn btn-block" disabled={busy}>
          {busy ? t("auth.creating") : t("auth.create")}
        </button>
      </form>
      <p className="auth-switch">
        <Link href="/login">{t("auth.haveAccount")}</Link>
      </p>
    </section>
  );
}

export function ActivateForm() {
  const { t } = useI18n();
  const router = useRouter();
  const token = useSearchParams()?.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setError(t("auth.passwordMismatch"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { user } = await apiFetch<SignedIn>("/api/auth/activate", { method: "POST", body: { token, password } });
      router.replace(safeNext(null, user.role));
    } catch (caught) {
      setError(messageOf(caught, t("auth.genericError")));
      setBusy(false);
    }
  }

  return (
    <section className="auth-card" aria-labelledby="activate-title">
      <h1 id="activate-title">{t("auth.activateTitle")}</h1>
      {!token ? (
        <Notice tone="error">{t("auth.activateMissing")}</Notice>
      ) : (
        <form onSubmit={(event) => void onSubmit(event)} className="form-stack" noValidate>
          <PasswordFields idPrefix="activate" password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} />
          {error ? <Notice tone="error">{error}</Notice> : null}
          <button type="submit" className="btn btn-block" disabled={busy}>
            {busy ? t("auth.creating") : t("auth.activate")}
          </button>
        </form>
      )}
    </section>
  );
}
