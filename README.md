# Operation Hooks

This is a PostGraphile server plugin which encompasses a collection of
Graphile Engine plugins enabling you to register asynchronous callbacks
before/after operations; uses include:

- validation - check that the incoming arguments are valid
- authorization - check that the user is permitted to take that action
- error - aborting the action for some reason (e.g. insufficient funds)
- notification - inform the user of hints, validation errors, warnings, success, and relevant meta-information (e.g. remaining balance)
- mutation pre-flight - do the preliminary checks of mutation (and throw any errors they may raise) without actually doing the mutation

The callbacks only affect root fields (e.g. fields on the Query, Mutation and
Subscription types) and can:

- exit early (with or without an error) - preventing the operation being executed
- augment the result of the operation (typically in order to add additional information)
- accumulate metadata from before/after the operation
- augment error objects with said metadata

## Usage:

PostGraphile CLI:

```bash
postgraphile --plugins @graphile/operation-hooks
```

PostGraphile library:

```js
const http = require("http"); // Or use Express or whatever
const { postgraphile, makePluginHook } = require("postgraphile");

const pluginHook = makePluginHook([
  require("@graphile/operation-hooks"),
  // Any more PostGraphile server plugins here
]);

const postGraphileMiddleware = postgraphile(DATABASE_URL, SCHEMA_NAME, {
  pluginHook,
  // ...
});

http.createServer(postGraphileMiddleware).listen(5000);
```

If you want to just use the Graphile Engine plugins without the PostGraphile
CLI/library integration that's possible too:

```js
const { createPostGraphileSchema } = require("postgraphile");
const { OperationHooksPlugin } = require("@graphile/operation-hooks");

const schema = createPostGraphileSchema(DATABASE_URL, SCHEMA_NAME, {
  appendPlugins: [OperationHooksPlugin],
});
```

## Messages (notifications)

The messages plugin gives you the ability to associate messages with an
operation. Each message has at least a `level` and `message` field (both are
strings).

Imagine you have the following GraphQL mutation:

```graphql
input SendEmailInput {
  email: String!
  subject: String
  body: String
}
extend type Mutation {
  sendEmail(input: SendEmailInput!): SendEmailPayload
}
```

There's a number of messages you might be interested in sending:

- Validation errors (abort) or warnings (hint, but don't abort):
  - [B] level: 'error', message: 'Invalid email address - must contain at least one @ symbol', path: ['input', 'email']
  - [B] level: 'warning', message: 'Missing subject', path: ['input', 'subject']
  - [E] level: 'error', message: 'The domain for this email is unreachable', path: ['input', 'email']
- Authorization issues:
  - [B] level: 'error', message: 'You must be on a paid plan to send emails'
  - [B] level: 'error', message: 'You are not permitted to email this address', path: ['input', 'email']
- Business requirements:
  - [B] level: 'error', message: 'Insufficient credits to send email', remaining_credits: 2, required_credits: 7
  - [A] level: 'warn', message: 'Your credit is very low', remaining_credits: 9, required_credits: 7
- Notices:
  - [E] level: 'error', message: 'Email sending is not available at this time, please try again later'
  - [B] level: 'notice', message: 'Emails are currently subject to a 3 minute delay due to abuse circumvention; normal service should resume shortly'
  - [A] level: 'notice', message: 'Email sent, remaining credits: 177', remaining_credits: 177
  - [A] level: 'notice', message: 'You have 2 unsent emails in your outbox, please review them'

You'll notice that every message has a `level` string and `message` string,
many also have a `path` string array. All messages can optionally define
additional arbitrary keys. I've also tagged each one `[B]` for "before" (i.e.
this message would be generated before the mutation takes place), `[A]` for
"after" (i.e. this message would be generated during or after the mutation),
and `[E]` for "error" (i.e. this message may be generated if an error
occurred during the mutation itself).

The `level` key is treated specially; if any message generated before the
mutation takes place produces a message with `level='error'` then the
mutation will be aborted with an error. The value in doing this with these
messages is that more than one error (along with associated warnings,
notices, etc) can be raised at the same time, allowing the user to fix
multiple issues at once, resulting in greater user satisfaction.

Messages are accumulated from all the operation hooks that have been added to
the current mutation. One hook producing a message with level=error will not
prevent further hooks from being called (however you can prevent other hooks
from being called by literally throwing an error).

### Exposing messages

Should you wish to surface notifications via GraphQL (rather than just using
the before/after hooks to cause side effects, or possibly raise 'error'
messages), you may use the CLI flag `--operation-messages` or library config
`operationMessages: true`. Doing so will extend the mutation payloads in your
GraphQL schema with a `messages` entry, a list of the messages raised, and
will also expose relevant messages on any GraphQL errors that are throw.

We will define an `OperationMessageInterface` interface that all messages
must conform to:

```graphql
interface OperationMessageInterface {
  level: String!
  message: String!
  path: [String!]
}
```

And extend all mutation payloads to expose them:

```graphql
extend type *MutationPayload {
  messages: [OperationMessageInterface!]
}
```

You can then define whatever concrete message subtypes you need to be
returned. A message type must specify at least the 3 fields defined in the
interface:

- `level` (required, string)
  - e.g. `error`, `warning`, `notification`, `info`, `debug`, ...
  - helps client figure out how to use the message
  - `error` is special - it will abort the transaction on the server (all others are just passed to client)
- `message` (required, string)
  - e.g. `Invalid email`
  - a human-readable error message; fallback for if the client does not understand the rest of the payload
- `path` (optional, string array)
  - e.g. `['input', 'userPatch', 'firstName']`
  - application developer may find other uses for this, so no further validation will be done
  - typically denotes the path to the field that caused the error

⚠️ Please note that messages added to errors do NOT conform to the GraphQL
definitions, so be careful to not expose more information than you intend!

## SQL hooks

Adding this schema plugin to a PostGraphile server will give you the ability
to define mutation operation hooks via PostgreSQL functions.

### SQL operation message identifier

If you provide the CLI flag `--operation-message-identifier my_schema.my_type` (or library `operationMessageIdentifier: "my_schema.my_type"`) then `my_schema.my_type` will be interpretted as an
operation message type; it must have the fields specified above (`level`,
`message` and `path`) but may have additional fields also. If you also pass
`--operation-messages` then this type will have the
`OperationMessageInterface` added, and will be returned with relevant
mutation payloads.

```sql
create type mutation_message (
  level text, -- "error" is special, other values are allowed
  message text, -- human readable message
  path text[] -- e.g. "['input', 'user', 'emails', '3', 'address']"
  /* anything else */
);
```

### SQL function requirements

To be detected as a mutation operation hook, these PostgreSQL functions must
conform the the following requirements:

- Must be defined in an exposed schema (may be lifted in future)
- Must be named according to the SQL Operation Callback Naming Convention (see below)
- Must accept one JSON or JSONB argument, which represents the `args` value
  passed to the mutation (this is JSON/JSONB to allow us to exactly represent
  what PostGraphile received, including representing missing keys/etc)
- Must return either `VOID` or, if `--operation-message-identifier` is
  specified, an array of the specified type
- Must be either `VOLATILE` (default) or `STABLE` (note: can only be `STABLE`
  if it does not return `VOID`)

Recommendation: add an `@omit` smart comment to the function to have it
excluded from the GraphQL schema.

Example:

```sql
create type mutation_message as (
  level text,
  message text,
  path text[],
  code text
);

create function "mutation_createUser_before"(input jsonb)
returns mutation_message[]
as $$
  select array[(
    'error',
    'We''ve not implemented createUser yet; check back later',
    null,
    '501'
  )::mutation_message];
$$ language sql stable;
comment on function "mutation_createUser_before"(jsonb) is E'@omit';
```

(To see this working, run this SQL: `select * from unnest("mutation_createUser_before"('{}'::jsonb));`)

### SQL operation callback naming convention

By default we use the following naming convention:

- start with the GraphQL operation type and an underscore (e.g. `mutation_`)
- followed by the GraphQL mutation name (e.g. `createUser`)
- followed by `_before` or `_after` to indicate when it runs

e.g. `"mutation_createUser_before"`

You can override this using the inflector `pgOperationHookFunctionName`:

```js
const { makeAddInflectorsPlugin } = require("graphile-utils");
module.exports = makeAddInflectorsPlugin(
  {
    pgOperationHookFunctionName: (fieldContext, when) => {
      const {
        scope: { fieldName, isRootQuery, isRootMutation, isRootSubscription },
      } = fieldContext;
      const operationType = isRootQuery
        ? "query"
        : isRootMutation
        ? "mutation"
        : isRootSubscription
        ? "subscription"
        : null;
      if (operationType === null) {
        throw new Error("Invalid fieldContext passed to inflector");
      }
      return `${operationType}_${fieldName}_${when.toLowerCase()}`;
    },
  },
  true
);
```

## Implemeting operation hooks in JavaScript

You can also implement hooks in JavaScript. To do so, you use the
`addOperationHook` API introduced by this plugin. This allows you to write a
single function that handles all root-level queries, mutations and
subscriptions; it's then your responsibility to filter this down to what you
need. (We'll probably make a helper for this in future!) An example follows:

```js
// This plugin logs all attempts at `create` mutations before they're attempted.

const logCreateMutationsHookFromBuild = build => fieldContext => {
  // This function is called for every top-level field registered with
  // Graphile Engine. `fieldContext` is a Context object describing
  // the field that's being hooked; it could be for a query (`isRootQuery`),
  // a mutation (`isRootMutation`), or a subscription
  // (`isRootSubscription`). Return `null` if we don't want to apply this
  // hook to this `fieldContext`.

  // If your hook should only apply to mutations you can do this:
  if (!fieldContext.scope.isRootMutation) return null;

  // You can further limit the functions this hook applies to using
  // `fieldContext`, e.g. `fieldContext.scope.fieldName` would allow you to
  // cherry-pick an individual field, or
  // `fieldContext.scope.isPgCreateMutationField` would tell you that this
  // is a built in CRUD create mutation field:
  // https://github.com/graphile/graphile-engine/blob/7d49f8eeb579d12683f1c0c6579d7b230a2a3008/packages/graphile-build-pg/src/plugins/PgMutationCreatePlugin.js#L253-L254
  if (!fieldContext.scope.isPgCreateMutationField) return null;

  // By this point, we're applying the hook to all create mutations

  // Defining the callback up front makes the code easier to read.
  const tableName = fieldContext.pgIntrospection.name;
  const logAttempt = (input, args, context, resolveInfo) => {
    console.log(
      `A create was attempted on table ${tableName} by ${
        context.jwtClaims && context.jwtClaims.user_id
          ? `user with id ${context.jwtClaims.user_id}`
          : "an anonymous user"
      }`
    );

    // Our function must return either the input, a derivative of it, or
    // `null`. If `null` is returned then the null will be returned (without
    // an error) to the user.

    // Since we wish to continue, we'll just return the input.
    return input;
  };

  // Now we tell the hooks system to use it:
  return {
    // An optional list of callbacks to call before the operation
    before: [
      // You may register more than one callback if you wish, they will be mixed
      // in with the callbacks registered from other plugins and called in the
      // order specified by their priority value.
      {
        // Priority is a number between 0 and 1000; if you're not sure where to
        // put it, then 500 is a great starting point.
        priority: 500,
        // This function (which can be asynchronous) will be called before the
        // operation; it will be passed a value that it must return verbatim;
        // the only other valid return is `null` in which case an error will be thrown.
        callback: logAttempt,
      },
    ],

    // As `before`, except the callback is called after the operation and will
    // be passed the result of the operation; you may returna derivative of the
    // result.
    after: [],

    // As `before`; except the callback is called if an error occurs; it will be
    // passed the error and must return either the error or a derivative of it.
    error: [],
  };
};

// This exports a standard Graphile Engine plugin that adds the operation
// hook.
export default function MyOperationHookPlugin(builder) {
  builder.hook("init", (_, build) => {
    // Register our operation hook (passing it the build object):
    build.addOperationHook(logCreateMutationsHookFromBuild(build));

    // Graphile Engine hooks must always return their input or a derivative of
    // it.
    return _;
  });
}
```

## Caveats

Don't try and use this for things like field masking since there's a lot of
different ways a user can access a field in GraphQL. Field masking should be solved via
`makeWrapResolversPlugin` or similar approach instead.
