// Collections: a saved query under a name, shown on the rail and the collections page.
import { Schema } from "effect";

export const Collection = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  description: Schema.String,
  query: Schema.String,
  createdAt: Schema.String,
});
export interface Collection extends Schema.Schema.Type<typeof Collection> {}
export const CollectionInput = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.optionalKey(Schema.String),
  query: Schema.String,
});
