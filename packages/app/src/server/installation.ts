// The GitHub App installation id: a ref the running source reads, a settings row the
// next boot seeds from. Recording one takes effect without a restart.
import { Context, Effect, Layer, Option, Ref } from "effect";
import { AppConfig } from "./config.ts";
import { ResultStore } from "./result-store.ts";

const SETTING_KEY = "github.installation.id";

export interface Interface {
  /** The live installation id; a stored value beats the env seed from the last boot. */
  readonly current: () => Effect.Effect<Option.Option<string>>;
  /** Ref now, settings row for the next boot. */
  readonly record: (id: string) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("@tag/Installation") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* AppConfig.Service;
    const results = yield* ResultStore.Service;
    const stored = yield* results.getSetting(SETTING_KEY);
    const seed = Option.flatMap(cfg.github, (g) =>
      g.auth._tag === "app" ? g.auth.installationId : Option.none<string>(),
    );
    const ref = yield* Ref.make(Option.isSome(stored) ? stored : seed);
    return Service.of({
      current: () => Ref.get(ref),
      record: (id) =>
        Effect.gen(function* () {
          yield* Ref.set(ref, Option.some(id));
          // The ref already serves this boot; the row is only the seed for the next one,
          // so a store that cannot take the write is a defect, not a typed failure.
          yield* Effect.orDie(results.setSetting(SETTING_KEY, id));
        }),
    });
  }),
);

export * as Installation from "./installation.ts";
