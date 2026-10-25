// The login page: the shared viewer password.
import { useState } from "react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useAtom } from "@effect/atom-react/Hooks";
import { Cmd, LoginShell, PillInput, Topbar } from "@quality-sh/tag-ui";
import { loginFn } from "../state.ts";

export function LoginPage() {
  const [pw, setPw] = useState("");
  const [login, runLogin] = useAtom(loginFn);
  const rejected = AsyncResult.isSuccess(login) && login.value === false;
  return (
    <>
      <Topbar wordmark="TAG" />
      <LoginShell
        eyebrow="Test results from CI, in one place"
        title="Sign in to TAG."
        lede="Enter the shared viewer password."
        onSubmit={() => runLogin(pw)}
        error={rejected ? "That password was not accepted." : undefined}
      >
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
      </LoginShell>
    </>
  );
}
