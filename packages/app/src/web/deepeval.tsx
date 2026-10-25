// The DeepEval view, rendered from its spec. The same spec could come from a file or an API.
import { Message } from "@quality-sh/tag-ui";
import type { ReportDetail } from "./client.ts";
import { deepEvalData, spec } from "./deepeval-spec.ts";
import { Render } from "./render.tsx";
import { href } from "./state.ts";

export function DeepEval({ d }: { d: ReportDetail }) {
  if (!spec) return <Message>The DeepEval spec does not validate.</Message>;
  return (
    <Render
      spec={spec}
      data={deepEvalData(d, (testId) => href.test(d.run.owner, d.run.repo, testId))}
    />
  );
}
