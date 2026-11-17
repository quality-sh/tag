// The login page: the shared viewer password, an OIDC provider, or both.
import { useState } from "react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useAtom, useAtomValue } from "@effect/atom-react/Hooks";
import { Cmd, LoginShell, PillInput, Topbar } from "@quality-sh/tag-ui";
import type { Session } from "../client.ts";
import { OIDC_START_URL, loginErrorAtom, loginFn } from "../state.ts";

const oidcMessage = (error: string, provider: string) => {
  if (error === "domain") return "That account's email domain is not allowed to sign in here.";
  if (error === "unverified")
    return `${provider} did not return a verified email for that account.`;
  return `Signing in with ${provider} did not finish. Try again.`;
};

const ledeOf = (password: boolean, provider: string | undefined) => {
  if (provider === undefined) return "Enter the shared viewer password.";
  if (!password) return `Sign in with your ${provider} account.`;
  return `Sign in with ${provider}, or enter the shared viewer password.`;
};

export function LoginPage({ session }: { session: Session }) {
  const [pw, setPw] = useState("");
  const [login, runLogin] = useAtom(loginFn);
  const oidcError = useAtomValue(loginErrorAtom);
  const provider = session.oidcProvider;
  // A server from before OIDC sends no passwordLogin; it only had the password.
  const password = session.passwordLogin ?? true;
  const startOidc = () => location.assign(OIDC_START_URL);
  const rejected = AsyncResult.isSuccess(login) && login.value === false;
  const error = rejected
    ? "That password was not accepted."
    : oidcError !== null && provider !== undefined
      ? oidcMessage(oidcError, provider)
      : undefined;
  return (
    <>
      <Topbar wordmark="TAG" />
      <LoginShell
        eyebrow="Test results from CI, in one place"
        title="Sign in to TAG."
        lede={ledeOf(password, provider)}
        onSubmit={() => (password ? runLogin(pw) : startOidc())}
        error={error}
      >
        {password && (
          <>
            <PillInput
              type="password"
              value={pw}
              onChange={setPw}
              placeholder="viewer password"
              label="Viewer password"
              autoFocus
            />
            <Cmd type="submit" primary disabled={AsyncResult.isWaiting(login)}>
              sign in
            </Cmd>
          </>
        )}
        {provider !== undefined && (
          <Cmd
            type={password ? "button" : "submit"}
            primary={!password}
            {...(password ? { onClick: startOidc } : {})}
          >
            Sign in with {provider}
          </Cmd>
        )}
      </LoginShell>
    </>
  );
}
